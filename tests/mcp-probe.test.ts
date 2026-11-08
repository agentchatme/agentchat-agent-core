import { describe, expect, it } from 'vitest'
import { hostedMcpUrl, probeHostedMcp } from '../src/integration/mcp-probe.js'

// ─── initialize, then tools/list, with the key (the kit's probeHostedTools) ─

const probe = (fetchImpl: typeof fetch) =>
  probeHostedMcp({ apiKey: 'ac_' + 'p'.repeat(32), apiBase: 'https://api.example.test/', client: { runtime: 'generic', version: '0.0.0-test' }, clientName: 'test doctor', clientVersion: '0', fetch: fetchImpl })

describe('probeHostedMcp', () => {
  it('posts initialize with the bearer key to <base>/mcp, then tools/list; ok when the tools a run needs are listed', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      const { id, method } = JSON.parse(String(init?.body)) as { id: number; method: string }
      const result =
        method === 'initialize'
          ? { protocolVersion: '2025-06-18', serverInfo: { name: 'agentchat', version: '0.2.0' } }
          : { tools: [{ name: 'agentchat_inbox' }, { name: 'agentchat_decide' }] }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const result = await probe(fetchImpl)
    expect(result).toMatchObject({ ok: true, serverName: 'agentchat', serverVersion: '0.2.0', protocolVersion: '2025-06-18', missing: [] })
    expect(calls[0]?.url).toBe('https://api.example.test/mcp')
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer ac_' + 'p'.repeat(32))
    expect(headers['X-AgentChat-Client']).toBe('generic')
    expect(headers['X-AgentChat-Client-Version']).toBe('0.0.0-test')
    const body = JSON.parse(String(calls[0]?.init.body)) as { method: string }
    expect(body.method).toBe('initialize')
    expect(calls).toHaveLength(2)
    expect((JSON.parse(String(calls[1]?.init.body)) as { method: string }).method).toBe('tools/list')
  })

  it('a key that does not see the tools a run needs is not ok, and says which', async () => {
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const { id, method } = JSON.parse(String(init?.body)) as { id: number; method: string }
      const result = method === 'initialize' ? { serverInfo: { name: 'agentchat' } } : { tools: [{ name: 'agentchat_register' }] }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    expect(await probe(fetchImpl)).toMatchObject({ ok: false, missing: ['agentchat_inbox', 'agentchat_decide'] })
  })

  it('reads SSE-framed answers', async () => {
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const { id, method } = JSON.parse(String(init?.body)) as { id: number; method: string }
      const result = method === 'initialize' ? { serverInfo: { name: 'agentchat' } } : { tools: [{ name: 'agentchat_inbox' }, { name: 'agentchat_decide' }] }
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    expect(await probe(fetchImpl)).toMatchObject({ ok: true, serverName: 'agentchat' })
  })

  it('a 401 says the key does not authenticate', async () => {
    const fetchImpl = (async () => new Response('', { status: 401 })) as typeof fetch
    expect(await probe(fetchImpl)).toMatchObject({ ok: false, status: 401, error: expect.stringMatching(/does not authenticate/) })
  })

  it('a transport failure is reported, not thrown', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    expect(await probe(fetchImpl)).toMatchObject({ ok: false, error: 'ECONNREFUSED' })
  })

  it('derives the URL without a double slash', () => {
    expect(hostedMcpUrl('https://api.agentchat.me/')).toBe('https://api.agentchat.me/mcp')
    expect(hostedMcpUrl('https://api.agentchat.me')).toBe('https://api.agentchat.me/mcp')
  })
})
