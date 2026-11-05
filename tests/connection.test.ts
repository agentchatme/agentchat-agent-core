import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BlockedInfo, RealtimeState } from 'agentchatme'
import { IntegrationConnection, socketStateOf, type InviteWake, type Wake } from '../src/integration/connection.js'
import type { SocketState } from '../src/integration/status.js'
import { startServerDouble, until, pause, type ServerDouble } from './helpers/server-double.js'

// ─── The SDK's socket, read as wakes; acked on receipt; its states as status ─
//
// Run against a real server double on localhost (tests/helpers/server-double.ts)
// that behaves like apps/api-server/src/ws/agent-socket.ts on the HELLO path:
// a bad key is closed 1008 'Invalid token' without a hello.ok; a good one gets
// hello.ok first. The double records every frame the client sends after its
// hello — and what the tests look for there is the ACK the SDK sends the
// moment a `message.new` is parsed: delivered means this machine received it.
//
// The connection lifecycle is the SDK's (one `RealtimeClient`, never replaced,
// never giving up): what is pinned here is how the daemon READS it — which SDK
// state becomes which status word, and that a refused key is `terminal` with
// the refusal as its detail while the SDK keeps trying.

const CLIENT = { runtime: 'generic' as const, version: '0.0.0-test' }
const KEY = 'ac_' + 'k'.repeat(32)

let double: ServerDouble
let connections: IntegrationConnection[]

beforeEach(async () => {
  connections = []
  double = await startServerDouble()
})

afterEach(async () => {
  vi.useRealTimers()
  for (const c of connections) c.stop()
  await double.close()
})

interface Connected {
  connection: IntegrationConnection
  wakes: Wake[]
  invites: InviteWake[]
  echoes: number
  readies: number
  blocked: Array<{ detail: string; info: BlockedInfo }>
  /** Every status word in order, from `connecting` on. */
  states: SocketState[]
}

