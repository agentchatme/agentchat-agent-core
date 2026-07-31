import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { sessionEnd, stop, userPrompt } from '../src/hooks/engine.js'
import { writeCredentials } from '../src/identity/credentials.js'

let home: string
const calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = []

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-foreground-'))
  writeCredentials(home, {
    api_key: `ac_live_${'a'.repeat(32)}`,
    handle: 'foreground-agent',
    api_base: 'https://api.example.test',
  })
  calls.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {}
      calls.push({ method, url, body })
      const payload = url.includes('/messages/sync') ? [] : { ok: true }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  fs.rmSync(home, { recursive: true, force: true })
})

const ctx = () => ({
  home,
  copy: { label: 'Test Host', invoke: 'agentchat-test' },
})
const input = { sessionId: 'session-a', source: undefined }

describe('foreground turn ownership', () => {
  it('leases every user turn even when there is no startup digest to ack', async () => {
    await userPrompt(ctx(), input)

    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      body: { session_id: 'session-a', ttl_seconds: 600 },
    })
    expect(calls[1]?.method).toBe('GET')
  })

  it('releases the turn immediately when Stop has nothing to continue', async () => {
    const result = await stop(ctx(), input)

    expect(result.reason).toBeNull()
    expect(calls.map((call) => call.method)).toEqual(['PUT', 'GET', 'DELETE'])
    expect(calls[2]?.body).toEqual({ session_id: 'session-a' })
  })

  it('SessionEnd releases only the ending host session', async () => {
    await sessionEnd(ctx(), input)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: 'DELETE',
      body: { session_id: 'session-a' },
    })
  })
})
