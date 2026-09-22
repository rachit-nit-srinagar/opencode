export * as Ripgrep from "./ripgrep"

import fs from "node:fs/promises"
import path from "node:path"
import { Context, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Entry, Match } from "@opencode-ai/schema/filesystem"
import { makeGlobalNode } from "./effect/app-node"
import { AppProcess, collectStream, waitForAbort } from "./process"
import { NonNegativeInt, PositiveInt, RelativePath } from "./schema"
import { RipgrepBinary } from "./ripgrep/binary"
import { Glob } from "./util/glob"

/**
 * Small core-owned ripgrep execution adapter. It deliberately exposes raw
 * process-oriented rows, not model text or permission behavior. Search maps
 * these rows into filesystem results; leaf tools own
 * presentation and permission prompts.
 */

const ERROR_BYTES = 8 * 1024
const MAX_RECORD_BYTES = 64 * 1024
const MAX_SUBMATCHES = 100

const RawMatch = Schema.Struct({
  type: Schema.Literal("match"),
  data: Schema.Struct({
    path: Schema.Struct({ text: Schema.String }),
    lines: Schema.Struct({ text: Schema.String }),
    line_number: PositiveInt,
    absolute_offset: NonNegativeInt,
    submatches: Schema.Array(
      Schema.Struct({
        match: Schema.Struct({ text: Schema.String }),
        start: NonNegativeInt,
        end: NonNegativeInt,
      }),
    ),
  }),
})

type RawMatchData = (typeof RawMatch.Type)["data"]

