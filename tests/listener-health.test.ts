import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { acquirePidLock, holderAlive, parseHolder, processStartedAt, PROCESS_STARTED_AT } from '../src/util/pid-lock.js'
import { acquireAgentLock, agentLockDir, agentLockPath, AGENT_LOCK_DIR_ENV } from '../src/daemon/agent-lock.js'
import { acquireLeaderLock } from '../src/daemon/leader-lock.js'
import { runIntegration } from '../src/integration/run.js'
import { Integration } from '../src/integration/integration.js'
import { formatIntegrationStatus, readIntegrationStatus } from '../src/integration/status.js'
import { runProbe } from '../src/util/probe.js'
import { claudeIsLoggedIn, inspectClaudeRuntime, inspectCodexRuntime, codexIsLoggedIn } from '../src/presets/index.js'
import type { RunOutcome, RunPreflight, RunRequest, RunRunner } from '../src/integration/runner.js'
import { installFakeClaude, installFakeCodex } from './helpers/fake-runtimes.js'
import { startServerDouble, until, type ServerDouble } from './helpers/server-double.js'

// ─── Listener health and single ownership ───────────────────────────────────
//
//   1  runs that keep failing for a runtime reason are said in status and
//      doctor (the runtime is re-checked, at most once per window), and cleared
//      by the next run that succeeds
//   2  one agent, one listener: the agent lock, taken atomically, stale ones
//      taken over atomically; a second listener stands by and takes over
//   3  probes are killed with their whole tree when they hang

const CLIENT = { runtime: 'generic' as const, version: '0.0.0-test' }
const KEY = 'ac_' + 'k'.repeat(40)

