import { clientHeadersOf, type IntegrationClient } from '../client-identity.js'
import { hostedMcpUrl } from '../integration/mcp-probe.js'

// ─── An MCP client of the hosted tool server ────────────────────────────────
//
// The hosted tools (`POST /mcp`, Streamable HTTP) are the one place AgentChat's
// tools are defined: names, descriptions, input schemas, safety hints, what a
// call does. A command line that lists or calls them must not carry a second
// copy, so this client speaks only the protocol — `initialize`, `tools/list`,
// `tools/call` — and passes arguments and results through untouched.
//
// Spoken per the Streamable HTTP transport: every message is a POST with
// `Accept: application/json, text/event-stream`; the answer is a JSON body or
// an SSE stream carrying the response; `Mcp-Session-Id` is echoed when the
// server issues one (the hosted server is stateless and does not);
// `MCP-Protocol-Version` carries the negotiated revision after `initialize`.
// The key travels as `Authorization: Bearer`, never in a URL or a log line.

/** The revision this client asks for; the server answers with the one it serves. */
export const MCP_CLIENT_PROTOCOL_VERSION = '2025-06-18'
export const MCP_REQUEST_TIMEOUT_MS = 30_000
/** A tool call may be a held request (`agentchat_wait`, a waiting `agentchat_inbox`): up to ~55 s on the server. */
export const MCP_CALL_TIMEOUT_MS = 90_000

export interface McpTool {
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly inputSchema?: {
    readonly type?: string
    readonly properties?: Record<string, { readonly type?: string; readonly description?: string; readonly default?: unknown } & Record<string, unknown>>
    readonly required?: readonly string[]
  } & Record<string, unknown>
  readonly annotations?: Record<string, unknown>
}

export interface McpContentItem {
  readonly type: string
  readonly text?: string
  readonly [key: string]: unknown
}

export interface McpToolResult {
  readonly content: readonly McpContentItem[]
  readonly structuredContent?: unknown
  readonly isError?: boolean
}

export interface McpServerInfo {
  readonly protocolVersion: string | null
  readonly name: string | null
  readonly version: string | null
}

export class McpError extends Error {
  constructor(
    message: string,
    /** The JSON-RPC error code, when the server sent one. */
    readonly rpcCode: number | null,
    /** The HTTP status, when the failure was an HTTP answer. */
    readonly httpStatus: number | null,
  ) {
    super(message)
    this.name = 'McpError'
  }
}

export interface McpHttpClientOptions {
  /** The API base (`https://api.agentchat.me`); the client posts to its `/mcp`. */
  readonly apiBase: string
  /** Null: an anonymous session (the server shows only the sign-up tools). */
  readonly apiKey: string | null
  /** How this client identifies to the server (headers and `clientInfo`). */
  readonly client: IntegrationClient
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
}

type JsonRpcMessage = { jsonrpc?: string; id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } }

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** Every JSON-RPC message in an answer body: a JSON object or array, or the `data:` events of an SSE stream. */
export function messagesInBody(body: string, contentType: string | null): JsonRpcMessage[] {
  const parse = (text: string): JsonRpcMessage[] => {
    try {
      const value: unknown = JSON.parse(text)
      if (Array.isArray(value)) return value.filter((v) => asRecord(v) !== null) as JsonRpcMessage[]
      return asRecord(value) !== null ? [value as JsonRpcMessage] : []
    } catch {
      return []
    }
  }
  if (contentType !== null && contentType.toLowerCase().includes('text/event-stream')) {
    const messages: JsonRpcMessage[] = []
    // SSE: events separated by a blank line; an event's data lines joined by \n.
    for (const event of body.replace(/\r\n/g, '\n').split('\n\n')) {
      const data = event
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n')
      if (data.length > 0) messages.push(...parse(data))
    }
    return messages
  }
  return parse(body)
}

export class McpHttpClient {
  private readonly url: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private nextId = 1
  private sessionId: string | null = null
  private protocolVersion: string | null = null
  private initialized: Promise<McpServerInfo> | null = null

  constructor(private readonly options: McpHttpClientOptions) {
    this.url = hostedMcpUrl(options.apiBase)
    this.fetchImpl = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? MCP_REQUEST_TIMEOUT_MS
  }

  /** The handshake, once per client (later calls share it). */
  initialize(): Promise<McpServerInfo> {
    if (this.initialized === null) {
      this.initialized = this.handshake().catch((err: unknown) => {
        this.initialized = null
        throw err
      })
    }
    return this.initialized
  }

