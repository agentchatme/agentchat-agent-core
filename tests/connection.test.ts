import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IntegrationConnection, type InviteWake, type TerminalReason, type Wake } from '../src/integration/connection.js'
import { livenessWebSocket } from '../src/integration/transport.js'
import { startServerDouble, until, pause, type ServerDouble } from './helpers/server-double.js'

// ─── The SDK's socket, read as wakes; acked on receipt ──────────────────────
//
// Run against a real server double on localhost (tests/helpers/server-double.ts)
// that behaves like apps/api-server/src/ws/agent-socket.ts on the HELLO path:
// a bad key is closed 1008 'Invalid token' without a hello.ok; a good one gets
// hello.ok first. The double records every frame the client sends after its
// hello — and what the tests look for there now is the ACK the SDK sends the
// moment a `message.new` is parsed: delivered means this machine received it.

const CLIENT = { runtime: 'generic' as const, version: '0.0.0-test' }
const KEY = 'ac_' + 'k'.repeat(32)

let double: ServerDouble
let connections: IntegrationConnection[]

beforeEach(async () => {
  connections = []
  double = await startServerDouble()
})

afterEach(async () => {
  for (const c of connections) c.stop()
  await double.close()
})

interface Connected {
  connection: IntegrationConnection
  wakes: Wake[]
  invites: InviteWake[]
  echoes: number
  readies: number
  terminal: Array<{ reason: TerminalReason; detail: string }>
}

function connect(selfHandle = 'me', extra: Partial<ConstructorParameters<typeof IntegrationConnection>[0]> = {}): Connected {
  const state: Connected = {
    connection: new IntegrationConnection({
      apiKey: KEY,
      wsBase: double.wsBase,
      selfHandle,
      client: CLIENT,
      reconnectIntervalMs: 100,
      maxReconnectIntervalMs: 500,
      reopenBaseMs: 100,
      reopenMaxMs: 500,
      ...extra,
    }),
    wakes: [],
    invites: [],
    echoes: 0,
    readies: 0,
    terminal: [],
  }
  state.connection.on('wake', (w) => state.wakes.push(w))
  state.connection.on('invite', (i) => state.invites.push(i))
  state.connection.on('echo', () => {
    state.echoes += 1
  })
  state.connection.on('ready', () => {
    state.readies += 1
  })
  state.connection.on('terminal', (reason, detail) => state.terminal.push({ reason, detail }))
  connections.push(state.connection)
  state.connection.start()
  return state
}

