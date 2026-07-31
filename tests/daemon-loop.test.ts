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
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const body =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as { message_ids?: string[] })
          : {}
      return new Response(
        JSON.stringify(
          url.endsWith('/active')
            ? { active: false }
            : url.endsWith('/claim-batch')
              ? { claimed_count: body.message_ids?.length ?? 0 }
              : { claimed: true },
        ),
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
  seq: 7,
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

  it('renews the frozen reply claim before every host attempt', async () => {
    let claims = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/claim-batch')) {
          claims += 1
          const body = JSON.parse(String(init?.body)) as { message_ids: string[] }
          return new Response(
            JSON.stringify({ claimed_count: body.message_ids.length }),
            { status: 200 },
          )
        }
        return new Response(JSON.stringify({ active: false }), { status: 200 })
      }),
    )
    const adapter = new FakeAdapter([
      { ok: false, detail: 'temporary runtime failure' },
      { ok: true },
    ])
    const daemon = new Daemon(cfg, adapter, ws as unknown as AgentWsClient)
    await daemon.start()
    ws.emit('inbound', row('msg_renew'))

    await waitFor(() => ws.acks.includes('msg_renew'))
    // One initial claim freezes the batch, then one renewal per attempt.
    expect(claims).toBe(3)
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

  it('coalesces a same-conversation burst into one turn focused on the newest message', async () => {
    const adapter = new FakeAdapter([{ ok: true }])
    const daemon = new Daemon(cfg, adapter, ws as unknown as AgentWsClient)
    await daemon.start()
    ws.emit('inbound', row('msg_1', 'from Alice', 'grp_1', 'alice'))
    ws.emit('inbound', row('msg_2', 'from Bob', 'grp_1', 'bob'))
    ws.emit('inbound', row('msg_3', 'from Carol', 'grp_1', 'carol'))

    await waitFor(() => ws.acks.length === 3)
    expect(adapter.calls).toHaveLength(1)
    expect(adapter.calls[0]).toMatchObject({
      messageId: 'msg_3',
      sender: 'carol',
      text: 'from Carol',
      pendingBatch: {
        count: 3,
        messageIds: ['msg_1', 'msg_2', 'msg_3'],
        oldestMessageId: 'msg_1',
        newestMessageId: 'msg_3',
      },
    })
    expect(ws.acks).toEqual(['msg_1', 'msg_2', 'msg_3'])
    daemon.stop()
  })

  it('bounds one backlog turn at 30 messages and carries the remainder forward', async () => {
    const adapter = new FakeAdapter([{ ok: true }, { ok: true }])
    const daemon = new Daemon(cfg, adapter, ws as unknown as AgentWsClient)
    await daemon.start()
    for (let index = 1; index <= 31; index++) {
      ws.emit('inbound', row(`msg_${index}`, `message ${index}`))
    }

    await waitFor(() => ws.acks.length === 31)
    expect(adapter.calls).toHaveLength(2)
    expect(adapter.calls[0]).toMatchObject({
      messageId: 'msg_30',
      pendingBatch: { count: 30 },
    })
    expect(adapter.calls[1]).toMatchObject({
      messageId: 'msg_31',
      pendingBatch: { count: 1 },
    })
    daemon.stop()
  })

  it('acknowledges only the contiguous prefix it owns when a live session has a conflict', async () => {
    let batchClaim = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/active')) {
          return new Response(JSON.stringify({ active: false }), { status: 200 })
        }
        if (url.endsWith('/claim-batch')) {
          batchClaim += 1
          const body = JSON.parse(String(init?.body)) as {
            message_ids: string[]
          }
          return new Response(
            JSON.stringify({
              claimed_count: batchClaim === 1 ? 1 : body.message_ids.length,
            }),
            { status: 200 },
          )
        }
        return new Response(JSON.stringify({ claimed: true }), { status: 200 })
      }),
    )
    const adapter = new FakeAdapter([{ ok: true }, { ok: true }])
    const daemon = new Daemon(cfg, adapter, ws as unknown as AgentWsClient)
    await daemon.start()
    ws.emit('inbound', row('msg_1'))
    ws.emit('inbound', row('msg_session_owned'))
    ws.emit('inbound', row('msg_3'))

    await waitFor(() => ws.acks.length === 2)
    expect(adapter.calls.map((call) => call.messageId)).toEqual([
      'msg_1',
      'msg_3',
    ])
    expect(ws.acks).toEqual(['msg_1', 'msg_3'])
    expect(ws.acks).not.toContain('msg_session_owned')
    daemon.stop()
  })

  it('keeps an active-turn-deferred delivery locally and claims it after handoff', async () => {
    let batchClaims = 0
    const claimBodies: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/claim-batch')) {
          batchClaims += 1
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>
          claimBodies.push(body)
          return new Response(
            JSON.stringify(
              batchClaims === 1
                ? { claimed_count: 0, deferred: true }
                : { claimed_count: 1 },
            ),
            { status: 200 },
          )
        }
        return new Response(JSON.stringify({ active: false }), { status: 200 })
      }),
    )

    const adapter = new FakeAdapter([{ ok: true }])
    const daemon = new Daemon(cfg, adapter, ws as unknown as AgentWsClient)
    await daemon.start()
    ws.emit('inbound', row('msg_foreground'))

    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(adapter.calls).toHaveLength(0)
    expect(ws.acks).toEqual([])

    await waitFor(() => ws.acks.includes('msg_foreground'))
    expect(adapter.calls).toHaveLength(1)
    expect(batchClaims).toBeGreaterThanOrEqual(2)
    expect(claimBodies.every((body) => body['defer_if_active'] === true)).toBe(true)
    daemon.stop()
  })

  it('bounds foreground rechecks across a multi-conversation backlog', async () => {
    let batchClaims = 0
    let foregroundActive = true
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/claim-batch')) {
          batchClaims += 1
          const body = JSON.parse(String(init?.body)) as { message_ids: string[] }
          return new Response(
            JSON.stringify(
              foregroundActive
                ? { claimed_count: 0, deferred: true }
                : { claimed_count: body.message_ids.length },
            ),
            { status: 200 },
          )
        }
        return new Response(JSON.stringify({ active: false }), { status: 200 })
      }),
    )

    const adapter = new FakeAdapter([])
    const daemon = new Daemon(cfg, adapter, ws as unknown as AgentWsClient)
    await daemon.start()
    for (let index = 0; index < 20; index++) {
      ws.emit('inbound', row(`msg_${index}`, 'hello', `conv_${index}`))
    }

    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(batchClaims).toBeGreaterThan(0)
    expect(batchClaims).toBeLessThanOrEqual(3)

    foregroundActive = false
    await waitFor(() => ws.acks.length === 20)
    expect(adapter.calls).toHaveLength(20)
    daemon.stop()
  })

  it('freezes a running batch and leaves later arrivals for the next turn', async () => {
    let finishFirst: (result: TurnResult) => void = () => {
      throw new Error('first turn did not start')
    }
    const heldFirst = new Promise<TurnResult>((resolve) => {
      finishFirst = resolve
    })
    const adapter = new FakeAdapter([heldFirst, { ok: true }])
    const daemon = new Daemon(cfg, adapter, ws as unknown as AgentWsClient)
    await daemon.start()
    ws.emit('inbound', row('msg_1'))
    await waitFor(() => adapter.calls.length === 1)

    ws.emit('inbound', row('msg_2'))
    expect(adapter.calls[0]?.pendingBatch?.messageIds).toEqual(['msg_1'])
    expect(ws.acks).toEqual([])

    finishFirst({ ok: true })
    await waitFor(() => ws.acks.length === 2)
    expect(adapter.calls.map((call) => call.messageId)).toEqual(['msg_1', 'msg_2'])
    expect(adapter.calls[1]?.pendingBatch?.messageIds).toEqual(['msg_2'])
    daemon.stop()
  })

  it('passes message anchoring, reply, group, and delivery metadata to the runtime', async () => {
    const adapter = new FakeAdapter([{ ok: true }])
    const daemon = new Daemon(cfg, adapter, ws as unknown as AgentWsClient)
    await daemon.start()
    ws.emit('inbound', {
      ...row('msg_context', 'follow-up', 'grp_ops', 'alice'),
      metadata: { reply_to: 'msg_parent' },
      status: 'delivered',
      context: {
        sender: {
          handle: 'alice',
          display_name: 'Alice',
          kind: 'agent',
        },
        conversation: {
          type: 'group',
          group_name: 'Ops',
          member_count: 5,
        },
        mentions: ['local-agent'],
      },
    })

    await waitFor(() => ws.acks.includes('msg_context'))
    expect(adapter.calls[0]).toMatchObject({
      messageId: 'msg_context',
      messageSeq: 7,
      groupName: 'Ops',
      memberCount: 5,
      replyToMessageId: 'msg_parent',
      deliveryStatus: 'delivered',
      mentioned: true,
    })
    daemon.stop()
  })

  it('surfaces older group mentions explicitly while keeping the newest message as focus', async () => {
    const adapter = new FakeAdapter([{ ok: true }])
    const daemon = new Daemon(cfg, adapter, ws as unknown as AgentWsClient)
    await daemon.start()
    ws.emit('inbound', {
      ...row('msg_mention', 'please check this', 'grp_ops', 'alice'),
      seq: 10,
      context: {
        sender: { handle: 'alice', display_name: 'Alice', kind: 'agent' },
        conversation: { type: 'group', group_name: 'Ops', member_count: 4 },
        mentions: ['local-agent'],
      },
    })
    ws.emit('inbound', {
      ...row('msg_latest', 'separate latest update', 'grp_ops', 'bob'),
      seq: 11,
      context: {
        sender: { handle: 'bob', display_name: 'Bob', kind: 'agent' },
        conversation: { type: 'group', group_name: 'Ops', member_count: 4 },
        mentions: [],
      },
    })

    await waitFor(() => ws.acks.length === 2)
    expect(adapter.calls).toHaveLength(1)
    expect(adapter.calls[0]).toMatchObject({
      messageId: 'msg_latest',
      mentioned: false,
      pendingBatch: {
        count: 2,
        oldestMessageSeq: 10,
        newestMessageSeq: 11,
        mentionedMessages: [
          {
            messageId: 'msg_mention',
            messageSeq: 10,
            sender: 'alice',
            senderDisplayName: 'Alice',
            textPreview: 'please check this',
          },
        ],
      },
    })
    daemon.stop()
  })

  it(
    'keeps a failed batch pending past three attempts and acknowledges none until success',
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
      ])
      const daemon = new Daemon(cfg, adapter, ws as unknown as AgentWsClient)
      await daemon.start()
      ws.emit('inbound', row('msg_blocking'))
      ws.emit('inbound', row('msg_after'))

      await waitFor(() => adapter.calls.length >= 4, 8_500)
      expect(ws.acks).toEqual([])
      expect(adapter.calls.map((call) => call.messageId)).toEqual([
        'msg_after',
        'msg_after',
        'msg_after',
        'msg_after',
      ])
      expect(adapter.calls[0]?.pendingBatch?.messageIds).toEqual([
        'msg_blocking',
        'msg_after',
      ])

      finishFourthAttempt({ ok: true })
      await waitFor(() => ws.acks.length === 2)
      expect(adapter.calls.map((call) => call.messageId)).toEqual([
        'msg_after',
        'msg_after',
        'msg_after',
        'msg_after',
      ])
      expect(ws.acks).toEqual(['msg_blocking', 'msg_after'])
      daemon.stop()
    },
    10_000,
  )
})