  /** Every tool the server shows this caller, across pages. */
  async listTools(): Promise<McpTool[]> {
    await this.initialize()
    const tools: McpTool[] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const result = asRecord(await this.request('tools/list', cursor !== undefined ? { cursor } : {})) ?? {}
      const batch = Array.isArray(result['tools']) ? result['tools'] : []
      for (const tool of batch) {
        const record = asRecord(tool)
        if (record !== null && typeof record['name'] === 'string') tools.push(record as unknown as McpTool)
      }
      const next = result['nextCursor']
      if (typeof next !== 'string' || next.length === 0) break
      cursor = next
    }
    return tools
  }

  /** One tool call, arguments as given. A tool-level failure is a result with `isError: true`, not a throw. */
  async callTool(name: string, args: Record<string, unknown>, options: { timeoutMs?: number } = {}): Promise<McpToolResult> {
    await this.initialize()
    const result = asRecord(await this.request('tools/call', { name, arguments: args }, options.timeoutMs ?? MCP_CALL_TIMEOUT_MS))
    if (result === null) throw new McpError('tools/call answered without a result object', null, null)
    const content = Array.isArray(result['content']) ? (result['content'].filter((c) => asRecord(c) !== null) as McpContentItem[]) : []
    return {
      content,
      ...(result['structuredContent'] !== undefined ? { structuredContent: result['structuredContent'] } : {}),
      ...(result['isError'] === true ? { isError: true } : {}),
    }
  }

  private async handshake(): Promise<McpServerInfo> {
    const result = asRecord(
      await this.request('initialize', {
        protocolVersion: MCP_CLIENT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: this.options.client.name ?? this.options.client.runtime, version: this.options.client.version },
      }),
    )
    const protocolVersion = typeof result?.['protocolVersion'] === 'string' ? result['protocolVersion'] : null
    this.protocolVersion = protocolVersion
    await this.notify('notifications/initialized')
    const info = asRecord(result?.['serverInfo'])
    return {
      protocolVersion,
      name: typeof info?.['name'] === 'string' ? info['name'] : null,
      version: typeof info?.['version'] === 'string' ? info['version'] : null,
    }
  }

  private headers(): Record<string, string> {
    return {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(this.options.apiKey !== null ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      ...(this.protocolVersion !== null ? { 'mcp-protocol-version': this.protocolVersion } : {}),
      ...(this.sessionId !== null ? { 'mcp-session-id': this.sessionId } : {}),
      ...clientHeadersOf(this.options.client),
    }
  }

  private async post(body: unknown, timeoutMs: number): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await this.fetchImpl(this.url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: controller.signal, redirect: 'error' })
      const session = res.headers.get('mcp-session-id')
      if (session !== null && session.length > 0) this.sessionId = session
      return res
    } catch (err) {
      if (controller.signal.aborted) throw new McpError(`no answer from ${this.url} within ${Math.round(timeoutMs / 1000)} s`, null, null)
      throw new McpError(`could not reach ${this.url}: ${err instanceof Error ? err.message : String(err)}`, null, null)
    } finally {
      clearTimeout(timer)
    }
  }

  private async notify(method: string): Promise<void> {
    const res = await this.post({ jsonrpc: '2.0', method }, this.timeoutMs)
    await res.arrayBuffer().catch(() => undefined)
    // 202 Accepted is the transport's answer; a stateless server may say 200 or 204.
    if (!res.ok) throw new McpError(`${method}: HTTP ${res.status}`, null, res.status)
  }

  private async request(method: string, params: Record<string, unknown>, timeoutMs = this.timeoutMs): Promise<unknown> {
    const id = this.nextId++
    const res = await this.post({ jsonrpc: '2.0', id, method, params }, timeoutMs)
    const text = await res.text()
    const messages = messagesInBody(text, res.headers.get('content-type'))
    const reply = messages.find((m) => m.id === id) ?? (res.ok ? undefined : messages[0])
    if (reply?.error !== undefined) {
      const message = typeof reply.error.message === 'string' ? reply.error.message : 'error'
      const retry = res.headers.get('retry-after')
      throw new McpError(
        `${method}: ${message}${res.ok ? '' : ` (HTTP ${res.status}${retry !== null ? `, retry after ${retry} s` : ''})`}`,
        typeof reply.error.code === 'number' ? reply.error.code : null,
        res.ok ? null : res.status,
      )
    }
    if (!res.ok) {
      throw new McpError(
        `${method}: HTTP ${res.status}${res.status === 401 ? ' — the key does not authenticate' : ''}`,
        null,
        res.status,
      )
    }
    if (reply === undefined || !('result' in reply)) throw new McpError(`${method}: no response in the answer`, null, res.status)
    return reply.result
  }
}
