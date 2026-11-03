import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { DoorbellSocket, type InviteKnock, type Knock, type TerminalReason } from '../src/doorbell/socket.js'
import { startServerDouble, until, pause, type ServerDouble } from './helpers/server-double.js'

// ─── The socket is a knock, never a carrier, and NEVER acknowledges ─────────
//
// Run against a real server double on localhost (tests/helpers/server-double.ts)
// that behaves like apps/api-server/src/ws/agent-socket.ts: a bad bearer
// completes the upgrade and is closed 1008 without a hello.ok; a good one gets
// hello.ok first. The double records every frame the client sends after the
// upgrade, and the assertion that matters is that the list stays EMPTY.

let double: ServerDouble
let sockets: DoorbellSocket[]

beforeEach(async () => {
  sockets = []
  double = await startServerDouble()
})

afterEach(async () => {
  for (const s of sockets) s.stop()
  await double.close()
})

interface Connected {
  socket: DoorbellSocket
  knocks: Knock[]
  invites: InviteKnock[]
  echoes: number
  readies: number
  terminal: Array<{ reason: TerminalReason; detail: string }>
}

function connect(selfHandle = 'me', url = double.wsUrl): Connected {
  const state: Connected = {
    socket: new DoorbellSocket({ url, apiKey: 'ac_' + 'k'.repeat(32), selfHandle }),
    knocks: [],
    invites: [],
    echoes: 0,
    readies: 0,
    terminal: [],
  }
  state.socket.on('knock', (k) => state.knocks.push(k))
  state.socket.on('invite', (i) => state.invites.push(i))
  state.socket.on('echo', () => {
    state.echoes += 1
  })
  state.socket.on('ready', () => {
    state.readies += 1
  })
  state.socket.on('terminal', (reason, detail) => state.terminal.push({ reason, detail }))
  sockets.push(state.socket)
  state.socket.start()
  return state
}

