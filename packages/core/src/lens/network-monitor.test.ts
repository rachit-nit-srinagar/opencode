import { describe, expect, test } from "bun:test"
import {
  assertPublicWebFetchUrl,
  BLOCKED_OPENCODE_HOSTS,
  classifyAgentTurnConnections,
  installLensFetchGuard,
  isBlockedOpencodeHost,
  LENS_HARDENED_ENV,
  LENS_SEARCH_HOST,
  parseHostname,
} from "./hardening"

const PROXY_HOST = "127.0.0.1"
const LITELLM_HOST = "litellm.example.com"
const ALWAYS = [PROXY_HOST, LITELLM_HOST, LENS_SEARCH_HOST]

/** URLs a typical agent turn would attempt: local proxy, LiteLLM, search, plus forbidden phone-home. */
const AGENT_TURN_URLS = [
  `http://${PROXY_HOST}:17385/openai/chat/completions`,
  `https://${LITELLM_HOST}/v1/chat/completions`,
  `https://${LENS_SEARCH_HOST}/html/?q=lens`,
  "https://opencode.ai/zen",
  "https://models.opencode.ai/api.json",
  "https://app.opencode.ai/",
  "https://opncd.ai/share",
  "https://telemetry.opencode.ai/v1/traces",
]

describe("Lens network-monitor (agent turn egress)", () => {
  test("control-plane allowlist plus zero opencode phone-home", () => {
    const log = classifyAgentTurnConnections(AGENT_TURN_URLS, ALWAYS)
    expect(log.reached).toContain(PROXY_HOST)
    expect(log.reached).toContain(LITELLM_HOST)
    expect(log.reached).toContain(LENS_SEARCH_HOST)
    for (const host of BLOCKED_OPENCODE_HOSTS) {
      expect(log.reached.some((item) => item === host || item.endsWith(`.${host}`))).toBe(false)
      expect(log.blocked.some((item) => item === host || item.endsWith(`.${host}`))).toBe(true)
    }
    expect(log.blocked).toContain("telemetry.opencode.ai")
  })

  test("fetch guard blocks opencode hosts during a simulated turn", async () => {
    process.env[LENS_HARDENED_ENV] = "1"
    const reached: string[] = []
    const original = globalThis.fetch
    ;(globalThis as { __lensFetchGuard?: boolean }).__lensFetchGuard = undefined
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const hostname = parseHostname(String(input instanceof Request ? input.url : input)) ?? String(input)
      reached.push(hostname)
      return new Response("ok", { status: 200 })
    }) as typeof fetch

    try {
      installLensFetchGuard(ALWAYS)
      await fetch(`http://${PROXY_HOST}:17385/openai/chat/completions`)
      await fetch(`https://${LENS_SEARCH_HOST}/html/?q=lens`)
      await fetch(`https://${LITELLM_HOST}/v1/chat/completions`)
      for (const host of ["opencode.ai", "models.opencode.ai", "app.opencode.ai", "opncd.ai"]) {
        await expect(fetch(`https://${host}/`)).rejects.toThrow(/Lens egress blocked/)
      }
      expect(reached).toEqual([PROXY_HOST, LENS_SEARCH_HOST, LITELLM_HOST])
      expect(reached.some((host) => isBlockedOpencodeHost(host))).toBe(false)
    } finally {
      globalThis.fetch = original
      ;(globalThis as { __lensFetchGuard?: boolean }).__lensFetchGuard = undefined
    }
  })

  test("webfetch SSRF still blocks token/proxy/metadata during the turn", () => {
    expect(() => assertPublicWebFetchUrl("http://127.0.0.1:17384/token", { tokenPort: 17384 })).toThrow()
    expect(() => assertPublicWebFetchUrl("https://169.254.169.254/latest/meta-data")).toThrow()
    expect(() => assertPublicWebFetchUrl("https://opencode.ai/console")).toThrow()
    expect(assertPublicWebFetchUrl("https://example.com/docs").hostname).toBe("example.com")
  })
})