let sandbox: string
const originalPath = process.env['PATH']
beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-health-'))
})
afterEach(() => {
  process.env['PATH'] = originalPath
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

/** Whether a process is alive (signal 0 tests existence on POSIX and Windows). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** A process that has exited: its pid is a dead holder. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf-8' })
  return Number(r.stdout)
}

/** A process that keeps running until killed. */
function sleeper(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' })
}

// ─── 2a. the lock primitive ─────────────────────────────────────────────────

describe('the pid lock: O_EXCL, its holder named by pid and start time, stale ones taken over atomically', () => {
  it('acquired once; a second attempt is refused naming the holder; released, it can be taken again', () => {
    const file = path.join(sandbox, 'x.lock')
    const a = acquirePidLock(file, { home: '/h1', label: '@me' })
    expect(a.ok).toBe(true)
    const holder = parseHolder(fs.readFileSync(file, 'utf-8'))
    expect(holder).toMatchObject({ pid: process.pid, started_at: PROCESS_STARTED_AT, home: '/h1', label: '@me' })
    if (posix()) expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(acquirePidLock(file)).toMatchObject({ ok: false, holder: { pid: process.pid, home: '/h1' } })
    if (a.ok) a.lock.release()
    expect(fs.existsSync(file)).toBe(false)
    expect(acquirePidLock(file).ok).toBe(true)
  })

  it('release never removes a lock that is no longer this process\'s', () => {
    const file = path.join(sandbox, 'x.lock')
    const a = acquirePidLock(file)
    fs.writeFileSync(file, JSON.stringify({ pid: 4242, started_at: 1 }))
    if (a.ok) a.lock.release()
    expect(fs.readFileSync(file, 'utf-8')).toContain('4242')
  })

  it('a dead holder, a reused pid (another start time) and an old bare-pid lock of a dead process are stale; a live bare pid is not', () => {
    const file = path.join(sandbox, 'x.lock')
    fs.writeFileSync(file, JSON.stringify({ pid: deadPid(), started_at: Date.now() - 1000 }))
    expect(acquirePidLock(file).ok).toBe(true)
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, started_at: PROCESS_STARTED_AT - 3_600_000 }))
    expect(acquirePidLock(file).ok).toBe(true)
    fs.writeFileSync(file, String(deadPid()))
    expect(acquirePidLock(file).ok).toBe(true)
    const live = sleeper()
    try {
      fs.writeFileSync(file, String(live.pid))
      expect(acquirePidLock(file)).toMatchObject({ ok: false, holder: { pid: live.pid, started_at: null } })
    } finally {
      live.kill('SIGKILL')
    }
  })

  it('a live process is the holder only with its own start time: a recorded start an hour off is a reused pid', async () => {
    const live = sleeper()
    try {
      await until(() => processStartedAt(live.pid ?? 0) !== null, 15_000)
      const started = processStartedAt(live.pid ?? 0)
      expect(started).not.toBeNull()
      expect(Math.abs((started ?? 0) - Date.now())).toBeLessThan(60_000)
      expect(holderAlive({ pid: live.pid ?? 0, started_at: started })).toBe(true)
      expect(holderAlive({ pid: live.pid ?? 0, started_at: (started ?? 0) - 3_600_000 })).toBe(false)
    } finally {
      live.kill('SIGKILL')
    }
  }, 30_000)

  it('a file being written (unparseable, fresh) is not taken; an old unparseable one is', () => {
    const file = path.join(sandbox, 'x.lock')
    fs.writeFileSync(file, '')
    expect(acquirePidLock(file).ok).toBe(false)
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(file, old, old)
    expect(acquirePidLock(file).ok).toBe(true)
  })

  it.skipIf(!stripTypes())('many processes taking over one stale lock at once: exactly one wins', async () => {
    const file = path.join(sandbox, 'race.lock')
    const go = path.join(sandbox, 'go')
    const out = path.join(sandbox, 'results.jsonl')
    const done = path.join(sandbox, 'done')
    fs.writeFileSync(file, JSON.stringify({ pid: deadPid(), started_at: 1 }))
    const lib = pathToFileURL(path.join(__dirname, '..', 'src', 'util', 'pid-lock.ts')).href
    const script = [
      "const fs = require('node:fs')",
      'const [lib, file, go, out, done] = process.argv.slice(1)',
      'import(lib).then((m) => {',
      '  while (!fs.existsSync(go)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1)',
      "  const r = m.acquirePidLock(file, { label: 'race' })",
      "  fs.appendFileSync(out, JSON.stringify({ pid: process.pid, ok: r.ok }) + '\\n')",
      // Every contender stays alive until all have answered: a holder that left
      // early would be a stale lock the slower ones may rightly take over.
      '  const poll = setInterval(() => { if (fs.existsSync(done)) { clearInterval(poll); process.exit(0) } }, 20)',
      '})',
    ].join('\n')
    const kids = Array.from({ length: 8 }, () => spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '-e', script, lib, file, go, out, done], { stdio: 'ignore' }))
    await new Promise((r) => setTimeout(r, 1500))
    fs.writeFileSync(go, '')
    await until(() => fs.existsSync(out) && fs.readFileSync(out, 'utf-8').trim().split('\n').length === 8, 60_000)
    const results = fs.readFileSync(out, 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as { pid: number; ok: boolean })
    fs.writeFileSync(done, '')
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    const winner = results.find((r) => r.ok)?.pid
    expect(parseHolder(fs.readFileSync(file, 'utf-8'))?.pid).toBe(winner)
    await Promise.all(kids.map((k) => new Promise((r) => (k.exitCode !== null ? r(null) : k.once('exit', r)))))
  }, 90_000)

  it('the home lock (leader lock) is the same primitive', () => {
    const home = path.join(sandbox, 'home')
    const a = acquireLeaderLock(home)
    expect(a).not.toBeNull()
    expect(acquireLeaderLock(home)).toBeNull()
    a?.release()
    fs.writeFileSync(path.join(home, 'daemon.lock'), String(deadPid())) // an older release's stale lock
    expect(acquireLeaderLock(home)).not.toBeNull()
  })
})

function posix(): boolean {
  return process.platform !== 'win32'
}

/** Node runs TypeScript with type stripping (22.6+): the race test's children import the lock module itself. */
function stripTypes(): boolean {
  return spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '-e', '1']).status === 0
}

// ─── 2b. one agent, one listener ────────────────────────────────────────────

