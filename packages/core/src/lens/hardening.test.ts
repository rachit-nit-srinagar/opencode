import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  assertPublicWebFetchUrl,
  checkBashCommand,
  checkWorkspacePath,
  extraEgressHosts,
  isBlockedOpencodeHost,
  isHostAllowed,
  LENS_EGRESS_EXTRA_FILE_ENV,
  parseDuckDuckGoHtml,
} from "./hardening"

describe("Lens hardening", () => {
  test("blocks opencode control-plane hosts", () => {
    expect(isBlockedOpencodeHost("models.opencode.ai")).toBe(true)
    expect(isBlockedOpencodeHost("app.opencode.ai")).toBe(true)
    expect(isBlockedOpencodeHost("html.duckduckgo.com")).toBe(false)
  })

  test("SSRF-guards webfetch", () => {
    expect(() => assertPublicWebFetchUrl("http://127.0.0.1:17384/token", { tokenPort: 17384 })).toThrow()
    expect(() => assertPublicWebFetchUrl("https://169.254.169.254/latest/meta-data")).toThrow()
    expect(() => assertPublicWebFetchUrl("https://opencode.ai/console")).toThrow()
    expect(assertPublicWebFetchUrl("https://example.com/docs").hostname).toBe("example.com")
  })

  test("denies destructive bash", () => {
    expect(checkBashCommand("rm -rf /")).toBeTruthy()
    expect(checkBashCommand("ls")).toBeUndefined()
  })

  test("scopes paths to workspace", () => {
    expect(checkWorkspacePath("/tmp/proj/src/a.ts", "/tmp/proj")).toBeUndefined()
    expect(checkWorkspacePath("/etc/passwd", "/tmp/proj")).toBeTruthy()
  })

  test("hard-blocks opencode hosts even if extra egress is set", () => {
    expect(isHostAllowed("opencode.ai", ["opencode.ai"])).toBe(false)
    expect(isHostAllowed("html.duckduckgo.com", ["html.duckduckgo.com"])).toBe(true)
  })

  test("reads consented hosts from extra egress file", () => {
    const dir = mkdtempSync(join(tmpdir(), "lens-egress-"))
    const file = join(dir, "extra.txt")
    writeFileSync(file, "mcp.example.com\n")
    const previous = process.env[LENS_EGRESS_EXTRA_FILE_ENV]
    process.env[LENS_EGRESS_EXTRA_FILE_ENV] = file
    try {
      expect(extraEgressHosts()).toContain("mcp.example.com")
      expect(isHostAllowed("mcp.example.com", ["127.0.0.1"])).toBe(true)
    } finally {
      if (previous === undefined) {
        delete process.env[LENS_EGRESS_EXTRA_FILE_ENV]
      } else {
        process.env[LENS_EGRESS_EXTRA_FILE_ENV] = previous
      }
    }
  })

  test("parses DuckDuckGo html", () => {
    const html = `<a class="result__a" href="https://example.com">Example</a>`
    expect(parseDuckDuckGoHtml(html)).toContain("Example")
  })
})
