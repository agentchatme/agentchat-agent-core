import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon/loop.js'
import type { RuntimeAdapter, TurnContext, TurnResult } from '../src/daemon/adapter-types.js'
import type { AgentWsClient } from '../src/daemon/ws-client.js'
import type { DaemonConfig } from '../src/daemon/config.js'

class FakeWs extends EventEmitter {
  connected = true
  readonly acks: string[] = []
  paused = false
  start(): void {}
  stop(): void {
    this.connected = false
  }
  ack(id: string): void {
    this.acks.push(id)
  }
  pauseInbound(): void {
    this.paused = true
  }
  resumeInbound(): void {
    this.paused = false
  }
}

class FakeAdapter implements RuntimeAdapter {
  readonly name = 'fake'
  readonly calls: TurnContext[] = []
  constructor(private readonly results: Array<TurnResult | Promise<TurnResult>>) {}
  async preflight(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async runTurn(ctx: TurnContext): Promise<TurnResult> {
    this.calls.push(ctx)
    return (await this.results.shift()) ?? { ok: true }
  }
}

const waitFor = async (condition: () => boolean, timeoutMs = 3_500): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

let home: string
let ws: FakeWs
let cfg: DaemonConfig

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-loop-'))
  ws = new FakeWs()
  cfg = {
    apiKey: `ac_live_${'a'.repeat(32)}`,
    handle: 'local-agent',
    apiBase: 'https://api.example.test',
    wsUrl: 'wss://api.example.test/v1/ws',
    home,
    workdir: path.join(home, 'work'),
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      return new Response(
        JSON.stringify(url.endsWith('/active') ? { active: false } : { claimed: true }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  fs.rmSync(home, { recursive: true, force: true })
})

const row = (
  id: string,
  text = 'hello',
  conversationId = 'conv_1',
  sender = 'alice',
) => ({
  id,
  conversation_id: conversationId,
  sender,
  type: 'text',
  content: { text },
  created_at: '2026-07-30T00:00:00Z',
})

describe('daemon delivery state machine', () => {
  it('retries a transient turn failure without waiting for a reconnect replay', async () => {
    const adapter = new FakeAdapter([
      { ok: false, detail: 'temporary runtime failure' },
      { ok: true },
    ])
    const daemon = new Daemon(cfg, adapter, ws as unknown as AgentWsClient)
    await daemon.start()
    ws.emit('inbound', row('msg_retry'))

    await waitFor(() => ws.acks.includes('msg_retry'))
    expect(adapter.calls).toHaveLength(2)
    daemon.stop()
  })

  it('re-acks a replayed handled message without running a second model turn', async () => {
    const adapter = new FakeAdapter([{ ok: true }])
    const daemon = new Daemon(cfg, adapter, ws as unknown as AgentWsClient)
    await daemon.start()
    const message = row('msg_replay')
    ws.emit('inbound', message)
    await waitFor(() => ws.acks.length === 1)

    ws.emit('inbound', message)
    await waitFor(() => ws.acks.length === 2)
    expect(adapter.calls).toHaveLength(1)
    daemon.stop()
  })

  it('processes every message in a same-conversation burst as its own ordered turn', async () => {
    const adapter = new FakeAdapter([{ ok: true }, { ok: true }, { ok: true }])
    const daemon = new Daemon(cfg, adapter, ws as unknown as AgentWsClient)
    await daemon.start()
    ws.emit('inbound', row('msg_1', 'from Alice', 'grp_1', 'alice'))
    ws.emit('inbound', row('msg_2', 'from Bob', 'grp_1', 'bob'))
    ws.emit('inbound', row('msg_3', 'from Carol', 'grp_1', 'carol'))

    await waitFor(() => ws.acks.length === 3)
    expect(adapter.calls.map((call) => call.messageId)).toEqual(['msg_1', 'msg_2', 'msg_3'])
    expect(adapter.calls.map((call) => call.sender)).toEqual(['alice', 'bob', 'carol'])
    expect(adapter.calls.map((call) => call.text)).toEqual([
      'from Alice',
      'from Bob',
      'from Carol',
    ])
    expect(ws.acks).toEqual(['msg_1', 'msg_2', 'msg_3'])
    daemon.stop()
  })

  it(
    'keeps a failed message pending past three attempts and blocks later messages until success',
    async () => {
      let finishFourthAttempt: (result: TurnResult) => void = () => {
        throw new Error('fourth attempt did not start')
      }
      const heldFourthAttempt = new Promise<TurnResult>((resolve) => {
        finishFourthAttempt = resolve
      })
      const adapter = new FakeAdapter([
        { ok: false, detail: 'failure one' },
        { ok: false, detail: 'failure two' },
        { ok: false, detail: 'failure three' },
        heldFourthAttempt,
        { ok: true },
      ])
      const daemon = new Daemon(cfg, adapter, ws as unknown as AgentWsClient)
      await daemon.start()
      ws.emit('inbound', row('msg_blocking'))
      ws.emit('inbound', row('msg_after'))

      await waitFor(() => adapter.calls.length >= 4, 8_500)
      expect(ws.acks).toEqual([])
      expect(adapter.calls.map((call) => call.messageId)).toEqual([
        'msg_blocking',
        'msg_blocking',
        'msg_blocking',
        'msg_blocking',
      ])

      finishFourthAttempt({ ok: true })
      await waitFor(() => ws.acks.length === 2)
      expect(adapter.calls.map((call) => call.messageId)).toEqual([
        'msg_blocking',
        'msg_blocking',
        'msg_blocking',
        'msg_blocking',
        'msg_after',
      ])
      expect(ws.acks).toEqual(['msg_blocking', 'msg_after'])
      daemon.stop()
    },
    10_000,
  )
})