describe('the agent lock: one per agent, in a per-user folder, named by a hash of the API origin and the handle', () => {
  it('the folder per platform (from the home folder only), and its override', () => {
    expect(agentLockDir({}, 'darwin', '/Users/a')).toBe('/Users/a/Library/Application Support/AgentChat/locks')
    expect(agentLockDir({}, 'linux', '/home/a')).toBe('/home/a/.local/state/agentchat/locks')
    expect(agentLockDir({ XDG_STATE_HOME: '/elsewhere' }, 'linux', '/home/a')).toBe('/home/a/.local/state/agentchat/locks')
    expect(agentLockDir({}, 'win32', 'C:\\Users\\a')).toBe('C:\\Users\\a\\AppData\\Local\\AgentChat\\locks')
    expect(agentLockDir({ [AGENT_LOCK_DIR_ENV]: path.join(sandbox, 'l') }, 'linux', '/home/a')).toBe(path.join(sandbox, 'l'))
  })

  it('the same agent however spelled; another agent or server elsewhere; never the key', () => {
    const env = { [AGENT_LOCK_DIR_ENV]: sandbox }
    const a = agentLockPath({ apiBase: 'https://api.agentchat.me', handle: 'probe' }, env)
    expect(agentLockPath({ apiBase: 'https://API.agentchat.me/', handle: '@Probe' }, env)).toBe(a)
    expect(agentLockPath({ apiBase: 'https://api.agentchat.me', handle: 'other' }, env)).not.toBe(a)
    expect(agentLockPath({ apiBase: 'http://127.0.0.1:9', handle: 'probe' }, env)).not.toBe(a)
    expect(path.basename(a)).toMatch(/^agent-[0-9a-f]{32}\.lock$/)
    const held = acquireAgentLock({ apiBase: 'https://api.agentchat.me', handle: 'probe', home: '/h1' }, env)
    expect(held.ok).toBe(true)
    expect(fs.readFileSync(a, 'utf-8')).not.toContain(KEY)
    expect(acquireAgentLock({ apiBase: 'https://api.agentchat.me', handle: 'probe', home: '/h2' }, env)).toMatchObject({ ok: false, holder: { home: path.resolve('/h1'), label: '@probe' } })
    if (held.ok) held.lock.release()
  })

  it('two homes holding one agent\'s key: the first serves it, the second stands by naming the first home and takes over when it stops', async () => {
    const double = await startServerDouble({ tray: { waiting: 0 } })
    const home1 = path.join(sandbox, 'cli-home')
    const home2 = path.join(sandbox, 'integration-home')
    for (const h of [home1, home2]) {
      fs.mkdirSync(h, { recursive: true })
      fs.writeFileSync(path.join(h, 'credentials'), JSON.stringify({ api_key: KEY, handle: 'probe', api_base: double.apiBase }))
    }
    const okRunner = (): RunRunner => ({ name: 'fake-runtime', preflight: async () => ({ ok: true }), start: async () => ({ state: 'ok', exitCode: 0, durationMs: 1 }) })
    const first = new AbortController()
    const second = new AbortController()
    const base = (home: string) => ({ home, client: CLIENT, manualPointer: '(POINTER)', workdir: path.join(home, 'w'), env: {}, standbyPollMs: 300 })
    const a = runIntegration({ ...base(home1), runner: okRunner(), signal: first.signal })
    try {
      await until(() => readIntegrationStatus(home1)?.socket === 'ready', 10_000)
      const b = runIntegration({ ...base(home2), runner: okRunner(), signal: second.signal })
      try {
        await until(() => (readIntegrationStatus(home2)?.standby ?? null) !== null, 10_000)
        const standing = readIntegrationStatus(home2)
        expect(standing?.socket).toBe('idle')
        expect(standing?.standby).toMatchObject({ home: path.resolve(home1), pid: process.pid })
        expect(standing?.last_error).toContain(`is served by ${path.resolve(home1)}`)
        expect(formatIntegrationStatus(standing).join('\n')).toContain(`standby: ${path.resolve(home1)} (pid ${process.pid}) serves this agent`)
        // Only one socket for the agent: the standing-by daemon never connects.
        expect(double.served).toHaveLength(1)
        // The first stops: the second takes over.
        first.abort()
        expect(await a).toBe(0)
        await until(() => readIntegrationStatus(home2)?.socket === 'ready', 10_000)
        expect(readIntegrationStatus(home2)?.standby ?? null).toBeNull()
      } finally {
        second.abort()
        await b
      }
    } finally {
      first.abort()
      await a
      await double.close()
    }
  }, 40_000)
})

// ─── 1. runs failing, said plainly ──────────────────────────────────────────

class ScriptedRunner implements RunRunner {
  readonly name = 'claude'
  preflights = 0
  starts = 0
  constructor(
    public outcome: RunOutcome,
    public check: RunPreflight,
  ) {}
  async preflight(): Promise<RunPreflight> {
    this.preflights += 1
    return this.check
  }
  async start(_request: RunRequest): Promise<RunOutcome> {
    this.starts += 1
    return this.outcome
  }
}

