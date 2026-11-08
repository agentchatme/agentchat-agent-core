import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { CommandRunner, RUN_ENV, commandRunEnv } from '../src/listener/command-runner.js'
import { ForwardRunner, buildWakePayload, ensureForwardSecret, forwardSecretPath, forwardUrlProblem, readForwardSecret } from '../src/listener/forward.js'
import { describeListenerConfig, readListenerConfig, writeListenerConfig, listenerConfigPath } from '../src/listener/config.js'
import type { RunnerIdentity } from '../src/integration/runner.js'

// ─── The listener's runners: the owner's command, the forwarder; its config ─

const KEY = 'ac_live_' + 'q'.repeat(40)
let dir: string
let identity: RunnerIdentity

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-listener-'))
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(path.join(dir, 'work'), { recursive: true })
  identity = { home, handle: 'probe', apiKey: KEY, apiBase: 'https://api.example', workdir: path.join(dir, 'work') }
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

/** A node one-liner as a shell command line, portable across sh and cmd.exe. */
function nodeCommand(script: string): string {
  const file = path.join(dir, `cmd-${Math.random().toString(16).slice(2)}.cjs`)
  fs.writeFileSync(file, script)
  return `"${process.execPath}" "${file}"`
}

describe('CommandRunner — the owner\'s command, once per wake', () => {
  it('runs through the shell in the workdir, the served prompt on stdin, identity in the environment, no key', async () => {
    const out = path.join(dir, 'seen.json')
    const command = nodeCommand(
      [
        "let d = ''",
        "process.stdin.on('data', (c) => (d += c))",
        "process.stdin.on('end', () => {",
        `  require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ stdin: d, cwd: process.cwd(), env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('AGENTCHAT_'))) }))`,
        "  process.stdout.write('done')",
        '})',
      ].join('\n'),
    )
    const runner = new CommandRunner({ command, identity, env: { ...process.env, AGENTCHAT_API_KEY: 'ac_live_' + 'x'.repeat(40) } })
    expect(await runner.preflight()).toEqual({ ok: true })
    const outcome = await runner.start({ kind: 'wake', prompt: 'SERVED WAKE INSTRUCTION', runId: 'run-1', budgetMs: 20_000 })
    expect(outcome.state).toBe('ok')
    const seen = JSON.parse(fs.readFileSync(out, 'utf-8')) as { stdin: string; cwd: string; env: Record<string, string> }
    expect(seen.stdin).toBe('SERVED WAKE INSTRUCTION')
    expect(fs.realpathSync(seen.cwd)).toBe(fs.realpathSync(identity.workdir))
    expect(seen.env).toMatchObject({
      [RUN_ENV.home]: identity.home,
      [RUN_ENV.handle]: '@probe',
      [RUN_ENV.apiBase]: 'https://api.example',
      [RUN_ENV.mcpUrl]: 'https://api.example/mcp',
      [RUN_ENV.wakeKind]: 'wake',
      [RUN_ENV.runId]: 'run-1',
    })
    // An inherited key is removed unless the owner asked for it.
    expect(seen.env[RUN_ENV.apiKey]).toBeUndefined()
  }, 20_000)

  it('--with-key puts THIS agent\'s key in the environment (never on the command line)', () => {
    const env = commandRunEnv({ command: 'x', identity, withKey: true, env: {} }, { kind: 'invite', runId: 'r' })
    expect(env[RUN_ENV.apiKey]).toBe(KEY)
    expect(env[RUN_ENV.wakeKind]).toBe('invite')
  })

  it('a command that is not found is NOT STARTED; a missing workdir fails preflight; an empty command is refused', async () => {
    const runner = new CommandRunner({ command: 'agentchat-no-such-command-' + process.pid, identity })
    const outcome = await runner.start({ kind: 'wake', prompt: 'p', runId: 'r', budgetMs: 20_000 })
    expect(outcome.state).toBe('not_started')
    const gone = new CommandRunner({ command: 'true', identity: { ...identity, workdir: path.join(dir, 'missing') } })
    expect((await gone.preflight()).ok).toBe(false)
    expect(() => new CommandRunner({ command: '  ', identity })).toThrow(/empty/)
  }, 20_000)
})

