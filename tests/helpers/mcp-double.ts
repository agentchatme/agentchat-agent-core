import * as http from 'node:http'

// ─── A hosted-MCP double: Streamable HTTP, stateless, JSON or SSE answers ───
//
// Speaks just enough of the protocol for the CLI's client: `initialize`,
// `notifications/initialized` (202), `tools/list` (optionally paged),
// `tools/call` (the handler decides). Records every request it saw.

export interface McpDoubleTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpDoubleOptions {
  tools?: McpDoubleTool[]
  /** Answer every request as an SSE stream instead of a JSON body. */
  sse?: boolean
  /** Split `tools/list` into pages of this size. */
  pageSize?: number
  /** Issue this session id on initialize (the hosted server is stateless and issues none). */
  sessionId?: string
  /** `tools/call` handler; default echoes the arguments as text. */
  call?: (name: string, args: Record<string, unknown>) => { content: unknown[]; isError?: boolean; structuredContent?: unknown }
  /** Answer with this HTTP status and a JSON-RPC error body instead. */
  status?: number
}

export interface McpSeen {
  method: string
  params: Record<string, unknown> | undefined
  headers: http.IncomingHttpHeaders
}

export interface McpDouble {
  readonly apiBase: string
  readonly seen: McpSeen[]
  set(options: Partial<McpDoubleOptions>): void
  close(): Promise<void>
}

export async function startMcpDouble(initial: McpDoubleOptions = {}): Promise<McpDouble> {
  let options: McpDoubleOptions = { ...initial }
  const seen: McpSeen[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/mcp') {
        res.statusCode = 405
        res.end()
        return
      }
      const message = JSON.parse(raw) as { id?: number; method: string; params?: Record<string, unknown> }
      seen.push({ method: message.method, params: message.params, headers: req.headers })
      if (options.status !== undefined) {
        res.statusCode = options.status
        res.setHeader('content-type', 'application/json')
        if (options.status === 429) res.setHeader('retry-after', '7')
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: options.status === 401 ? 'Invalid API key' : 'Too many requests' } }))
        return
      }
      if (message.id === undefined) {
        res.statusCode = 202
        res.end()
        return
      }
      let result: unknown
      if (message.method === 'initialize') {
        if (options.sessionId !== undefined) res.setHeader('mcp-session-id', options.sessionId)
        result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agentchat-double', version: '9.9.9' } }
      } else if (message.method === 'tools/list') {
        const tools = options.tools ?? []
        const size = options.pageSize ?? tools.length
        const start = Number(message.params?.['cursor'] ?? 0)
        const page = tools.slice(start, start + Math.max(1, size))
        result = { tools: page, ...(start + page.length < tools.length ? { nextCursor: String(start + page.length) } : {}) }
      } else if (message.method === 'tools/call') {
        const name = String(message.params?.['name'])
        const args = (message.params?.['arguments'] ?? {}) as Record<string, unknown>
        if (!(options.tools ?? []).some((t) => t.name === name)) {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `Tool ${name} not found` } }))
          return
        }
        result = options.call ? options.call(name, args) : { content: [{ type: 'text', text: `called ${name} ${JSON.stringify(args)}` }] }
      } else {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }))
        return
      }
      const body = JSON.stringify({ jsonrpc: '2.0', id: message.id, result })
      if (options.sse === true) {
        res.setHeader('content-type', 'text/event-stream')
        res.end(`event: message\ndata: ${body}\n\n`)
      } else {
        res.setHeader('content-type', 'application/json')
        res.end(body)
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no address')
  return {
    apiBase: `http://127.0.0.1:${address.port}`,
    seen,
    set: (next) => {
      options = { ...options, ...next }
    },
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
    },
  }
}

/** The hosted tools' shape for the two the CLI aliases (descriptions and schemas abridged). */
export const SEND_TOOL: McpDoubleTool = {
  name: 'agentchat_send_message',
  description: 'Send a text message on AgentChat.\n\nEtiquette: …',
  inputSchema: {
    type: 'object',
    properties: { to: { type: 'string' }, text: { type: 'string' }, reply_to: { type: 'string' } },
    required: ['to', 'text'],
  },
}

export const INBOX_TOOL: McpDoubleTool = {
  name: 'agentchat_inbox',
  description: 'Call this FIRST when woken by AgentChat.',
  inputSchema: { type: 'object', properties: { limit: { type: 'integer' }, timeout_seconds: { type: 'integer' } } },
}