describe('runs that keep failing for a runtime reason are said in status and doctor, and cleared by a run that succeeds', () => {
  let double: ServerDouble
  let home: string
  let integrations: Integration[]
  beforeEach(() => {
    home = path.join(sandbox, 'home')
    fs.mkdirSync(home, { recursive: true })
    integrations = []
  })
  afterEach(async () => {
    for (const i of integrations) await i.stopAndWait(5_000)
    await double.close()
  })
  const start = async (runner: RunRunner, recheckMs: number): Promise<Integration> => {
    const i = new Integration({
      cfg: { apiKey: KEY, handle: 'me', apiBase: double.apiBase, wsBase: double.wsBase, home, workdir: path.join(home, 'w') },
      runner,
      client: CLIENT,
      manualPointer: '(POINTER)',
      profile: 'answer',
      budgetMs: 60_000,
      quietMs: 50,
      maxMs: 200,
      runtimeRecheckMs: recheckMs,
    })
    integrations.push(i)
    await i.start()
    return i
  }
  const wake = (id: string): void => double.send({ type: 'message.new', payload: { id, conversation_id: 'conv_1', sender: 'peer', content: { text: 'x' } } })

  it('signed out after start: the next failed run re-checks, status and doctor say why, since when and how many runs were missed; a run that succeeds clears it', async () => {
    double = await startServerDouble({ tray: { waiting: 1 } })
    const runner = new ScriptedRunner({ state: 'ok', exitCode: 0, durationMs: 1 }, { ok: true })
    const i = await start(runner, 60_000)
    await until(() => runner.starts === 1, 5_000)
    expect(i.snapshot().runs_failing ?? null).toBeNull()
    // Signed out: the runs stop starting, and the runtime's own check says why.
    runner.outcome = { state: 'not_started', exitCode: 1, durationMs: 1, detail: 'exit 1 with nothing on stdout: Not logged in' }
    runner.check = { ok: false, detail: 'claude is not signed in (run `claude` once and sign in)' }
    const checksBefore = runner.preflights
    wake('m1')
    await until(() => runner.starts === 2, 5_000)
    await i.runtimeCheckSettled()
    const failing = i.snapshot().runs_failing
    expect(failing).toMatchObject({ reason: 'claude: claude is not signed in (run `claude` once and sign in)', runs_missed: 1 })
    expect(runner.preflights).toBe(checksBefore + 1)
    const status = readIntegrationStatus(home)
    expect(status?.socket).toBe('ready')
    const lines = formatIntegrationStatus(status).join('\n')
    expect(lines).toContain('Integration: socket ready — but runs are failing (below)')
    expect(lines).toMatch(/runs failing: claude: claude is not signed in \(run `claude` once and sign in\) — since .*, 1 run\(s\) missed/)
    // More failing wakes inside the window: counted, not re-checked each time.
    wake('m2')
    await until(() => runner.starts === 3, 5_000)
    wake('m3')
    await until(() => runner.starts === 4, 5_000)
    await until(() => i.snapshot().runs_failing?.runs_missed === 3, 3_000)
    expect(runner.preflights).toBe(checksBefore + 1)
    expect(i.snapshot().runs_not_started).toBe(3)
    // Signed in again: the next run succeeds and clears it.
    runner.outcome = { state: 'ok', exitCode: 0, durationMs: 1 }
    wake('m4')
    await until(() => runner.starts === 5, 5_000)
    await until(() => (i.snapshot().runs_failing ?? null) === null, 3_000)
    expect(formatIntegrationStatus(readIntegrationStatus(home)).join('\n')).not.toContain('runs failing')
  }, 30_000)

  it('the window passed: the next failure re-checks again (and a new reason replaces the old)', async () => {
    double = await startServerDouble({ tray: { waiting: 0 } })
    const runner = new ScriptedRunner({ state: 'not_started', exitCode: 127, durationMs: 1, detail: 'exit 127' }, { ok: true })
    const i = await start(runner, 200)
    // The binary is removed after the daemon started.
    runner.check = { ok: false, detail: 'claude CLI not found on PATH' }
    double.setTray({ waiting: 1 })
    await until(() => i.snapshot().socket === 'ready', 5_000)
    wake('m0')
    await until(() => runner.starts === 1, 5_000)
    await i.runtimeCheckSettled()
    expect(i.snapshot().runs_failing?.reason).toBe('claude: claude CLI not found on PATH')
    const checks = runner.preflights
    await new Promise((r) => setTimeout(r, 300))
    runner.check = { ok: false, detail: 'unknown option --permission-prompts' }
    wake('m1')
    await until(() => runner.starts === 2, 5_000)
    await i.runtimeCheckSettled()
    expect(runner.preflights).toBe(checks + 1)
    expect(i.snapshot().runs_failing).toMatchObject({ reason: 'claude: unknown option --permission-prompts', runs_missed: 2 })
  }, 20_000)

  it('a run that fails while the runtime checks out is not a runtime problem: nothing is claimed', async () => {
    double = await startServerDouble({ tray: { waiting: 1 } })
    const runner = new ScriptedRunner({ state: 'failed', exitCode: 1, durationMs: 1, detail: 'the model errored' }, { ok: true })
    const i = await start(runner, 60_000)
    await until(() => runner.starts === 1, 5_000)
    await i.runtimeCheckSettled()
    expect(i.snapshot().runs_failing ?? null).toBeNull()
  }, 20_000)
})