describe('IntegrationConnection', () => {
  it('authenticates with a hello frame carrying the key, the ack capability and the runtime as the client identity', async () => {
    const c = connect()
    await until(() => c.connection.connected)
    const hello = double.served[0]!.hello!
    expect(hello['api_key']).toBe(KEY)
    expect(hello['capabilities']).toEqual(['ack'])
    expect(hello['client']).toBe('generic')
    expect(hello['client_version']).toBe('0.0.0-test')
  })

  it('hello.ok makes the connection ready; a connect is NOT a wake', async () => {
    const c = connect()
    await until(() => c.connection.connected)
    expect(c.readies).toBe(1)
    await pause(100)
    expect(c.wakes).toEqual([]) // whether anything is waiting is the holder's question, answered by counts
  })

  it('message.new is a wake carrying sender and ids only — never the body — and is ACKED on receipt', async () => {
    const c = connect('me')
    await until(() => c.connection.connected)
    double.send({
      type: 'message.new',
      payload: {
        id: 'msg_1',
        conversation_id: 'conv_1',
        sender: 'alice',
        seq: 1,
        content: { text: 'SECRET BODY that must never be read' },
        metadata: { reply_to: 'msg_0' },
      },
    })
    await until(() => c.wakes.length === 1)
    const wake = c.wakes[0]!
    expect(wake).toEqual({ source: 'message', sender: 'alice', conversationId: 'conv_1', messageId: 'msg_1' })
    expect(JSON.stringify(wake)).not.toContain('SECRET')
    await until(() => double.acks().length === 1)
    expect(double.acks()).toEqual(['msg_1'])
    expect(double.served[0]!.clientFrames).toEqual([{ type: 'ack', message_id: 'msg_1' }])
  })

  it('this agent’s own echo is not a wake (but is still acked: it was received)', async () => {
    const c = connect('Me')
    await until(() => c.connection.connected)
    double.send({ type: 'message.new', payload: { id: 'msg_2', conversation_id: 'conv_1', sender: 'me', content: { text: 'mine' } } })
    await until(() => c.echoes === 1)
    expect(c.wakes).toHaveLength(0)
    await until(() => double.acks().includes('msg_2'))
  })

  it('a `wake` frame (a deferred reminder came due) is a wake of the second kind, and is never acked', async () => {
    const c = connect()
    await until(() => c.connection.connected)
    double.send({
      type: 'wake',
      payload: { reason: 'reminder', conversation_id: 'conv_7', anchor_message_id: 'msg_70', step: 1, at: new Date().toISOString() },
    })
    await until(() => c.wakes.length === 1)
    expect(c.wakes[0]).toEqual({ source: 'reminder', conversationId: 'conv_7', anchorMessageId: 'msg_70', step: 1 })
    await pause(100)
    expect(double.served[0]!.clientFrames).toEqual([])
  })

  it('group.invite.received is an invite wake', async () => {
    const c = connect()
    await until(() => c.connection.connected)
    double.send({
      type: 'group.invite.received',
      payload: { invite_id: 'gri_9', group_id: 'grp_4', group_name: 'Ops', inviter_handle: 'bob' },
    })
    await until(() => c.invites.length === 1)
    expect(c.invites[0]).toEqual({ inviteId: 'gri_9', groupId: 'grp_4', groupName: 'Ops', inviterHandle: 'bob' })
  })

  it('other frames, malformed frames and bodiless payloads are not wakes and do not crash', async () => {
    const c = connect()
    await until(() => c.connection.connected)
    const s = double.served[0]!.socket
    s.send('not json')
    s.send(JSON.stringify({ type: 'presence.update', payload: { handle: 'alice' } }))
    s.send(JSON.stringify({ type: 'message.new', payload: 'string payload' }))
    s.send(JSON.stringify({ type: 'group.invite.received', payload: { no: 'id' } }))
    s.send(JSON.stringify({ type: 'wake', payload: { reason: 'reminder' } })) // the SDK refuses a malformed wake
    await pause(100)
    expect(c.wakes).toHaveLength(0)
    expect(c.invites).toHaveLength(0)
    expect(c.connection.connected).toBe(true)
  })

  it('sends nothing but acks and the hello — no sync, no read ack, no decision from here', async () => {
    const c = connect()
    await until(() => c.connection.connected)
    for (let i = 0; i < 5; i++) {
      double.send({ type: 'message.new', payload: { id: `msg_${i}`, conversation_id: 'conv_1', sender: 'alice', content: { text: 'x' } } })
    }
    double.send({ type: 'group.invite.received', payload: { invite_id: 'gri_1' } })
    await until(() => c.wakes.length === 5 && c.invites.length === 1)
    await until(() => double.acks().length === 5)
    await pause(100)
    expect(double.served[0]!.clientFrames.every((f) => f['type'] === 'ack')).toBe(true)
    expect(double.requests).toEqual([]) // no REST from the connection itself
  })

  // ─── a refused credential, the way the server actually refuses it ───────

  it('a refused key (hello answered with close 1008 Invalid token) is terminal auth: zero wakes, no reconnect', async () => {
    double.setUpgrade('refuse')
    const c = connect()
    await until(() => c.terminal.length === 1)
    expect(c.terminal[0]!.reason).toBe('auth')
    expect(c.terminal[0]!.detail).toMatch(/close 1008 Invalid token/)
    expect(c.connection.state).toBe('terminal')
    expect(c.connection.connected).toBe(false)
    await pause(800) // longer than the first backoff: a storm would have reconnected by now
    expect(double.upgrades).toBe(1)
    expect(c.wakes).toEqual([])
    expect(c.readies).toBe(0)
  })

  it('a 1008 AFTER hello.ok with a credential reason (key rotated) is terminal auth as well', async () => {
    const c = connect()
    await until(() => c.connection.connected)
    double.served[0]!.socket.close(1008, 'API key rotated')
    await until(() => c.terminal.length === 1)
    expect(c.terminal[0]!.reason).toBe('auth')
    expect(c.terminal[0]!.detail).toMatch(/API key rotated/)
    await pause(500)
    expect(double.upgrades).toBe(1)
  })

  it('a 1008 that is NOT a verdict on the key (the server’s HELLO timer) gets a fresh client, not a sit-out', async () => {
    // The SDK stops reconnecting on any 1008; a slow handshake must not read
    // as a refused credential (OpenClaw quick fix #14 found exactly this).
    double.setUpgrade('hello-required')
    const c = connect()
    await until(() => double.upgrades >= 2, 4_000)
    expect(c.terminal).toEqual([])
    double.setUpgrade('hello')
    await until(() => c.connection.connected, 4_000)
    expect(c.wakes).toEqual([])
  }, 10_000)

  it('stop() after terminal keeps the state terminal — a refused key must not read as a clean close', async () => {
    double.setUpgrade('refuse')
    const c = connect()
    await until(() => c.terminal.length === 1)
    c.connection.stop()
    expect(c.connection.state).toBe('terminal')
  })

  // ─── transient failures ─────────────────────────────────────────────────

  it('a non-auth upgrade response (503 during a deploy) is retried by the SDK — a second attempt arrives', async () => {
    double.setUpgrade(503)
    const c = connect()
    await until(() => double.upgrades >= 2, 4_000)
    expect(c.terminal).toEqual([])
    expect(['reconnecting', 'connecting']).toContain(c.connection.state)
    double.setUpgrade('hello')
    await until(() => c.connection.connected, 6_000)
    expect(c.wakes).toEqual([])
  }, 12_000)

  it('reconnects when the server drops the socket; the reconnect is ready again, not a wake', async () => {
    const c = connect()
    await until(() => c.connection.connected)
    double.served[0]!.socket.close(1011, 'server restart')
    await until(() => c.connection.state === 'reconnecting')
    await until(() => double.served.length === 2 && c.connection.connected, 6_000)
    expect(c.readies).toBe(2)
    expect(c.wakes).toEqual([])
  }, 10_000)

  it('stop() closes cleanly and ignores late frames', async () => {
    const c = connect()
    await until(() => c.connection.connected)
    c.connection.stop()
    expect(c.connection.state).toBe('closed')
    await pause(100)
    expect(c.connection.connected).toBe(false)
  })
})

describe('the liveness transport', () => {
  it('terminates a socket that goes silent so the SDK reconnects; server pings keep it alive', async () => {
    // Silent server: nothing after hello.ok. With a 300 ms liveness window the
    // transport terminates and the SDK reconnects — a second upgrade arrives.
    const c = connect('me', { webSocket: livenessWebSocket({ livenessMs: 300 }) })
    await until(() => c.connection.connected)
    await until(() => double.served.length >= 2, 3_000)
    expect(c.terminal).toEqual([])
    for (const conn of connections) conn.stop()
    connections = []
    await double.close()

    // A server that pings inside the window: one connection, held.
    double = await startServerDouble({ pingEveryMs: 100 })
    const kept = connect('me', { webSocket: livenessWebSocket({ livenessMs: 300 }) })
    await until(() => kept.connection.connected)
    await pause(900)
    expect(double.served).toHaveLength(1)
    expect(kept.connection.connected).toBe(true)
  }, 10_000)
})
