import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { runListen } from '../src/cli/listen.js'
import { runWatch, describeFrame } from '../src/cli/watch.js'
import { readIntegrationStatus } from '../src/integration/status.js'
import { claudeMcpConfigPath } from '../src/presets/index.js'
import { installFakeClaude, readFakeRuns } from './helpers/fake-runtimes.js'
import { startServerDouble, until, type ServerDouble } from './helpers/server-double.js'

// ─── A foreground listener, end to end, against the server double ───────────
//
// The double speaks the socket's HELLO path, the tray, the texts and the
// invites. Each test signs a throwaway home in against it, starts
// `runListen` in the foreground, and checks what the wake did: the owner's
// command ran once with the served wake instruction on stdin; the forwarder
// POSTed the agentchat-dialect wake; the claude preset ran the fake `claude`
// with the listener's own tool config. Every message.new is acked before.

const KEY = 'ac_live_' + 'e'.repeat(40)
let tmp: string
let home: string
let server: ServerDouble
let lines: string[]
const originalPath = process.env['PATH']

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-listen-e2e-'))
  home = path.join(tmp, 'home')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(path.join(tmp, 'work'), { recursive: true })
  // The texts announce a manual the double serves itself: no test reaches agentchat.me.
  server = await startServerDouble({ tray: { waiting: 1 }, manual: { version: '9.0.0', body: '---\nname: agentchat\nversion: 9.0.0\n---\n\nTest manual.\n' } })
  fs.writeFileSync(path.join(home, 'credentials'), JSON.stringify({ api_key: KEY, handle: 'probe', api_base: server.apiBase }))
  lines = []
})
afterEach(async () => {
  process.env['PATH'] = originalPath
  await server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const io = (signal: AbortSignal, env: NodeJS.ProcessEnv = process.env) => ({
  out: (l: string) => lines.push(l),
  err: (l: string) => lines.push(l),
  cwd: path.join(tmp, 'work'),
  signal,
  env,
  exit: () => undefined,
})

describe('agentchat listen --run, end to end', () => {
  it('a wake runs the owner\'s command once: served wake instruction on stdin, identity in env, no key; the frame is acked first', async () => {
    const record = path.join(tmp, 'runs.jsonl')
    const script = path.join(tmp, 'agent.cjs')
    fs.writeFileSync(
      script,
      [
        "let d = ''",
        "process.stdin.on('data', (c) => (d += c))",
        "process.stdin.on('end', () => {",
        `  require('node:fs').appendFileSync(${JSON.stringify(record)}, JSON.stringify({ stdin: d, handle: process.env.AGENTCHAT_HANDLE, kind: process.env.AGENTCHAT_WAKE_KIND, key: process.env.AGENTCHAT_API_KEY || null, mcp: process.env.AGENTCHAT_MCP_URL }) + '\\n')`,
        "  process.stdout.write('ok')",
        '})',
      ].join('\n'),
    )
    const controller = new AbortController()
    const done = runListen(home, 'listen', { run: `"${process.execPath}" "${script}"` }, io(controller.signal))
    // Connect → one coalesced wake → the tray count says 1 → one run.
    await until(() => fs.existsSync(record), 15_000)
    server.send({ type: 'message.new', payload: { id: 'msg_1', conversation_id: 'conv_1', sender: 'peer', content: { text: 'BODY NEVER READ' } } })
    await until(() => server.acks().includes('msg_1'), 5_000)
    controller.abort()
    expect(await done).toBe(0)

    const runs = fs.readFileSync(record, 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, string | null>)
    expect(runs[0]).toMatchObject({ handle: '@probe', kind: 'wake', key: null, mcp: `${server.apiBase}/mcp` })
    expect(runs[0]?.stdin).toContain('SERVED WAKE INSTRUCTION for generic')
    expect(runs[0]?.stdin).toContain(path.join(home, 'skills', 'agentchat', 'SKILL.md'))
    expect(JSON.stringify(runs)).not.toContain('BODY NEVER READ')
    // The skill file follows the manual the texts announce.
    expect(fs.readFileSync(path.join(home, 'skills', 'agentchat', 'SKILL.md'), 'utf-8')).toContain('version: 9.0.0')
    // Texts for the generic runtime; the CLI's own client name on the hello.
    expect(server.requests.some((r) => r.startsWith('/v1/texts?runtime=generic'))).toBe(true)
    expect(server.served[0]?.hello?.['client']).toBe('agentchat-cli')
    expect(readIntegrationStatus(home)).toMatchObject({ runtime: 'command', handle: 'probe' })
    expect(lines.join('\n')).toMatch(/Listening as @probe — on each wake: run `/)
  }, 30_000)
})

describe('agentchat forward, end to end', () => {
  it('each wake is one POST in the agentchat dialect, with the counts from the tray', async () => {
    const hits: Array<{ auth: string | undefined; body: Record<string, unknown> }> = []
    const receiver = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        hits.push({ auth: req.headers['authorization'], body: JSON.parse(body) as Record<string, unknown> })
        res.statusCode = 202
        res.end()
      })
    })
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', () => r()))
    const address = receiver.address()
    if (address === null || typeof address === 'string') throw new Error('no address')
    try {
      const controller = new AbortController()
      const done = runListen(home, 'forward', { to: `http://127.0.0.1:${address.port}/wake` }, io(controller.signal))
      await until(() => hits.length > 0, 15_000)
      controller.abort()
      expect(await done).toBe(0)
      const secret = fs.readFileSync(path.join(home, 'forward.secret'), 'utf-8').trim()
      expect(hits[0]?.auth).toBe(`Bearer ${secret}`)
      expect(hits[0]?.body).toMatchObject({ version: 1, type: 'agentchat.wake', handle: '@probe' })
      expect(Array.isArray(hits[0]?.body['conversations'])).toBe(true)
    } finally {
      receiver.closeAllConnections()
      await new Promise<void>((r) => receiver.close(() => r()))
    }
  }, 30_000)
})

describe('agentchat listen --preset claude-code, end to end (fake claude)', () => {
  it('the run is `claude -p` with this agent\'s own tool config, the claude-code texts, and no key on argv', async () => {
    const fake = installFakeClaude(tmp)
    const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${originalPath ?? ''}`, FAKE_RUNTIME_RECORD: fake.recordPath, CLAUDE_CONFIG_DIR: path.join(tmp, '.claude') }
    process.env['PATH'] = env.PATH
    const controller = new AbortController()
    const done = runListen(home, 'listen', { preset: 'claude-code' }, io(controller.signal, env))
    await until(() => readFakeRuns(fake).length > 0, 20_000)
    controller.abort()
    expect(await done).toBe(0)
    const [run] = readFakeRuns(fake)
    expect(run?.argv[run.argv.indexOf('--mcp-config') + 1]).toBe(claudeMcpConfigPath(home))
    expect(run?.stdin).toContain('SERVED WAKE INSTRUCTION for claude-code')
    // The run cannot read the home, so it is pointed at the address.
    expect(run?.stdin).toContain('https://agentchat.me/skill.md')
    expect(JSON.stringify(run)).not.toContain(KEY)
    expect(server.requests.some((r) => r.startsWith('/v1/texts?runtime=claude-code'))).toBe(true)
  }, 40_000)
})

describe('agentchat watch', () => {
  it('prints frame types and ids, never content; marks own echoes; shows the wake cycle a listener would start', async () => {
    const controller = new AbortController()
    const printed: string[] = []
    const done = runWatch(home, {}, { out: (l) => printed.push(l), err: (l) => printed.push(l), signal: controller.signal })
    await until(() => printed.some((l) => l.includes('hello.ok')), 10_000)
    server.send({ type: 'message.new', payload: { id: 'msg_7', conversation_id: 'conv_7', sender: 'peer', content: { text: 'SECRET PEER BODY' } } })
    server.send({ type: 'message.new', payload: { id: 'msg_8', conversation_id: 'conv_7', sender: 'probe', content: { text: 'my own echo' } } })
    await until(() => printed.some((l) => l.includes('wake cycle')), 10_000)
    await until(() => server.acks().includes('msg_7'), 5_000)
    controller.abort()
    expect(await done).toBe(0)
    const text = printed.join('\n')
    expect(text).toMatch(/message\.new conv=conv_7 msg=msg_7 from=@peer/)
    expect(text).toMatch(/msg=msg_8 from=@probe own=true/)
    expect(text).not.toContain('SECRET PEER BODY')
    expect(text).not.toContain(KEY)
  }, 30_000)

  it('describeFrame: a wake frame and an invite are wakes; content keys are never read', () => {
    expect(describeFrame('wake', { reason: 'reminder', conversation_id: 'c', step: 2, anchor_message_id: 'm' }, 'me')).toMatchObject({ wake: true, text: 'wake reason=reminder conv=c step=2' })
    expect(describeFrame('group.invite.received', { invite_id: 'inv_1', group_id: 'grp_1', inviter_handle: 'x', group_name: 'NAME NEVER SHOWN' }, 'me')).toMatchObject({ wake: true, text: 'group.invite.received invite=inv_1 group=grp_1 from=@x' })
    expect(describeFrame('presence.update', { handle: 'x', status: 'online' }, 'me')).toMatchObject({ wake: false })
  })
})
