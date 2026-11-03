import { describe, expect, it } from 'vitest'
import { hostedMcpUrl, probeHostedMcp } from '../src/doorbell/mcp-probe.js'

// ─── One MCP initialize with the key, nothing else ──────────────────────────

const probe = (fetchImpl: typeof fetch) =>
  probeHostedMcp({ apiKey: 'ac_' + 'p'.repeat(32), apiBase: 'https://api.example.test/', clientName: 'test doctor', clientVersion: '0', fetch: fetchImpl })

describe('probeHostedMcp', () => {
  it('posts initialize with the bearer key to <base>/mcp and reads a JSON answer', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'agentchat', version: '0.2.0' } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch
    const result = await probe(fetchImpl)
    expect(result).toMatchObject({ ok: true, serverName: 'agentchat', serverVersion: '0.2.0', protocolVersion: '2025-06-18' })
    expect(calls[0]?.url).toBe('https://api.example.test/mcp')
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer ac_' + 'p'.repeat(32))
    const body = JSON.parse(String(calls[0]?.init.body)) as { method: string }
    expect(body.method).toBe('initialize')
    expect(calls).toHaveLength(1)
  })

  it('reads an SSE-framed answer', async () => {
    const fetchImpl = (async () =>
      new Response('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"agentchat"}}}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as typeof fetch
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