// ─── 3. probes ──────────────────────────────────────────────────────────────

describe('a probe that hangs is killed with everything it started, and answers', () => {
  const expectGone = (file: string): void => {
    const pids = JSON.parse(fs.readFileSync(file, 'utf-8')) as number[]
    expect(pids).toHaveLength(2)
    for (const pid of pids) expect(alive(pid), `pid ${pid} still alive`).toBe(false)
  }

  it('runProbe: a timeout kills the tree, waits for it to exit, and says it timed out', async () => {
    const pids = path.join(sandbox, 'pids.json')
    const script = [
      "const kid = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: ['ignore', 'inherit', 'inherit'] })",
      `require('node:fs').writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, kid.pid]))`,
      'setTimeout(() => {}, 600000)',
    ].join('\n')
    const startedAt = Date.now()
    const result = await runProbe(process.execPath, ['-e', script], { timeoutMs: 1_500 })
    expect(result.timedOut).toBe(true)
    expect(result.error?.message).toMatch(/did not answer within 2 s|did not answer within 1 s/)
    expect(Date.now() - startedAt).toBeLessThan(10_000)
    expectGone(pids)
  }, 20_000)

  it('runProbe: an ordinary command answers with its exit code and output', async () => {
    const r = await runProbe(process.execPath, ['-e', "process.stdout.write('v1'); process.exit(3)"], { timeoutMs: 10_000 })
    expect(r).toMatchObject({ timedOut: false, status: 3, stdout: 'v1' })
    const missing = await runProbe(path.join(sandbox, 'no-such-binary'), ['--version'], { timeoutMs: 5_000 })
    expect(missing.error).toBeDefined()
    expect(missing.timedOut).toBe(false)
  })

  for (const [label, install, probe] of [
    ['claude --version', installFakeClaude, (cmd: string) => inspectClaudeRuntime(path.join(sandbox, '.claude'), cmd, 1_500)],
    ['claude auth status', installFakeClaude, (cmd: string) => claudeIsLoggedIn(path.join(sandbox, '.claude'), cmd, 1_500)],
    ['codex --version', installFakeCodex, (cmd: string) => inspectCodexRuntime(path.join(sandbox, '.codex'), cmd, 1_500)],
    ['codex login status', installFakeCodex, (cmd: string) => codexIsLoggedIn(path.join(sandbox, '.codex'), cmd, 1_500)],
  ] as const) {
    it(`${label} that hangs (through the .cmd shim on Windows): answered, and its whole tree gone`, async () => {
      const fake = install(sandbox)
      const pids = path.join(sandbox, 'probe-pids.json')
      process.env['PATH'] = `${fake.binDir}${path.delimiter}${originalPath ?? ''}`
      process.env['FAKE_RUNTIME_PROBE_HANG'] = label.endsWith('--version') ? 'version' : 'auth'
      process.env['FAKE_RUNTIME_PROBE_PIDS'] = pids
      try {
        const cmd = label.startsWith('claude') ? 'claude' : 'codex'
        const answer = await probe(cmd)
        if (typeof answer === 'boolean') expect(answer).toBe(false)
        else expect(answer).toMatchObject({ ok: false, detail: expect.stringMatching(/did not answer within/) })
        expectGone(pids)
      } finally {
        delete process.env['FAKE_RUNTIME_PROBE_HANG']
        delete process.env['FAKE_RUNTIME_PROBE_PIDS']
      }
    }, 30_000)
  }
})
