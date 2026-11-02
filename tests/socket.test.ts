import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { DoorbellSocket, type InviteKnock, type Knock } from '../src/doorbell/socket.js'

// ─── The socket is a knock, never a carrier, and NEVER acknowledges ─────────
//
// Run against a real WebSocket server double on localhost: the server records
// every frame the client sends after the upgrade, and the assertion that
// matters is that the list stays EMPTY — whatever the server pushes.

interface Served {
  headers: Record<string, string | string[] | undefined>
  socket: WebSocket
  clientFrames: string[]
}

let server: WebSocketServer
let served: Served[]
let url: string
let sockets: DoorbellSocket[]

beforeEach(async () => {
  served = []
  sockets = []
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  server.on('connection', (socket, req) => {
    const entry: Served = { headers: req.headers, socket, clientFrames: [] }
    socket.on('message', (data) => entry.clientFrames.push(data.toString()))
    served.push(entry)
    // The upfront-header path: hello.ok echoes the accepted capabilities.
    socket.send(JSON.stringify({ type: 'hello.ok', capabilities: ['ack'] }))
  })
  await new Promise<void>((resolve) => server.on('listening', () => resolve()))
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('no address')
  url = `ws://127.0.0.1:${address.port}/v1/ws`
})

afterEach(async () => {
  for (const s of sockets) s.stop()
  for (const entry of served) entry.socket.terminate()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function connect(selfHandle = 'me'): { socket: DoorbellSocket; knocks: Knock[]; invites: InviteKnock[]; echoes: number } {
  const knocks: Knock[] = []
  const invites: InviteKnock[] = []
  const state = { socket: new DoorbellSocket({ url, apiKey: 'ac_' + 'k'.repeat(32), selfHandle }), knocks, invites, echoes: 0 }
  state.socket.on('knock', (k) => knocks.push(k))
  state.socket.on('invite', (i) => invites.push(i))
  state.socket.on('echo', () => {
    state.echoes += 1
  })
  sockets.push(state.socket)
  state.socket.start()
  return state
}

const until = async (cond: () => boolean, ms = 3_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('DoorbellSocket', () => {
  it('authenticates with the bearer header and advertises the ack capability upfront', async () => {
    connect()
    await until(() => served.length === 1)
    const headers = served[0]!.headers
    expect(headers['authorization']).toBe('Bearer ' + 'ac_' + 'k'.repeat(32))
    expect(headers['x-agentchat-capabilities']).toBe('ack')
    expect(headers['x-agentchat-client']).toBe('coding_agents')
  })

  it('a connect is a knock, and hello.ok settles the ack negotiation', async () => {
    const c = connect()
    await until(() => c.knocks.length === 1 && c.socket.ackNegotiated !== null)
    expect(c.knocks[0]).toEqual({ source: 'connect' })
    expect(c.socket.ackNegotiated).toBe(true)
    expect(c.socket.connected).toBe(true)
  })

  it('message.new is a knock carrying sender and ids only — never the body', async () => {
    const c = connect('me')
    await until(() => served.length === 1 && c.socket.connected)
    served[0]!.socket.send(
      JSON.stringify({
        type: 'message.new',
        payload: {
          id: 'msg_1',
          conversation_id: 'conv_1',
          sender: 'alice',
          content: { text: 'SECRET BODY that must never be read' },
          metadata: { reply_to: 'msg_0' },
        },
      }),
    )
    await until(() => c.knocks.length === 2)
    const knock = c.knocks[1]!
    expect(knock).toEqual({ source: 'message', sender: 'alice', conversationId: 'conv_1', messageId: 'msg_1' })
    expect(JSON.stringify(knock)).not.toContain('SECRET')
    expect(Object.keys(knock)).toEqual(['source', 'sender', 'conversationId', 'messageId'])
  })

  it('this agent’s own echo is not a knock', async () => {
    const c = connect('Me')
    await until(() => served.length === 1 && c.socket.connected)
    served[0]!.socket.send(
      JSON.stringify({ type: 'message.new', payload: { id: 'msg_2', conversation_id: 'conv_1', sender: 'me', content: { text: 'mine' } } }),
    )
    await until(() => c.echoes === 1)
    expect(c.knocks).toHaveLength(1) // the connect knock only
  })

  it('group.invite.received is the second knock kind', async () => {
    const c = connect()
    await until(() => served.length === 1 && c.socket.connected)
    served[0]!.socket.send(
      JSON.stringify({
        type: 'group.invite.received',
        payload: { invite_id: 'gri_9', group_id: 'grp_4', group_name: 'Ops', inviter_handle: 'bob' },
      }),
    )
    await until(() => c.invites.length === 1)
    expect(c.invites[0]).toEqual({ inviteId: 'gri_9', groupId: 'grp_4', groupName: 'Ops', inviterHandle: 'bob' })
  })

  it('other frames, malformed frames and bodiless payloads are not knocks and do not crash', async () => {
    const c = connect()
    await until(() => served.length === 1 && c.socket.connected)
    const s = served[0]!.socket
    s.send('not json')
    s.send(JSON.stringify({ type: 'presence.update', payload: { handle: 'alice' } }))
    s.send(JSON.stringify({ type: 'message.new', payload: 'string payload' }))
    s.send(JSON.stringify({ type: 'group.invite.received', payload: { no: 'id' } }))
    await new Promise((r) => setTimeout(r, 100))
    expect(c.knocks).toHaveLength(1)
    expect(c.invites).toHaveLength(0)
    expect(c.socket.connected).toBe(true)
  })

  it('NEVER sends a frame after the upgrade — no ack, no hello, nothing', async () => {
    const c = connect()
    await until(() => served.length === 1 && c.socket.connected)
    const s = served[0]!.socket
    for (let i = 0; i < 5; i++) {
      s.send(JSON.stringify({ type: 'message.new', payload: { id: `msg_${i}`, conversation_id: 'conv_1', sender: 'alice', content: { text: 'x' } } }))
    }
    s.send(JSON.stringify({ type: 'group.invite.received', payload: { invite_id: 'gri_1' } }))
    await until(() => c.knocks.length === 6 && c.invites.length === 1)
    await new Promise((r) => setTimeout(r, 150))
    expect(served[0]!.clientFrames).toEqual([])
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

  it('a 401 on upgrade is terminal — no reconnect storm against a revoked key', async () => {
    const rejecting = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: (_info: unknown, cb: (ok: boolean, code?: number, msg?: string) => void) => cb(false, 401, 'nope'),
    })
    await new Promise<void>((resolve) => rejecting.on('listening', () => resolve()))
    const address = rejecting.address()
    if (typeof address === 'string' || address === null) throw new Error('no address')
    const socket = new DoorbellSocket({ url: `ws://127.0.0.1:${address.port}/v1/ws`, apiKey: 'ac_' + 'x'.repeat(32), selfHandle: 'me' })
    sockets.push(socket)
    const terminal: string[] = []
    socket.on('terminal', (reason) => terminal.push(reason))
    socket.start()
    await until(() => terminal.length === 1)
    expect(terminal[0]).toMatch(/auth rejected \(401\)/)
    expect(socket.state).toBe('terminal')
    await new Promise<void>((resolve) => rejecting.close(() => resolve()))
  })

  it('reconnects when the server drops the socket, and the reconnect is a knock', async () => {
    const c = connect()
    await until(() => served.length === 1 && c.socket.connected)
    served[0]!.socket.close(1011, 'server restart')
    await until(() => served.length === 2 && c.knocks.length === 2, 6_000)
    expect(c.knocks[1]).toEqual({ source: 'connect' })
  }, 10_000)
})