export class Error extends Schema.TaggedErrorClass<Error>()("Ripgrep.Error", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class InvalidPatternError extends Schema.TaggedErrorClass<InvalidPatternError>()("Ripgrep.InvalidPatternError", {
  pattern: Schema.String,
  message: Schema.String,
}) {}

export interface FindInput {
  readonly cwd: string
  readonly pattern: string
  readonly limit: number
  readonly hidden?: boolean
  readonly follow?: boolean
  readonly signal?: AbortSignal
  readonly onEntry?: (entry: Entry) => Effect.Effect<void>
}

export interface GlobInput {
  readonly cwd: string
  readonly pattern: string
  readonly limit: number
  readonly hidden?: boolean
  readonly follow?: boolean
  readonly signal?: AbortSignal
}

export interface GrepInput {
  readonly cwd: string
  readonly pattern: string
  readonly file?: string
  readonly include?: string
  readonly limit: number
  readonly signal?: AbortSignal
}

export interface Interface {
  readonly find: (input: FindInput) => Effect.Effect<readonly Entry[], Error>
  readonly glob: (input: GlobInput) => Effect.Effect<readonly Entry[], Error>
  readonly grep: (input: GrepInput) => Effect.Effect<readonly Match[], Error | InvalidPatternError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Ripgrep") {}

const failure = (message: string, cause?: unknown) => new Error({ message, cause })

const isInvalidPattern = (stderr: string) =>
  stderr.includes("regex parse error") || stderr.includes("error parsing regex")

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const process = yield* AppProcess.Service
    const binary = yield* RipgrepBinary.Service

    const run = <A>(input: {
      readonly cwd: string
      readonly args: string[]
      readonly limit: number
      readonly signal?: AbortSignal
      readonly parse: (line: string) => Effect.Effect<A | undefined, Error>
      readonly pattern?: string
      readonly onItem?: (item: A) => Effect.Effect<void>
    }) => {
      const program = Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* process.spawn(
            ChildProcess.make(yield* binary.filepath, input.args, { cwd: input.cwd, extendEnv: true, stdin: "ignore" }),
          )
          const stderrFiber = yield* collectStream(handle.stderr, ERROR_BYTES).pipe(
            Effect.map((output) => output.buffer.toString("utf8")),
            Effect.forkScoped,
          )
          let observed = 0
          const rows = yield* Stream.decodeText(handle.stdout).pipe(
            Stream.splitLines,
            Stream.filter((line) => line.length > 0),
            Stream.mapEffect(input.parse),
            Stream.filter((row): row is A => row !== undefined),
            Stream.tap((row) => {
              if (!input.onItem || observed++ >= input.limit) return Effect.void
              return input.onItem(row)
            }),
            Stream.take(input.limit + 1),
            Stream.runCollect,
            Effect.map((chunk) => [...chunk]),
          )
          const truncated = rows.length > input.limit
          if (truncated) return { items: rows.slice(0, input.limit), truncated, partial: false }

          const code = yield* handle.exitCode
          const stderr = yield* Fiber.join(stderrFiber)
          if (input.pattern && code === 2 && isInvalidPattern(stderr)) {
            return yield* new InvalidPatternError({ pattern: input.pattern, message: stderr.trim() })
          }
          if (code !== 0 && code !== 1 && code !== 2) {
            return yield* failure(stderr.trim() || `ripgrep failed with code ${code}`)
          }
          return { items: code === 1 ? [] : rows, truncated: false, partial: code === 2 }
        }),
      )
      const abortable = input.signal ? program.pipe(Effect.raceFirst(waitForAbort(input.signal))) : program
      return abortable.pipe(
        Effect.mapError((cause) =>
          cause instanceof Error || cause instanceof InvalidPatternError
            ? cause
            : failure("ripgrep execution failed", cause),
        ),
      )
    }

    return Service.of({
      glob: (input) =>
        run<string>({
          cwd: input.cwd,
          limit: input.limit,
          signal: input.signal,
          args: [
            "--no-config",
            "--files",
            ...(input.hidden ? ["--hidden"] : []),
            ...(input.follow ? ["--follow"] : []),
            `--glob=${input.pattern}`,
            "--glob=!**/.git/**",
            ".",
          ],
          parse: (line) =>
            Effect.succeed(
              line
                .replace(/^(?:\.[\\/])+/u, "")
                .replace(/^[\\/]+/u, "")
                .replaceAll("\\", "/"),
            ),
        }).pipe(
          Effect.map((result) =>
            result.items.map((relative) =>
              Entry.make({
                path: RelativePath.make(relative),
                type: "file",
              }),
            ),
          ),
          Effect.catch((cause) =>
            cause instanceof InvalidPatternError
              ? Effect.fail(failure(cause.message, cause))
              : fallbackGlob(input).pipe(Effect.mapError((fallbackCause) => toRipgrepError(cause, fallbackCause))),
          ),
        ),
      find: (input) =>
        run<Entry>({
          cwd: input.cwd,
          limit: input.limit,
          signal: input.signal,
          args: [
            "--no-config",
            "--files",
            ...(input.hidden ? ["--hidden"] : []),
            ...(input.follow ? ["--follow"] : []),
            ...(input.pattern === "*" ? [] : [`--glob=${input.pattern}`]),
            "--glob=!**/.git/**",
            ".",
          ],
          parse: (line) => {
            const relative = line
              .replace(/^(?:\.[\\/])+/u, "")
              .replace(/^[\\/]+/u, "")
              .replaceAll("\\", "/")
            return Effect.succeed(
              Entry.make({
                path: RelativePath.make(relative),
                type: "file",
              }),
            )
          },
          onItem: input.onEntry,
        }).pipe(
          Effect.map((result) => result.items),
          Effect.catch((cause) =>
            cause instanceof InvalidPatternError
              ? Effect.fail(failure(cause.message, cause))
              : fallbackGlob({ ...input, pattern: input.pattern === "*" ? "**/*" : input.pattern }).pipe(
                  Effect.mapError((fallbackCause) => toRipgrepError(cause, fallbackCause)),
                ),
          ),
        ),
      grep: (input) =>
        run<RawMatchData>({
          ...input,
          args: [
            "--no-config",
            "--json",
            "--hidden",
            "--no-messages",
            ...(input.include ? [`--glob=${input.include}`] : []),
            "--glob=!**/.git/**",
            "--",
            input.pattern,
            input.file ?? ".",
          ],
          parse: (line) =>
            (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES
              ? Effect.fail(failure(`Ripgrep JSON record exceeded ${MAX_RECORD_BYTES} bytes`))
              : Effect.try({
                  try: () => JSON.parse(line) as unknown,
                  catch: (cause) => failure("Invalid ripgrep JSON output", cause),
                })
            ).pipe(
              Effect.flatMap((json) => {
                if (!json || typeof json !== "object" || !("type" in json) || json.type !== "match")
                  return Effect.succeed(undefined)
                return Schema.decodeUnknownEffect(RawMatch)(json).pipe(
                  Effect.map((match) => ({
                    ...match.data,
                    path: { text: match.data.path.text.replace(/^\.[\\/]/, "") },
                    submatches: match.data.submatches.slice(0, MAX_SUBMATCHES),
                  })),
                  Effect.mapError((cause) => failure("Invalid ripgrep match output", cause)),
                )
              }),
            ),
        }).pipe(
          Effect.map((result) =>
            result.items.map((match) => {
              const relative = match.path.text
                .replace(/^(?:\.[\\/])+/u, "")
                .replace(/^[\\/]+/u, "")
                .replaceAll("\\", "/")
              return Match.make({
                entry: Entry.make({
                  path: RelativePath.make(relative),
                  type: "file",
                }),
                line: match.line_number,
                offset: match.absolute_offset,
                text:
                  match.lines.text.length > 2_000
                    ? match.lines.text.slice(0, 2_000).replace(/[\uD800-\uDBFF]$/, "") + "..."
                    : match.lines.text,
                submatches: match.submatches.map((submatch) => ({
                  text: submatch.match.text,
                  start: submatch.start,
                  end: submatch.end,
                })),
              })
            }),
          ),
          Effect.catch((cause): Effect.Effect<readonly Match[], Error | InvalidPatternError> =>
            cause instanceof InvalidPatternError
              ? Effect.fail(cause)
              : fallbackGrep(input).pipe(Effect.mapError((fallbackCause) => toRipgrepError(cause, fallbackCause))),
          ),
        ),
    })
  }),
)