function connect(selfHandle = 'me'): Connected {
  const connection = new IntegrationConnection({
    apiKey: KEY,
    wsBase: double.wsBase,
    selfHandle,
    client: CLIENT,
    reconnectIntervalMs: 100,
    maxReconnectIntervalMs: 500,
  })
  const state: Connected = { connection, wakes: [], invites: [], echoes: 0, readies: 0, blocked: [], states: [] }
  connection.on('wake', (w) => state.wakes.push(w))
  connection.on('invite', (i) => state.invites.push(i))
  connection.on('echo', () => {
    state.echoes += 1
  })
  connection.on('ready', () => {
    state.readies += 1
  })
  connection.on('blocked', (detail, info) => state.blocked.push({ detail, info }))
  connection.on('state', (s) => state.states.push(s))
  connections.push(connection)
  connection.start()
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
    expect(c.states).toEqual(['connecting', 'ready'])
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

  it('a refused key (hello answered with close 1008 Invalid token) reads terminal with the refusal as the detail: zero wakes, no reconnect storm', async () => {
    double.setUpgrade('refuse')
    const c = connect()
    await until(() => c.connection.state === 'terminal')
    expect(c.states).toEqual(['connecting', 'terminal'])
    expect(c.connection.connected).toBe(false)
    await until(() => c.blocked.length === 1)
    expect(c.blocked[0]!.detail).toMatch(/^auth rejected \(close 1008 Invalid token\) — check the agent's API key/)
    expect(c.blocked[0]!.detail).toMatch(/every 10–15 min/)
    expect(c.blocked[0]!.info).toMatchObject({ code: 1008, reason: 'Invalid token' })
    // The SDK's next hello is 10–15 min out, not on the backoff ladder.
    expect(c.blocked[0]!.info.retryInMs).toBeGreaterThanOrEqual(10 * 60_000)
    expect(c.blocked[0]!.info.retryInMs).toBeLessThanOrEqual(15 * 60_000)
    await pause(800) // several backoff steps: a storm would have reconnected by now
    expect(double.upgrades).toBe(1)
    expect(c.wakes).toEqual([])
    expect(c.readies).toBe(0)
  })

  it('a key refused now and accepted later: the SDK’s slow retry makes it ready — terminal → ready, with the ready event', async () => {
    // The retry timer is the SDK's (10–15 min); fake timers drive it, real
    // sockets carry the hello. Only setTimeout is faked, and it keeps pace
    // with real time so the polling helpers still run. The advance stops
    // right past the retry: further and the SDK's 15 s handshake deadline
    // would trip before the real handshake could complete.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    double.setUpgrade('refuse')
    const c = connect()
    await until(() => c.blocked.length === 1)
    double.setUpgrade('hello')
    await vi.advanceTimersByTimeAsync(c.blocked[0]!.info.retryInMs! + 1)
    await until(() => c.connection.connected, 4_000)
    expect(c.readies).toBe(1)
    expect(c.states).toEqual(['connecting', 'terminal', 'ready'])
    expect(double.upgrades).toBe(2)
    expect(c.blocked).toHaveLength(1)
  }, 10_000)

  it('a 1008 AFTER hello.ok (key rotated) is an eviction, not a verdict: reconnecting, and the next hello decides — accepted → ready', async () => {
    const c = connect()
    await until(() => c.connection.connected)
    double.served[0]!.socket.close(1008, 'API key rotated')
    await until(() => c.readies === 2, 4_000)
    expect(c.states).toEqual(['connecting', 'ready', 'reconnecting', 'ready'])
    expect(c.blocked).toEqual([])
    expect(c.wakes).toEqual([])
  })

  it('a 1008 AFTER hello.ok (key rotated) when the next hello is refused: reconnecting, then terminal', async () => {
    const c = connect()
    await until(() => c.connection.connected)
    double.setUpgrade('refuse')
    double.served[0]!.socket.close(1008, 'API key rotated')
    await until(() => c.connection.state === 'terminal', 4_000)
    expect(c.states).toEqual(['connecting', 'ready', 'reconnecting', 'terminal'])
    expect(c.blocked).toHaveLength(1)
    expect(c.blocked[0]!.detail).toMatch(/close 1008 Invalid token/)
    expect(double.upgrades).toBe(2)
  })

  it('a 1008 that is NOT a verdict on the key (the server’s HELLO timer) is the normal backoff, never terminal', async () => {
    // A slow handshake must not read as a refused credential (OpenClaw quick
    // fix #14 found exactly this); the SDK reads 1008 by the server's reason.
    double.setUpgrade('hello-required')
    const c = connect()
    await until(() => double.upgrades >= 2, 4_000)
    expect(c.blocked).toEqual([])
    expect(c.connection.state).toBe('reconnecting')
    double.setUpgrade('hello')
    await until(() => c.connection.connected, 4_000)
    expect(c.states).not.toContain('terminal')
    expect(c.wakes).toEqual([])
  }, 10_000)

  it('stop() after terminal keeps the state terminal — a refused key must not read as a clean close', async () => {
    double.setUpgrade('refuse')
    const c = connect()
    await until(() => c.connection.state === 'terminal')
    c.connection.stop()
    expect(c.connection.state).toBe('terminal')
    expect(c.states).toEqual(['connecting', 'terminal'])
  })

  // ─── transient failures ─────────────────────────────────────────────────

  it('a non-auth upgrade response (503 during a deploy) is retried by the SDK — a second attempt arrives', async () => {
    double.setUpgrade(503)
    const c = connect()
    await until(() => double.upgrades >= 2, 4_000)
    expect(c.blocked).toEqual([])
    expect(c.connection.state).toBe('reconnecting')
    double.setUpgrade('hello')
    await until(() => c.connection.connected, 6_000)
    expect(c.states).toEqual(['connecting', 'reconnecting', 'ready'])
    expect(c.wakes).toEqual([])
  }, 12_000)

  it('reconnects when the server drops the socket; the reconnect is ready again, not a wake', async () => {
    const c = connect()
    await until(() => c.connection.connected)
    double.served[0]!.socket.close(1011, 'server restart')
    await until(() => c.connection.state === 'reconnecting')
    await until(() => double.served.length === 2 && c.connection.connected, 6_000)
    expect(c.readies).toBe(2)
    expect(c.states).toEqual(['connecting', 'ready', 'reconnecting', 'ready'])
    expect(c.wakes).toEqual([])
  }, 10_000)

  it('stop() closes cleanly and ignores late frames', async () => {
    const c = connect()
    await until(() => c.connection.connected)
    c.connection.stop()
    expect(c.connection.state).toBe('closed')
    expect(c.states).toEqual(['connecting', 'ready', 'closed'])
    await pause(100)
    expect(c.connection.connected).toBe(false)
    expect(double.upgrades).toBe(1) // stopped means stopped: no reconnect
  })
})

describe('socketStateOf — the SDK’s states in the status vocabulary', () => {
  it.each<[RealtimeState, SocketState, SocketState]>([
    ['idle', 'idle', 'idle'],
    ['connecting', 'idle', 'connecting'],
    ['connecting', 'connecting', 'connecting'],
    ['ready', 'connecting', 'ready'],
    ['backoff', 'ready', 'reconnecting'],
    ['backoff', 'connecting', 'reconnecting'],
    ['connecting', 'reconnecting', 'reconnecting'],
    ['ready', 'reconnecting', 'ready'],
    ['blocked', 'connecting', 'terminal'],
    ['blocked', 'reconnecting', 'terminal'],
    // The SDK's slow retry out of blocked does not lift the verdict…
    ['connecting', 'terminal', 'terminal'],
    // …an accepted hello does; a server that stopped answering is the normal backoff.
    ['ready', 'terminal', 'ready'],
    ['backoff', 'terminal', 'reconnecting'],
    ['stopped', 'ready', 'closed'],
    ['stopped', 'reconnecting', 'closed'],
    ['stopped', 'connecting', 'closed'],
    ['stopped', 'terminal', 'terminal'],
  ])('SDK %s after status %s → %s', (next, previous, expected) => {
    expect(socketStateOf(next, previous)).toBe(expected)
  })
})
