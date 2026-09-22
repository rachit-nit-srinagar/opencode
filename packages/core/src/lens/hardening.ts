import { existsSync, readFileSync } from "node:fs"

export const LENS_HARDENED_ENV = "OPENCODE_LENS_HARDENED"
export const LENS_ALLOW_NPM_ENV = "OPENCODE_ALLOW_NPM_INSTALL"
export const LENS_ALLOW_USER_PLUGINS_ENV = "OPENCODE_LENS_ALLOW_USER_PLUGINS"
export const LENS_EGRESS_EXTRA_ENV = "OPENCODE_LENS_EGRESS_EXTRA"
export const LENS_EGRESS_EXTRA_FILE_ENV = "OPENCODE_LENS_EGRESS_EXTRA_FILE"
export const LENS_SEARCH_HOST = "html.duckduckgo.com"

export const BLOCKED_OPENCODE_HOSTS = [
  "opencode.ai",
  "opncd.ai",
  "models.opencode.ai",
  "app.opencode.ai",
] as const

const BLOCKED_HOST_SUFFIXES = BLOCKED_OPENCODE_HOSTS

const DESTRUCTIVE_BASH = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\b/,
  /\brm\s+-rf\s+\//,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\bchmod\s+(-R\s+)?777\b/,
  /\bchown\s+-R\s+/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bsudo\b/,
  /\bsu\s/,
  /\bcurl\b.+\|\s*(ba)?sh\b/,
  /\bwget\b.+\|\s*(ba)?sh\b/,
  /\bnc\s+-l\b/,
  /\bncat\s+-l\b/,
  /\biptables\b/,
  /\bpfctl\b/,
]

export function isLensHardened(): boolean {
  const value = process.env[LENS_HARDENED_ENV]?.toLowerCase()
  return value === "1" || value === "true"
}

export function isNpmInstallAllowed(): boolean {
  if (!isLensHardened()) return true
  const value = process.env[LENS_ALLOW_NPM_ENV]?.toLowerCase()
  return value === "1" || value === "true"
}

export function areUserPluginsAllowed(): boolean {
  if (!isLensHardened()) return true
  const value = process.env[LENS_ALLOW_USER_PLUGINS_ENV]?.toLowerCase()
  return value === "1" || value === "true"
}

export function isBlockedOpencodeHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "")
  return BLOCKED_HOST_SUFFIXES.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))
}

export function isPrivateOrLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\[|\]/g, "")
  if (host === "localhost" || host === "metadata.google.internal") return true
  if (host === "::1" || host === "0.0.0.0" || host === "::") return true
  if (host.endsWith(".local")) return true
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])]
    if (a === 127 || a === 0 || a === 10) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
  }
  if (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true
  return false
}

export function parseHostname(input: string): string | undefined {
  try {
    const url = input.includes("://") ? new URL(input) : new URL(`https://${input}`)
    return url.hostname
  } catch {
    return undefined
  }
}

export interface WebFetchGuardOptions {
  readonly tokenPort?: number
  readonly proxyPort?: number
  readonly opencodePort?: number
}

export function assertPublicWebFetchUrl(raw: string, options: WebFetchGuardOptions = {}): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error("Invalid URL")
  }
  if (url.protocol !== "https:") {
    throw new Error("URL must use https://")
  }
  if (isBlockedOpencodeHost(url.hostname)) {
    throw new Error("Fetching opencode control-plane hosts is not allowed")
  }
  if (isPrivateOrLoopbackHostname(url.hostname)) {
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80
    const localPorts = [options.tokenPort, options.proxyPort, options.opencodePort].filter(
      (value): value is number => typeof value === "number",
    )
    if (localPorts.includes(port) || url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      throw new Error("Fetching local Lens services is not allowed")
    }
    throw new Error("Fetching private or loopback addresses is not allowed")
  }
  return url
}

export function checkBashCommand(command: string): string | undefined {
  const trimmed = command.trim()
  if (!trimmed) return "Empty command is not allowed"
  for (const pattern of DESTRUCTIVE_BASH) {
    if (pattern.test(trimmed)) {
      return `Destructive or privileged command is blocked: ${trimmed.slice(0, 120)}`
    }
  }
  return undefined
}

export function checkWorkspacePath(target: string, workspaceRoot: string): string | undefined {
  const normalizedTarget = target.replace(/\\/g, "/")
  const normalizedRoot = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "")
  if (normalizedTarget === normalizedRoot) return undefined
  if (normalizedTarget.startsWith(`${normalizedRoot}/`)) return undefined
  return `Path is outside the workspace: ${target}`
}

export function extraEgressHosts(): string[] {
  const hosts: string[] = []
  const raw = process.env[LENS_EGRESS_EXTRA_ENV]
  if (raw) {
    hosts.push(
      ...raw
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    )
  }
  const file = process.env[LENS_EGRESS_EXTRA_FILE_ENV]
  if (file && existsSync(file)) {
    try {
      hosts.push(
        ...readFileSync(file, "utf8")
          .split(/[\s,]+/)
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean),
      )
    } catch {
      // ignore unreadable consent files
    }
  }
  return [...new Set(hosts)]
}

export function isHostAllowed(hostname: string, always: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "")
  if (isBlockedOpencodeHost(host)) return false
  const allowed = [...always, ...extraEgressHosts()]
  return allowed.some((entry) => host === entry || host.endsWith(`.${entry}`))
}

export interface AgentTurnConnectionLog {
  attempted: string[]
  reached: string[]
  blocked: string[]
}

/** Classify URLs an agent turn would open; blocked opencode hosts never appear in `reached`. */
export function classifyAgentTurnConnections(
  urls: readonly string[],
  alwaysAllowed: readonly string[],
): AgentTurnConnectionLog {
  const attempted: string[] = []
  const reached: string[] = []
  const blocked: string[] = []
  for (const raw of urls) {
    const hostname = parseHostname(raw)
    if (!hostname) continue
    attempted.push(hostname)
    if (isHostAllowed(hostname, alwaysAllowed)) {
      reached.push(hostname)
    } else {
      blocked.push(hostname)
    }
  }
  return { attempted, reached, blocked }
}

export function installLensFetchGuard(alwaysAllowedHosts: readonly string[]): void {
  if (!isLensHardened()) return
  const original = globalThis.fetch
  if (typeof original !== "function") return
  if ((globalThis as { __lensFetchGuard?: boolean }).__lensFetchGuard) return
  ;(globalThis as { __lensFetchGuard?: boolean }).__lensFetchGuard = true

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input instanceof Request
            ? input.url
            : String(input)
    const hostname = parseHostname(url)
    if (hostname && !isHostAllowed(hostname, alwaysAllowedHosts)) {
      throw new Error(`Lens egress blocked: ${hostname}`)
    }
    return original(input as never, init)
  }) as typeof fetch
}

export function duckDuckGoSearchUrl(query: string): string {
  const url = new URL(`https://${LENS_SEARCH_HOST}/html/`)
  url.searchParams.set("q", query)
  return url.toString()
}

export function parseDuckDuckGoHtml(html: string): string {
  const results: string[] = []
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = linkRe.exec(html)) && results.length < 8) {
    const href = decodeHtml(match[1] ?? "")
    const title = decodeHtml(stripTags(match[2] ?? "")).trim()
    if (!title) continue
    results.push(`${results.length + 1}. ${title}\n   ${href}`)
  }
  if (!results.length) return "No search results found. Please try a different query."
  return results.join("\n")
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, "")
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}