describe('forward — the address rules', () => {
  it('http only to this machine; https anywhere; no credentials in the address', () => {
    expect(forwardUrlProblem('http://localhost:8080/wake')).toBeNull()
    expect(forwardUrlProblem('http://127.0.0.1:9/x')).toBeNull()
    expect(forwardUrlProblem('http://[::1]:9/x')).toBeNull()
    expect(forwardUrlProblem('https://hooks.example.com/agentchat')).toBeNull()
    expect(forwardUrlProblem('http://example.com/wake')).toMatch(/only to this machine/)
    expect(forwardUrlProblem('http://10.0.0.5/wake')).toMatch(/only to this machine/)
    expect(forwardUrlProblem('https://user:pw@example.com/')).toMatch(/credentials/)
    expect(forwardUrlProblem('ftp://localhost/')).toMatch(/unsupported/)
    expect(forwardUrlProblem('not a url')).toMatch(/not a URL/)
  })

  it('the secret is created once, owner-only, and is a valid wake secret', () => {
    const secret = ensureForwardSecret(identity.home)
    expect(secret).toMatch(/^[\x21-\x7e]{16,256}$/)
    expect(ensureForwardSecret(identity.home)).toBe(secret)
    expect(readForwardSecret(identity.home)).toBe(secret)
    if (process.platform !== 'win32') expect(fs.statSync(forwardSecretPath(identity.home)).mode & 0o777).toBe(0o600)
  })

  it('the payload carries counts and handles only — never a preview', () => {
    const payload = buildWakePayload({
      handle: 'probe',
      cards: [
        { conversation_id: 'conv_1', unread: 2, last_sender: '@alice', preview: { text: 'SECRET BODY' } } as never,
        { conversation_id: 'conv_2', unread: 0, last_sender: '@bob' },
      ],
      deliveryId: '00000000-0000-4000-8000-000000000001',
      now: new Date('2026-11-08T00:00:00Z'),
    })
    expect(payload).toEqual({
      version: 1,
      type: 'agentchat.wake',
      handle: '@probe',
      conversations: [{ id: 'conv_1', unread: 2, latest_sender: '@alice' }],
      summary: 'AgentChat wake for @probe: @alice: 2 unread in conv_1.',
      delivery_id: '00000000-0000-4000-8000-000000000001',
      ts: '2026-11-08T00:00:00.000Z',
    })
    expect(JSON.stringify(payload)).not.toContain('SECRET BODY')
  })
})

