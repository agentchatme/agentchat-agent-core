import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { stop, userPrompt } from '../src/hooks/engine.js'
import { writeCredentials } from '../src/identity/credentials.js'
import {
  getPendingAck,
  resetSession,
  setPendingAck,
} from '../src/identity/state.js'

let home: string
let delivered = false
let syncAcks: string[]
let inbox: Array<Record<string, unknown>>

const ctx = () => ({
  home,
  copy: { label: 'Test Host', invoke: 'agentchat-test' },
})
const input = { sessionId: 'session-boundary', source: undefined }

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-hook-boundary-'))
  writeCredentials(home, {
    api_key: `ac_live_${'a'.repeat(32)}`,
    handle: 'boundary-agent',
    api_base: 'https://api.example.test',
  })
  delivered = false
  syncAcks = []
  inbox = [
    {
      id: 'msg_inbound',
      delivery_id: 'delivery_1',
      conversation_id: 'conv_1',
      sender: 'alice',
      type: 'text',
      content: { text: 'please reply' },
      created_at: '2026-07-30T00:00:00Z',
    },
  ]

  vi.stubGlobal(
    'fetch',
    vi.fn(async (raw: string | URL | Request, init?: RequestInit) => {
      const url = String(raw)
      const method = init?.method ?? 'GET'
      const body =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {}

      if (url.includes('/messages/sync/ack')) {
        syncAcks.push(String(body['last_delivery_id']))
        delivered = true
        return new Response(JSON.stringify({ acked: 1 }), { status: 200 })
      }
      if (url.includes('/messages/sync')) {
        return new Response(JSON.stringify(delivered ? [] : inbox), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/reply/claim-batch')) {
        const ids = body['message_ids']
        return new Response(
          JSON.stringify({
            claimed_count: Array.isArray(ids) ? ids.length : 0,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({ ok: true }), {
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

describe('hook delivery completion boundary', () => {
  it('does not ACK UserPromptSubmit context until the following Stop', async () => {
    const prompt = await userPrompt(ctx(), input)

    expect(prompt.context).toContain('1 unread message')
    expect(syncAcks).toEqual([])
    expect(getPendingAck(home, input.sessionId)).toBeNull()

    // The runner calls this only after stdout accepted the host envelope.
    prompt.stage()
    expect(getPendingAck(home, input.sessionId)).toBe('delivery_1')
    expect(syncAcks).toEqual([])

    const completed = await stop(ctx(), input)
    expect(completed.reason).toBeNull()
    expect(syncAcks).toEqual(['delivery_1'])
    expect(getPendingAck(home, input.sessionId)).toBeNull()
  })

  it('does not ACK Stop continuation context until its continuation completes', async () => {
    const firstStop = await stop(ctx(), input)

    expect(firstStop.reason).toContain('While you were working')
    expect(syncAcks).toEqual([])
    firstStop.stage()
    expect(getPendingAck(home, input.sessionId)).toBe('delivery_1')

    const secondStop = await stop(ctx(), {
      ...input,
      stopHookActive: true,
    })
    expect(secondStop.reason).toBeNull()
    expect(syncAcks).toEqual(['delivery_1'])
  })

  it('re-offers Stop context when another hook prevents its continuation', async () => {
    const firstStop = await stop(ctx(), input)
    firstStop.stage()

    // This is an ordinary later Stop, not the continuation requested above.
    const reoffered = await stop(ctx(), input)
    expect(syncAcks).toEqual([])
    expect(reoffered.reason).toContain('While you were working')
    reoffered.stage()

    await stop(ctx(), { ...input, stopHookActive: true })
    expect(syncAcks).toEqual(['delivery_1'])
  })

  it('re-injects an uncommitted delivery after a crashed session resumes', async () => {
    setPendingAck(home, input.sessionId, 'delivery_pending')
    resetSession(home, input.sessionId)

    expect(getPendingAck(home, input.sessionId)).toBeNull()

    const replay = await userPrompt(ctx(), input)
    expect(replay.context).toContain('1 unread message')
    expect(syncAcks).toEqual([])
  })
})
