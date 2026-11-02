import { CODING_AGENTS_CLIENT_HEADERS } from '../client-identity.js'

// ─── Is the hosted tool server reachable with this key? ─────────────────────
//
// `status` and `doctor` send ONE MCP `initialize` over Streamable HTTP with
// the bearer key — the same first request a runtime makes on connect — and
// read the answer. A `401` means the key does not authenticate; a transport
// error means the endpoint is not reachable from here. Nothing else is called.

export const HOSTED_MCP_PATH = '/mcp'

/** The MCP protocol revision this probe speaks; the server answers with the one it serves. */
const MCP_PROTOCOL_VERSION = '2025-06-18'

export function hostedMcpUrl(apiBase: string): string {
  return `${apiBase.replace(/\/+$/, '')}${HOSTED_MCP_PATH}`
}

export interface McpProbeResult {
  readonly ok: boolean
  readonly status?: number
  readonly serverName?: string
  readonly serverVersion?: string
  readonly protocolVersion?: string
  readonly error?: string
}

export async function probeHostedMcp(params: {
  apiKey: string
  apiBase: string
  clientName: string
  clientVersion: string
  timeoutMs?: number
  fetch?: typeof fetch
}): Promise<McpProbeResult> {
  const fetchImpl = params.fetch ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? 10_000)
  try {
    const res = await fetchImpl(hostedMcpUrl(params.apiBase), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${params.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...CODING_AGENTS_CLIENT_HEADERS,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: params.clientName, version: params.clientVersion },
        },
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error:
          res.status === 401
            ? 'the key does not authenticate against the hosted MCP server'
            : `HTTP ${res.status}`,
      }
    }
    const result = readInitializeResult(await res.text())
    if (!result) return { ok: false, status: res.status, error: 'no initialize result in the answer' }
    const serverInfo = (result.serverInfo ?? {}) as Record<string, unknown>
    return {
      ok: true,
      status: res.status,
      ...(typeof serverInfo.name === 'string' ? { serverName: serverInfo.name } : {}),
      ...(typeof serverInfo.version === 'string' ? { serverVersion: serverInfo.version } : {}),
      ...(typeof result.protocolVersion === 'string' ? { protocolVersion: result.protocolVersion } : {}),
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}

/** The initialize result from a JSON body or an SSE body (`data: {...}` lines). */
function readInitializeResult(text: string): Record<string, unknown> | null {
  const candidates: string[] = []
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) candidates.push(trimmed)
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('data:')) candidates.push(line.slice(5).trim())
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>
      const result = parsed.result
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        return result as Record<string, unknown>
      }
    } catch {
      // not JSON — try the next candidate
    }
  }
  return null
}
