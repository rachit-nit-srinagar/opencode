import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Session } from "@/session/session"
import { SessionRevert } from "../../src/session/revert"
import { Snapshot } from "../../src/snapshot"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Undoing a rewind must not overwrite files the user changed while the chat was rewound (Lens only).

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Session.node, SessionRevert.node, Snapshot.node, SessionProjector.node, CrossSpawnSpawner.node]),
  ),
)

const HARDENED = "OPENCODE_LENS_HARDENED"
const initial = process.env[HARDENED]
afterEach(() => {
  if (initial === undefined) delete process.env[HARDENED]
  else process.env[HARDENED] = initial
})

const read = (file: string) => Effect.promise(() => fs.readFile(file, "utf-8"))
const write = (file: string, text: string) => Effect.promise(() => fs.writeFile(file, text))
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

/** One agent turn that writes `next` to `file`, recorded the way the engine records it (step parts plus a patch). */
const turn = Effect.fn("test.lensTurn")(function* (sid: SessionID, dir: string, file: string, next: string) {
  const session = yield* Session.Service
  const snapshot = yield* Snapshot.Service
  const model = { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") }
  const u = yield* session.updateMessage({ id: MessageID.ascending(), role: "user" as const, sessionID: sid, agent: "default", model, time: { created: Date.now() } })
  yield* session.updatePart({ id: PartID.ascending(), messageID: u.id, sessionID: sid, type: "text" as const, text: `${file}:${next}` })
  const a = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "assistant" as const,
    sessionID: sid,
    mode: "default",
    agent: "default",
    path: { cwd: dir, root: dir },
    cost: 0,
    tokens,
    modelID: model.modelID,
    providerID: model.providerID,
    parentID: u.id,
    time: { created: Date.now() },
    finish: "end_turn",
  })
  const before = yield* snapshot.track()
  if (!before) throw new Error("expected snapshot")
  yield* write(path.join(dir, file), next)
  const patch = yield* snapshot.patch(before)
  yield* session.updatePart({ id: PartID.ascending(), messageID: a.id, sessionID: sid, type: "step-start", snapshot: before })
  yield* session.updatePart({ id: PartID.ascending(), messageID: a.id, sessionID: sid, type: "patch", hash: patch.hash, files: patch.files })
  return u.id
})

const scenario = (dir: string) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const revert = yield* SessionRevert.Service
    yield* write(path.join(dir, "agent.txt"), "a0")
    yield* write(path.join(dir, "notes.txt"), "n0")
    const sid = (yield* session.create({})).id
    const first = yield* turn(sid, dir, "agent.txt", "a1")
    yield* revert.revert({ sessionID: sid, messageID: first })
    expect(yield* read(path.join(dir, "agent.txt"))).toBe("a0")
    // The user edits a file the agent never touched while the chat is rewound.
    yield* write(path.join(dir, "notes.txt"), "n1")
    yield* revert.unrevert({ sessionID: sid })
    expect(yield* read(path.join(dir, "agent.txt"))).toBe("a1")
    return yield* read(path.join(dir, "notes.txt"))
  })

describe("lens: undo rewind restores only the rewound files", () => {
  it.live(
    "hardened: keeps the user's edit made while rewound",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          process.env[HARDENED] = "1"
          expect(yield* scenario(dir)).toBe("n1")
        }),
      { git: true },
    ),
  )

  it.live(
    "hardened: rewinding again while rewound keeps the user's edit",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          process.env[HARDENED] = "1"
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          yield* write(path.join(dir, "a.txt"), "a0")
          yield* write(path.join(dir, "b.txt"), "b0")
          yield* write(path.join(dir, "notes.txt"), "n0")
          const sid = (yield* session.create({})).id
          const first = yield* turn(sid, dir, "a.txt", "a1")
          const second = yield* turn(sid, dir, "b.txt", "b1")
          yield* revert.revert({ sessionID: sid, messageID: second })
          yield* write(path.join(dir, "notes.txt"), "n1")
          yield* revert.revert({ sessionID: sid, messageID: first })
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a0")
          expect(yield* read(path.join(dir, "b.txt"))).toBe("b0")
          expect(yield* read(path.join(dir, "notes.txt"))).toBe("n1")
          yield* revert.unrevert({ sessionID: sid })
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a1")
          expect(yield* read(path.join(dir, "b.txt"))).toBe("b1")
          expect(yield* read(path.join(dir, "notes.txt"))).toBe("n1")
        }),
      { git: true },
    ),
  )

  it.live(
    "unhardened: upstream restores the whole snapshot",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          delete process.env[HARDENED]
          expect(yield* scenario(dir)).toBe("n0")
        }),
      { git: true },
    ),
  )
})