function toRipgrepError(cause: unknown, fallbackCause?: unknown) {
  if (cause instanceof Error) return cause
  return failure("ripgrep execution failed", fallbackCause ?? cause)
}

function ignoredSearchPath(relative: string): boolean {
  return relative.replace(/\\/g, "/").split("/").some((part) => part === ".git" || part === "node_modules")
}

function fallbackGlob(input: GlobInput | FindInput): Effect.Effect<readonly Entry[], Error> {
  const pattern = !input.pattern || input.pattern === "*" ? "**/*" : input.pattern
  return Effect.tryPromise({
    try: async () => {
      const files = await Glob.scan(pattern, { cwd: input.cwd, dot: input.hidden ?? true })
      return files
        .map((file) => file.replace(/\\/g, "/").replace(/^\.\//, ""))
        .filter((file) => file && !ignoredSearchPath(file))
        .slice(0, input.limit)
        .map((relative) =>
          Entry.make({
            path: RelativePath.make(relative),
            type: "file",
          }),
        )
    },
    catch: (cause) => failure("File search fallback failed", cause),
  })
}

function fallbackGrep(input: GrepInput): Effect.Effect<readonly Match[], Error | InvalidPatternError> {
  let regex: RegExp
  try {
    regex = new RegExp(input.pattern)
  } catch (cause) {
    return Effect.fail(new InvalidPatternError({ pattern: input.pattern, message: String(cause) }))
  }
  const include = input.include
    ? input.include.includes("/") || input.include.startsWith("**")
      ? input.include
      : `**/${input.include}`
    : "**/*"
  return Effect.tryPromise({
    try: async () => {
      const files = (await Glob.scan(include, { cwd: input.cwd, dot: true }))
        .map((file) => file.replace(/\\/g, "/").replace(/^\.\//, ""))
        .filter((file) => file && !ignoredSearchPath(file))
        .slice(0, 400)
      const matches: Match[] = []
      for (const relative of files) {
        if (matches.length >= input.limit) break
        const absolute = path.join(input.cwd, relative)
        let text: string
        try {
          const stat = await fs.stat(absolute)
          if (!stat.isFile() || stat.size > 1_000_000) continue
          const bytes = await fs.readFile(absolute)
          if (bytes.includes(0)) continue
          text = bytes.toString("utf8")
        } catch {
          continue
        }
        const lines = text.split("\n")
        for (let index = 0; index < lines.length; index++) {
          if (matches.length >= input.limit) break
          regex.lastIndex = 0
          const hit = regex.exec(lines[index] ?? "")
          if (!hit) continue
          const line = lines[index] ?? ""
          matches.push(
            Match.make({
              entry: Entry.make({
                path: RelativePath.make(relative),
                type: "file",
              }),
              line: index + 1,
              offset: 0,
              text: line.length > 2_000 ? line.slice(0, 2_000).replace(/[\uD800-\uDBFF]$/, "") + "..." : line,
              submatches: [
                {
                  text: hit[0] ?? "",
                  start: hit.index,
                  end: hit.index + (hit[0]?.length ?? 0),
                },
              ],
            }),
          )
        }
      }
      return matches
    },
    catch: (cause) => failure("Content search fallback failed", cause),
  })
}

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [RipgrepBinary.node, AppProcess.node] })