describe('ForwardRunner — one POST per wake, agentchat dialect', () => {
  let server: http.Server
  let url: string
  let answer: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void
  const seen: Array<{ headers: http.IncomingHttpHeaders; body: string; path: string }> = []

  beforeEach(async () => {
    seen.length = 0
    answer = (_req, res) => {
      res.statusCode = 204
      res.end()
    }
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        seen.push({ headers: req.headers, body, path: req.url ?? '' })
        answer(req, res, body)
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no address')
    url = `http://127.0.0.1:${address.port}/hooks/agentchat`
  })
  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  })

  const forwarder = (extra: Partial<ConstructorParameters<typeof ForwardRunner>[0]> = {}) =>
    new ForwardRunner({
      url,
      handle: 'probe',
      home: identity.home,
      tray: async () => ({ conversations: [{ conversation_id: 'conv_9', unread: 1, last_sender: '@peer' } as never] }),
      ...extra,
    })

  it('a 2xx is ok: Bearer from the secret file, delivery id = the run id, the payload from the tray counts', async () => {
    const runner = forwarder()
    await runner.preflight()
    const outcome = await runner.start({ kind: 'wake', prompt: 'ignored', runId: '11111111-1111-4111-8111-111111111111', budgetMs: 10_000 })
    expect(outcome.state).toBe('ok')
    expect(seen).toHaveLength(1)
    const [hit] = seen
    expect(hit?.path).toBe('/hooks/agentchat')
    expect(hit?.headers['authorization']).toBe(`Bearer ${readForwardSecret(identity.home)}`)
    expect(hit?.headers['x-agentchat-delivery']).toBe('11111111-1111-4111-8111-111111111111')
    expect(hit?.headers['x-agentchat-attempt']).toBe('1')
    expect(JSON.parse(hit?.body ?? '{}')).toMatchObject({ version: 1, type: 'agentchat.wake', handle: '@probe', conversations: [{ id: 'conv_9', unread: 1, latest_sender: '@peer' }] })
    expect(hit?.body).not.toContain('ignored')
  })

  it('a 5xx is failed; a redirect is not followed (the bearer stays where the owner pointed it)', async () => {
    answer = (_req, res) => {
      res.statusCode = 503
      res.end('down')
    }
    expect((await forwarder().start({ kind: 'wake', prompt: '', runId: 'a', budgetMs: 10_000 })).state).toBe('failed')
    answer = (_req, res) => {
      res.statusCode = 307
      res.setHeader('location', 'https://elsewhere.example/steal')
      res.end()
    }
    const redirected = await forwarder().start({ kind: 'wake', prompt: '', runId: 'b', budgetMs: 10_000 })
    expect(redirected).toMatchObject({ state: 'failed', exitCode: 307 })
    expect(redirected.detail).toMatch(/redirects are not followed/)
    expect(seen).toHaveLength(2)
  })

  it('nothing listening is NOT STARTED; no answer in time is TIMED OUT; a tray that fails still forwards the wake', async () => {
    const closed = new ForwardRunner({ url: 'http://127.0.0.1:9/none', handle: 'probe', home: identity.home, tray: async () => ({ conversations: [] }) })
    expect((await closed.start({ kind: 'wake', prompt: '', runId: 'c', budgetMs: 10_000 })).state).toBe('not_started')

    answer = () => undefined // never answers
    const slow = await forwarder({ timeoutMs: 200 }).start({ kind: 'wake', prompt: '', runId: 'd', budgetMs: 10_000 })
    expect(slow.state).toBe('timed_out')

    answer = (_req, res) => {
      res.statusCode = 200
      res.end()
    }
    const blind = await forwarder({ tray: async () => Promise.reject(new Error('503')) }).start({ kind: 'wake', prompt: '', runId: 'e', budgetMs: 10_000 })
    expect(blind.state).toBe('ok')
    expect(JSON.parse(seen[seen.length - 1]?.body ?? '{}')).toMatchObject({ conversations: [], summary: expect.stringContaining('new activity') })
  })

  it('refuses an address the rules do not allow, at construction', () => {
    expect(() => new ForwardRunner({ url: 'http://example.com/x', handle: 'p', home: identity.home, tray: async () => ({ conversations: [] }) })).toThrow(/only to this machine/)
  })
})

describe('listener.json', () => {
  it('round-trips each mode, owner-only; a broken file says why; the description never carries a key', () => {
    const base = { version: 1 as const, workdir: identity.workdir, updated_at: '2026-11-08T00:00:00Z' }
    const run = writeListenerConfig(identity.home, { ...base, mode: 'run', command: 'my-agent --once' })
    expect(run).toMatchObject({ mode: 'run', with_key: false })
    expect(readListenerConfig(identity.home)).toEqual({ ok: true, config: run })
    if (process.platform !== 'win32') expect(fs.statSync(listenerConfigPath(identity.home)).mode & 0o777).toBe(0o600)
    expect(describeListenerConfig(run)).toBe(`runs \`my-agent --once\` in ${identity.workdir}`)

    const preset = writeListenerConfig(identity.home, { ...base, mode: 'preset', preset: 'codex' })
    expect(preset).toMatchObject({ profile: 'answer' })
    const forward = writeListenerConfig(identity.home, { ...base, mode: 'forward', url: 'http://localhost:1/x' })
    expect(describeListenerConfig(forward)).toBe('forwards each wake to http://localhost:1/x')

    fs.writeFileSync(listenerConfigPath(identity.home), JSON.stringify({ version: 1, mode: 'run', workdir: '/w', updated_at: 'x' }))
    const broken = readListenerConfig(identity.home)
    expect(broken.ok).toBe(false)
    if (!broken.ok) expect(broken.error).toMatch(/command/)
    expect(() => writeListenerConfig(identity.home, { ...base, mode: 'run', command: '   ' })).toThrow()
  })
})
