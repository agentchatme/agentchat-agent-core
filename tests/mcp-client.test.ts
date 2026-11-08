import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { McpHttpClient, McpError, messagesInBody } from '../src/mcp/client.js'
import { INBOX_TOOL, SEND_TOOL, startMcpDouble, type McpDouble } from './helpers/mcp-double.js'

// ─── The MCP client: protocol only, arguments and results passed through ────

const KEY = 'ac_live_' + 'm'.repeat(40)
const CLIENT = { runtime: 'generic' as const, version: '0.0.0-test', name: 'agentchat-cli' }
let mcp: McpDouble

beforeEach(async () => {
  mcp = await startMcpDouble({ tools: [SEND_TOOL, INBOX_TOOL] })
})
afterEach(async () => mcp.close())

const client = (apiKey: string | null = KEY) => new McpHttpClient({ apiBase: mcp.apiBase, apiKey, client: CLIENT })

describe('McpHttpClient', () => {
  it('initialize → initialized → tools/list, with the bearer key, the negotiated version and the client identity', async () => {
    const tools = await client().listTools()
    expect(tools.map((t) => t.name)).toEqual(['agentchat_send_message', 'agentchat_inbox'])
    expect(mcp.seen.map((s) => s.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
    const [init, , list] = mcp.seen
    expect(init?.params).toMatchObject({ protocolVersion: '2025-06-18', clientInfo: { name: 'agentchat-cli', version: '0.0.0-test' } })
    expect(init?.headers['authorization']).toBe(`Bearer ${KEY}`)
    expect(init?.headers['accept']).toBe('application/json, text/event-stream')
    expect(init?.headers['mcp-protocol-version']).toBeUndefined()
    expect(list?.headers['mcp-protocol-version']).toBe('2025-06-18')
    expect(list?.headers['x-agentchat-client']).toBe('agentchat-cli')
  })

  it('one handshake per client; a session id the server issues is echoed', async () => {
    mcp.set({ sessionId: 'sess-123' })
    const c = client()
    await c.listTools()
    await c.callTool('agentchat_inbox', {})
    expect(mcp.seen.filter((s) => s.method === 'initialize')).toHaveLength(1)
    expect(mcp.seen[mcp.seen.length - 1]?.headers['mcp-session-id']).toBe('sess-123')
  })

  it('an anonymous session sends no Authorization header', async () => {
    await client(null).listTools()
    expect(mcp.seen.every((s) => s.headers['authorization'] === undefined)).toBe(true)
  })

  it('reads SSE answers and follows tools/list pages', async () => {
    mcp.set({ sse: true, pageSize: 1 })
    const tools = await client().listTools()
    expect(tools.map((t) => t.name)).toEqual(['agentchat_send_message', 'agentchat_inbox'])
    expect(mcp.seen.filter((s) => s.method === 'tools/list').map((s) => s.params?.['cursor'])).toEqual([undefined, '1'])
  })

  it('tools/call passes the arguments through untouched; a tool error is a result, a protocol error throws', async () => {
    const result = await client().callTool('agentchat_send_message', { to: '@peer', text: 'hi', extra: [1, { a: true }] })
    expect(result.content[0]).toEqual({ type: 'text', text: 'called agentchat_send_message {"to":"@peer","text":"hi","extra":[1,{"a":true}]}' })
    expect(mcp.seen[mcp.seen.length - 1]?.params).toEqual({ name: 'agentchat_send_message', arguments: { to: '@peer', text: 'hi', extra: [1, { a: true }] } })

    mcp.set({ call: () => ({ content: [{ type: 'text', text: 'AWAITING_REPLY' }], isError: true }) })
    expect(await client().callTool('agentchat_send_message', { to: '@p', text: 'x' })).toMatchObject({ isError: true })

    await expect(client().callTool('agentchat_no_such_tool', {})).rejects.toThrow(/not found/)
  })

  it('HTTP failures carry the status: 401 says the key does not authenticate; 429 the retry hint', async () => {
    mcp.set({ status: 401 })
    const refused = await client().listTools().catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(McpError)
    expect((refused as McpError).httpStatus).toBe(401)
    expect((refused as McpError).message).toMatch(/Invalid API key/)
    mcp.set({ status: 429 })
    await expect(client().listTools()).rejects.toThrow(/retry after 7 s/)
  })

  it('an unreachable server is one clear error, never a hang', async () => {
    const dead = new McpHttpClient({ apiBase: 'http://127.0.0.1:9', apiKey: KEY, client: CLIENT, timeoutMs: 2_000 })
    await expect(dead.listTools()).rejects.toThrow(/could not reach|no answer/)
  })
})

describe('messagesInBody', () => {
  it('JSON objects, batches, and SSE events with multi-line data', () => {
    expect(messagesInBody('{"jsonrpc":"2.0","id":1,"result":{}}', 'application/json')).toHaveLength(1)
    expect(messagesInBody('[{"id":1},{"id":2}]', 'application/json')).toHaveLength(2)
    const sse = 'event: message\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":3,"result":{"ok":true}}\r\n\r\n: comment\n\n'
    expect(messagesInBody(sse, 'text/event-stream; charset=utf-8')).toEqual([{ jsonrpc: '2.0', id: 3, result: { ok: true } }])
    expect(messagesInBody('not json', 'application/json')).toEqual([])
  })
})