describe('DoorbellSocket', () => {
  it('authenticates with the bearer header and advertises the ack capability upfront', async () => {
    connect()
    await until(() => double.served.length === 1)
    const headers = double.served[0]!.headers
    expect(headers['authorization']).toBe('Bearer ' + 'ac_' + 'k'.repeat(32))
    expect(headers['x-agentchat-capabilities']).toBe('ack')
    expect(headers['x-agentchat-client']).toBe('coding_agents')
  })

  it('hello.ok makes the socket ready and settles the ack negotiation; a connect is NOT a knock', async () => {
    const c = connect()
    await until(() => c.socket.connected)
    expect(c.socket.ackNegotiated).toBe(true)
    expect(c.readies).toBe(1)
    await pause(100)
    expect(c.knocks).toEqual([]) // whether anything is waiting is the holder's question, answered by counts
  })

  it('message.new is a knock carrying sender and ids only — never the body', async () => {
    const c = connect('me')
    await until(() => c.socket.connected)
    double.send({
      type: 'message.new',
      payload: {
        id: 'msg_1',
        conversation_id: 'conv_1',
        sender: 'alice',
        content: { text: 'SECRET BODY that must never be read' },
        metadata: { reply_to: 'msg_0' },
      },
    })
    await until(() => c.knocks.length === 1)
    const knock = c.knocks[0]!
    expect(knock).toEqual({ source: 'message', sender: 'alice', conversationId: 'conv_1', messageId: 'msg_1' })
    expect(JSON.stringify(knock)).not.toContain('SECRET')
    expect(Object.keys(knock)).toEqual(['source', 'sender', 'conversationId', 'messageId'])
  })

  it('this agent’s own echo is not a knock', async () => {
    const c = connect('Me')
    await until(() => c.socket.connected)
    double.send({ type: 'message.new', payload: { id: 'msg_2', conversation_id: 'conv_1', sender: 'me', content: { text: 'mine' } } })
    await until(() => c.echoes === 1)
    expect(c.knocks).toHaveLength(0)
  })

  it('group.invite.received is the second knock kind', async () => {
    const c = connect()
    await until(() => c.socket.connected)
    double.send({
      type: 'group.invite.received',
      payload: { invite_id: 'gri_9', group_id: 'grp_4', group_name: 'Ops', inviter_handle: 'bob' },
    })
    await until(() => c.invites.length === 1)
    expect(c.invites[0]).toEqual({ inviteId: 'gri_9', groupId: 'grp_4', groupName: 'Ops', inviterHandle: 'bob' })
  })

  it('other frames, malformed frames and bodiless payloads are not knocks and do not crash', async () => {
    const c = connect()
    await until(() => c.socket.connected)
    const s = double.served[0]!.socket
    s.send('not json')
    s.send(JSON.stringify({ type: 'presence.update', payload: { handle: 'alice' } }))
    s.send(JSON.stringify({ type: 'message.new', payload: 'string payload' }))
    s.send(JSON.stringify({ type: 'group.invite.received', payload: { no: 'id' } }))
    await pause(100)
    expect(c.knocks).toHaveLength(0)
    expect(c.invites).toHaveLength(0)
    expect(c.socket.connected).toBe(true)
  })

  it('NEVER sends a frame after the upgrade — no ack, no hello, nothing', async () => {
    const c = connect()
    await until(() => c.socket.connected)
    for (let i = 0; i < 5; i++) {
      double.send({ type: 'message.new', payload: { id: `msg_${i}`, conversation_id: 'conv_1', sender: 'alice', content: { text: 'x' } } })
    }
    double.send({ type: 'group.invite.received', payload: { invite_id: 'gri_1' } })
    await until(() => c.knocks.length === 5 && c.invites.length === 1)
    await pause(150)
    expect(double.served[0]!.clientFrames).toEqual([])
  })

  it('has no send path by construction', () => {
    const names = Object.getOwnPropertyNames(DoorbellSocket.prototype)
    expect(names).not.toContain('ack')
    expect(names).not.toContain('send')
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'doorbell', 'socket.ts'), 'utf-8')
    // `.send(` would be the only way to emit a frame; it must not appear in code.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n')
    expect(code).not.toMatch(/\.send\(/)
    expect(code).not.toMatch(/messages\/sync/)
  })

  // ─── a refused credential, the way the server actually refuses it ───────

  it('a refused key (upgrade completes, close 1008 before hello.ok) is terminal auth: zero knocks, no reconnect', async () => {
    double.setUpgrade('refuse')
    const c = connect()
    await until(() => c.terminal.length === 1)
    expect(c.terminal[0]!.reason).toBe('auth')
    expect(c.terminal[0]!.detail).toMatch(/close 1008 Invalid token/)
    expect(c.socket.state).toBe('terminal')
    expect(c.socket.connected).toBe(false)
    await pause(1_500) // longer than the first backoff: a storm would have reconnected by now
    expect(double.upgrades).toBe(1)
    expect(c.knocks).toEqual([])
    expect(c.readies).toBe(0)
  })

  it('a 1008 AFTER hello.ok (key rotated, account suspended) reconnects once; the refusal before hello.ok is then terminal', async () => {
    const c = connect()
    await until(() => c.socket.connected)
    double.setUpgrade('refuse')
    double.served[0]!.socket.close(1008, 'API key rotated')
    await until(() => c.terminal.length === 1, 5_000)
    expect(c.terminal[0]!.reason).toBe('auth')
    expect(double.upgrades).toBe(2)
    expect(c.knocks).toEqual([])
  }, 10_000)

  it('an HTTP 401 on the upgrade (a proxy) is terminal auth as well', async () => {
    double.setUpgrade(401)
    const c = connect()
    await until(() => c.terminal.length === 1)
    expect(c.terminal[0]!.reason).toBe('auth')
    expect(c.terminal[0]!.detail).toMatch(/HTTP 401/)
    expect(c.socket.state).toBe('terminal')
    await pause(1_500)
    expect(double.upgrades).toBe(1)
  })

  // ─── transient upgrade failures ─────────────────────────────────────────

  it('a non-auth upgrade response (503 during a deploy) is torn down and retried — a second attempt arrives', async () => {
    double.setUpgrade(503)
    const c = connect()
    await until(() => double.upgrades >= 2, 4_000)
    expect(c.terminal).toEqual([])
    expect(['reconnecting', 'connecting']).toContain(c.socket.state)
    double.setUpgrade('hello')
    await until(() => c.socket.connected, 6_000)
    expect(c.knocks).toEqual([])
  }, 12_000)

  it('reconnects when the server drops the socket; the reconnect is ready again, not a knock', async () => {
    const c = connect()
    await until(() => c.socket.connected)
    double.served[0]!.socket.close(1011, 'server restart')
    await until(() => double.served.length === 2 && c.socket.connected, 6_000)
    expect(c.readies).toBe(2)
    expect(c.knocks).toEqual([])
  }, 10_000)
})
