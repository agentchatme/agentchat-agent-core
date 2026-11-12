import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { acquireLease, holderLive, parseLease, pidAlive, type LeaseHolder } from '../src/util/lease.js'
import { acquireAgentLock, agentLockDir, agentLockPath, AGENT_LOCK_DIR_ENV } from '../src/daemon/agent-lock.js'
import { acquireLeaderLock } from '../src/daemon/leader-lock.js'
import { lockedDaemonPid } from '../src/daemon/service.js'
import { runIntegration } from '../src/integration/run.js'
import { Integration } from '../src/integration/integration.js'
import { formatIntegrationStatus, readIntegrationStatus } from '../src/integration/status.js'
import { runProbe } from '../src/util/probe.js'
import { claudeIsLoggedIn, claudeSignIn, inspectClaudeRuntime, inspectCodexRuntime, codexIsLoggedIn } from '../src/presets/index.js'
import type { RunOutcome, RunPreflight, RunPreflightOptions, RunRequest, RunRunner } from '../src/integration/runner.js'
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

// ─── 2a. the lock primitive: a lease ────────────────────────────────────────

/** A pid that exists but this user may not signal (EPERM): init on POSIX, System on Windows. */
const EPERM_PID = process.platform === 'win32' ? 4 : 1

/** A lease file as another process (or another host) would have written it. */
function leaseFile(file: string, h: { pid: number; renewed_at: number; host?: string; token?: string; home?: string }): string {
  const content = `${h.pid}\n${JSON.stringify({ pid: h.pid, token: h.token ?? 'their-token', host: h.host ?? os.hostname(), home: h.home ?? '/their/home', acquired_at: new Date(h.renewed_at).toISOString(), renewed_at: h.renewed_at })}\n`
  fs.writeFileSync(file, content)
  return content
}

/** The leader lock of agent-core 0.4.1 and earlier, verbatim in behaviour: what an old daemon does with a new lock. */
function oldAcquireLeaderLock(home: string): 'acquired' | 'refused' | 'stole' {
  const lockPath = path.join(home, 'daemon.lock')
  try {
    const fd = fs.openSync(lockPath, 'wx')
    fs.writeSync(fd, String(process.pid))
    fs.closeSync(fd)
    return 'acquired'
  } catch {
    /* exists */
  }
  let holderPid = 0
  try {
    holderPid = Number.parseInt(fs.readFileSync(lockPath, 'utf-8').trim(), 10)
  } catch {
    /* unreadable */
  }
  if (holderPid && pidAlive(holderPid)) return 'refused'
  fs.writeFileSync(lockPath, String(process.pid))
  return 'stole'
}

describe('the lease: O_EXCL, the bare pid first, renewed by its holder, taken over under a guard when it is stale', () => {
  it('the file: the bare pid on its first line (what older readers parse), then the lease; refused while held; released, it can be taken again', async () => {
    const file = path.join(sandbox, 'x.lock')
    const a = await acquireLease(file, { home: '/h1', label: '@me' })
    expect(a.ok).toBe(true)
    const raw = fs.readFileSync(file, 'utf-8')
    expect(Number.parseInt(raw.trim(), 10)).toBe(process.pid)
    expect(raw.split('\n')[0]).toBe(String(process.pid))
    expect(parseLease(raw)).toMatchObject({ pid: process.pid, host: os.hostname(), home: '/h1', label: '@me', token: expect.any(String), renewed_at: expect.any(Number) })
    if (posix()) expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(await acquireLease(file)).toMatchObject({ ok: false, holder: { pid: process.pid, home: '/h1' } })
    if (a.ok) a.lease.release()
    expect(fs.existsSync(file)).toBe(false)
    const again = await acquireLease(file)
    expect(again.ok).toBe(true)
    if (again.ok) again.lease.release()
  })

  it('old readers: the service reinstall finds the pid (both formats), and a 0.4.x daemon refuses a live lease instead of stealing it', async () => {
    const home = path.join(sandbox, 'home')
    const held = await acquireLeaderLock(home)
    expect(held).not.toBeNull()
    expect(lockedDaemonPid(home)).toBe(process.pid)
    expect(oldAcquireLeaderLock(home)).toBe('refused')
    expect(parseLease(fs.readFileSync(path.join(home, 'daemon.lock'), 'utf-8'))?.token).toBeTruthy() // untouched
    held?.release()
    fs.writeFileSync(path.join(home, 'daemon.lock'), '4242')
    expect(lockedDaemonPid(home)).toBe(4242)
  })

  it('liveness: a dead pid here is gone at once; a live pid that stopped renewing (a reboot reused it) is gone; EPERM with a fresh lease is held, with a stale one is not', () => {
    const now = Date.now()
    const live = sleeper()
    try {
      const h = (pid: number, renewed: number, host?: string): LeaseHolder => ({ pid, token: 't', host: host ?? os.hostname(), renewed_at: renewed })
      expect(holderLive(h(deadPid(), now), now)).toBe(false)
      expect(holderLive(h(live.pid ?? 0, now - 1_000), now)).toBe(true)
      expect(holderLive(h(live.pid ?? 0, now - 120_000), now)).toBe(false) // reboot-stale: alive pid, no renewal
      expect(pidAlive(EPERM_PID)).toBe(true)
      expect(holderLive(h(EPERM_PID, now - 1_000), now)).toBe(true)
      expect(holderLive(h(EPERM_PID, now - 120_000), now)).toBe(false) // reused by an elevated process
      // Another host: its pid means nothing here; the lease alone decides.
      expect(holderLive(h(deadPid(), now - 1_000, 'other-host'), now)).toBe(true)
      expect(holderLive(h(deadPid(), now - 120_000, 'other-host'), now)).toBe(false)
      // A lock from before leases: its pid alone.
      expect(holderLive({ pid: live.pid ?? 0, token: null, host: null, renewed_at: null }, now)).toBe(true)
      expect(holderLive({ pid: deadPid(), token: null, host: null, renewed_at: null }, now)).toBe(false)
    } finally {
      live.kill('SIGKILL')
    }
  })

  it('no local time anywhere: the US fall-back hour (01:00–02:00 twice) does not make a fresh lease look stale', () => {
    const prev = process.env['TZ']
    process.env['TZ'] = 'America/New_York'
    try {
      // 2026-11-01 05:30Z is 01:30 EDT; an hour later is 01:30 EST.
      const renewed = Date.UTC(2026, 10, 1, 5, 30)
      const live = sleeper()
      try {
        expect(holderLive({ pid: live.pid ?? 0, token: 't', host: os.hostname(), renewed_at: renewed }, renewed + 20_000)).toBe(true)
        expect(holderLive({ pid: live.pid ?? 0, token: 't', host: os.hostname(), renewed_at: renewed }, renewed + 3_600_000)).toBe(false)
      } finally {
        live.kill('SIGKILL')
      }
    } finally {
      if (prev === undefined) delete process.env['TZ']
      else process.env['TZ'] = prev
    }
  })

  it('taken over: a dead holder, a stale lease of a live pid, a stale EPERM pid, an old bare pid of a dead process; refused: a fresh lease, a live bare pid', async () => {
    const file = path.join(sandbox, 'x.lock')
    const take = async (): Promise<boolean> => {
      const r = await acquireLease(file)
      if (r.ok) r.lease.release()
      return r.ok
    }
    const live = sleeper()
    try {
      leaseFile(file, { pid: deadPid(), renewed_at: Date.now() })
      expect(await take()).toBe(true)
      leaseFile(file, { pid: live.pid ?? 0, renewed_at: Date.now() - 120_000 })
      expect(await take()).toBe(true)
      leaseFile(file, { pid: EPERM_PID, renewed_at: Date.now() - 120_000 })
      expect(await take()).toBe(true)
      fs.writeFileSync(file, String(deadPid()))
      expect(await take()).toBe(true)
      leaseFile(file, { pid: live.pid ?? 0, renewed_at: Date.now() })
      expect(await acquireLease(file)).toMatchObject({ ok: false, holder: { pid: live.pid, home: '/their/home' } })
      fs.writeFileSync(file, String(live.pid))
      expect(await acquireLease(file)).toMatchObject({ ok: false, holder: { pid: live.pid, renewed_at: null } })
    } finally {
      live.kill('SIGKILL')
    }
  })

  it('renewed while held; a holder that finds its lease replaced, or removed, stands down at once', async () => {
    const file = path.join(sandbox, 'x.lock')
    const a = await acquireLease(file, {}, { renewMs: 50 })
    if (!a.ok) throw new Error('not acquired')
    const first = parseLease(fs.readFileSync(file, 'utf-8'))?.renewed_at ?? 0
    await until(() => (parseLease(fs.readFileSync(file, 'utf-8'))?.renewed_at ?? 0) > first, 2_000)
    let why: string | null = null
    a.lease.onLost((w) => {
      why = w
    })
    leaseFile(file, { pid: process.pid, renewed_at: Date.now(), token: 'someone-else' })
    await until(() => why !== null, 2_000)
    expect(a.lease.lost).toBe(true)
    expect(why).toMatch(/names another holder/)
    // The replacement is not touched by the old holder.
    expect(parseLease(fs.readFileSync(file, 'utf-8'))?.token).toBe('someone-else')
    fs.rmSync(file)
    const b = await acquireLease(file, {}, { renewMs: 50 })
    if (!b.ok) throw new Error('not acquired')
    let gone: string | null = null
    b.lease.onLost((w) => {
      gone = w
    })
    fs.rmSync(file)
    await until(() => gone !== null, 2_000)
    expect(gone).toMatch(/was removed/)
  })

  it('a file being written (unparseable, fresh) is not taken; an old unparseable one is', async () => {
    const file = path.join(sandbox, 'x.lock')
    fs.writeFileSync(file, '')
    expect((await acquireLease(file)).ok).toBe(false)
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(file, old, old)
    const r = await acquireLease(file)
    expect(r.ok).toBe(true)
    if (r.ok) r.lease.release()
  })

  it('contended past every attempt (a live takeover in progress): no holder is named — never a dead one', async () => {
    const file = path.join(sandbox, 'x.lock')
    const live = sleeper()
    try {
      leaseFile(file, { pid: deadPid(), renewed_at: Date.now(), home: '/dead/home' })
      leaseFile(`${file}.takeover`, { pid: live.pid ?? 0, renewed_at: Date.now() })
      const r = await acquireLease(file)
      expect(r).toMatchObject({ ok: false, holder: null })
    } finally {
      live.kill('SIGKILL')
    }
  })

  it.skipIf(!stripTypes())('many processes taking over one stale lease at once: exactly one wins', async () => {
    const file = path.join(sandbox, 'race.lock')
    const go = path.join(sandbox, 'go')
    const out = path.join(sandbox, 'results.jsonl')
    const done = path.join(sandbox, 'done')
    leaseFile(file, { pid: deadPid(), renewed_at: Date.now() })
    const lib = pathToFileURL(path.join(__dirname, '..', 'src', 'util', 'lease.ts')).href
    const script = [
      "const fs = require('node:fs')",
      'const [lib, file, go, out, done] = process.argv.slice(1)',
      'import(lib).then(async (m) => {',
      '  while (!fs.existsSync(go)) await new Promise((r) => setTimeout(r, 1))',
      "  const r = await m.acquireLease(file, { label: 'race' })",
      "  fs.appendFileSync(out, JSON.stringify({ pid: process.pid, ok: r.ok }) + '\\n')",
      // Every contender stays alive until all have answered.
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
    expect(parseLease(fs.readFileSync(file, 'utf-8'))?.pid).toBe(results.find((r) => r.ok)?.pid)
    await Promise.all(kids.map((k) => new Promise((r) => (k.exitCode !== null ? r(null) : k.once('exit', r)))))
  }, 90_000)

  it('the home lock (leader lock) is the same lease; an older release\'s stale bare-pid lock is taken over', async () => {
    const home = path.join(sandbox, 'home')
    const a = await acquireLeaderLock(home)
    expect(a).not.toBeNull()
    expect(await acquireLeaderLock(home)).toBeNull()
    a?.release()
    fs.writeFileSync(path.join(home, 'daemon.lock'), String(deadPid()))
    const b = await acquireLeaderLock(home)
    expect(b).not.toBeNull()
    b?.release()
  })
})

function posix(): boolean {
  return process.platform !== 'win32'
}

/** Node runs TypeScript with type stripping (22.6+): the race test's children import the lease module itself. */
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

  it('the same agent however spelled; another agent or server elsewhere; never the key', async () => {
    const env = { [AGENT_LOCK_DIR_ENV]: sandbox }
    const a = agentLockPath({ apiBase: 'https://api.agentchat.me', handle: 'probe' }, env)
    expect(agentLockPath({ apiBase: 'https://API.agentchat.me/', handle: '@Probe' }, env)).toBe(a)
    expect(agentLockPath({ apiBase: 'https://api.agentchat.me', handle: 'other' }, env)).not.toBe(a)
    expect(agentLockPath({ apiBase: 'http://127.0.0.1:9', handle: 'probe' }, env)).not.toBe(a)
    expect(path.basename(a)).toMatch(/^agent-[0-9a-f]{32}\.lock$/)
    const held = await acquireAgentLock({ apiBase: 'https://api.agentchat.me', handle: 'probe', home: '/h1' }, env)
    expect(held.ok).toBe(true)
    expect(fs.readFileSync(a, 'utf-8')).not.toContain(KEY)
    expect(await acquireAgentLock({ apiBase: 'https://api.agentchat.me', handle: 'probe', home: '/h2' }, env)).toMatchObject({ ok: false, holder: { home: path.resolve('/h1'), label: '@probe' } })
    if (held.ok) held.lease.release()
  })
})

/** Two daemons, one agent: the supervisor-level cases. */
describe('one agent, one listener: the supervisor', () => {
  let double: ServerDouble
  const okRunner = (): RunRunner => ({ name: 'fake-runtime', preflight: async () => ({ ok: true }), start: async () => ({ state: 'ok', exitCode: 0, durationMs: 1 }) })
  const signIn = (home: string, key: string, apiBase: string, handle: string | null = 'probe'): void => {
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'credentials'), JSON.stringify({ api_key: key, ...(handle !== null ? { handle } : {}), api_base: apiBase }))
  }
  const daemon = (home: string, runner: RunRunner, extra: Record<string, unknown> = {}) => {
    const controller = new AbortController()
    const done = runIntegration({ home, client: CLIENT, manualPointer: '(POINTER)', workdir: path.join(home, 'w'), env: {}, standbyPollMs: 200, unservableRecheckMs: 300, lease: { renewMs: 100 }, runner, signal: controller.signal, ...extra })
    return { stop: async () => { controller.abort(); return done }, done }
  }
  afterEach(async () => {
    await double?.close()
  })

  it('two homes holding one agent\'s key: the first serves it, the second stands by naming the first home (status rewritten every poll) and takes over when it stops', async () => {
    double = await startServerDouble({ tray: { waiting: 0 } })
    const home1 = path.join(sandbox, 'cli-home')
    const home2 = path.join(sandbox, 'integration-home')
    signIn(home1, KEY, double.apiBase)
    signIn(home2, KEY, double.apiBase)
    const a = daemon(home1, okRunner())
    await until(() => readIntegrationStatus(home1)?.socket === 'ready', 10_000)
    const b = daemon(home2, okRunner())
    try {
      await until(() => (readIntegrationStatus(home2)?.standby ?? null) !== null, 10_000)
      const standing = readIntegrationStatus(home2)
      expect(standing?.socket).toBe('idle')
      expect(standing?.standby).toMatchObject({ home: path.resolve(home1), pid: process.pid })
      expect(standing?.last_error).toContain(`is served by ${path.resolve(home1)}`)
      expect(formatIntegrationStatus(standing).join('\n')).toContain(`standby: ${path.resolve(home1)} (pid ${process.pid}) serves this agent`)
      // Rewritten every poll: never "the daemon may be down".
      const t0 = standing?.updated_at ?? ''
      await until(() => (readIntegrationStatus(home2)?.updated_at ?? '') > t0, 3_000)
      expect(double.served).toHaveLength(1)
      expect(await a.stop()).toBe(0)
      await until(() => readIntegrationStatus(home2)?.socket === 'ready', 10_000)
      expect(readIntegrationStatus(home2)?.standby ?? null).toBeNull()
    } finally {
      await a.stop()
      await b.stop()
    }
  }, 40_000)

  it('the holder whose key the server now refuses (rotated by recover in the other home) gives the agent up; the healthy standby takes over', async () => {
    double = await startServerDouble({ tray: { waiting: 0 } })
    const oldKey = 'ac_' + 'o'.repeat(40)
    const newKey = 'ac_' + 'n'.repeat(40)
    const home1 = path.join(sandbox, 'stale-home')
    const home2 = path.join(sandbox, 'recovered-home')
    signIn(home1, oldKey, double.apiBase)
    signIn(home2, newKey, double.apiBase)
    const a = daemon(home1, okRunner())
    await until(() => readIntegrationStatus(home1)?.socket === 'ready', 10_000)
    const b = daemon(home2, okRunner())
    try {
      await until(() => (readIntegrationStatus(home2)?.standby ?? null) !== null, 10_000)
      double.refuseKey(oldKey)
      double.kick(oldKey)
      await until(() => readIntegrationStatus(home2)?.socket === 'ready', 15_000)
      const gaveUp = readIntegrationStatus(home1)
      expect(gaveUp?.socket).toBe('idle')
      expect(gaveUp?.last_error).toMatch(/this home cannot serve @probe: the server refuses this home's key/)
      expect(double.served.filter((x) => x.hello?.['api_key'] === newKey).length).toBeGreaterThanOrEqual(1)
    } finally {
      await a.stop()
      await b.stop()
    }
  }, 40_000)

  it('the holder whose runs fail for a runtime reason gives the agent up; the standby takes over; when the standby stops and this home checks out again, it serves again', async () => {
    double = await startServerDouble({ tray: { waiting: 1 } })
    const home1 = path.join(sandbox, 'broken-home')
    const home2 = path.join(sandbox, 'healthy-home')
    signIn(home1, KEY, double.apiBase)
    signIn(home2, KEY, double.apiBase)
    const broken = new ScriptedRunner({ state: 'ok', exitCode: 0, durationMs: 1 }, { ok: true })
    const a = daemon(home1, broken, { runtimeRecheckMs: 50 })
    await until(() => readIntegrationStatus(home1)?.socket === 'ready', 10_000)
    const b = daemon(home2, okRunner())
    try {
      await until(() => (readIntegrationStatus(home2)?.standby ?? null) !== null, 10_000)
      // Signed out: the next run does not start and the runtime's check says why.
      broken.outcome = { state: 'not_started', exitCode: 1, durationMs: 1, detail: 'Not logged in' }
      broken.check = { ok: false, detail: 'claude is not signed in (run `claude` once and sign in)' }
      double.send({ type: 'message.new', payload: { id: 'm1', conversation_id: 'conv_1', sender: 'peer', content: { text: 'x' } } })
      await until(() => readIntegrationStatus(home2)?.socket === 'ready', 15_000)
      const gaveUp = readIntegrationStatus(home1)
      expect(gaveUp?.socket).toBe('idle')
      expect(gaveUp?.runs_failing?.reason).toBe('claude: claude is not signed in (run `claude` once and sign in)')
      expect(formatIntegrationStatus(gaveUp).join('\n')).toContain('runs failing: claude: claude is not signed in')
      // Signed in again, and the standby stops: this home takes the agent back.
      broken.check = { ok: true }
      broken.outcome = { state: 'ok', exitCode: 0, durationMs: 1 }
      expect(await b.stop()).toBe(0)
      await until(() => readIntegrationStatus(home1)?.socket === 'ready', 15_000)
      expect(readIntegrationStatus(home1)?.runs_failing ?? null).toBeNull()
    } finally {
      await a.stop()
      await b.stop()
    }
  }, 60_000)

  it('the holder whose agent lock was replaced underneath it stands down at its next renewal: never two serving', async () => {
    double = await startServerDouble({ tray: { waiting: 0 } })
    const home1 = path.join(sandbox, 'h1')
    signIn(home1, KEY, double.apiBase)
    const a = daemon(home1, okRunner())
    try {
      await until(() => readIntegrationStatus(home1)?.socket === 'ready', 10_000)
      const file = agentLockPath({ apiBase: double.apiBase, handle: 'probe' })
      const other = sleeper()
      try {
        leaseFile(file, { pid: other.pid ?? 0, renewed_at: Date.now() + 60_000, home: '/the/other/home' })
        await until(() => (readIntegrationStatus(home1)?.standby ?? null) !== null, 10_000)
        expect(readIntegrationStatus(home1)?.standby).toMatchObject({ home: '/the/other/home', pid: other.pid })
      } finally {
        other.kill('SIGKILL')
      }
    } finally {
      await a.stop()
    }
  }, 30_000)

  it('an env-key standby asks the server who it is once, not on every poll', async () => {
    double = await startServerDouble({ tray: { waiting: 0 }, meHandle: 'probe' })
    const home1 = path.join(sandbox, 'h1')
    const home2 = path.join(sandbox, 'h2')
    fs.mkdirSync(home1, { recursive: true })
    fs.mkdirSync(home2, { recursive: true })
    // Both homes serve the agent of the key in the environment (no credentials file, no handle on disk).
    const prev = { key: process.env['AGENTCHAT_API_KEY'], base: process.env['AGENTCHAT_API_BASE'] }
    process.env['AGENTCHAT_API_KEY'] = KEY
    process.env['AGENTCHAT_API_BASE'] = double.apiBase
    const a = daemon(home1, okRunner())
    let b: ReturnType<typeof daemon> | null = null
    try {
      await until(() => readIntegrationStatus(home1)?.socket === 'ready', 10_000)
      b = daemon(home2, okRunner())
      await until(() => (readIntegrationStatus(home2)?.standby ?? null) !== null, 10_000)
      const asks = (): number => double.requests.filter((r) => r.startsWith('/v1/agents/me')).length
      const before = asks()
      const t0 = readIntegrationStatus(home2)?.updated_at ?? ''
      // Several standby polls later: the status moved on, the server was not asked again.
      await until(() => (readIntegrationStatus(home2)?.updated_at ?? '') > t0, 3_000)
      await new Promise((r) => setTimeout(r, 800))
      expect(asks()).toBe(before)
    } finally {
      await a.stop()
      await b?.stop()
      if (prev.key === undefined) delete process.env['AGENTCHAT_API_KEY']
      else process.env['AGENTCHAT_API_KEY'] = prev.key
      if (prev.base === undefined) delete process.env['AGENTCHAT_API_BASE']
      else process.env['AGENTCHAT_API_BASE'] = prev.base
    }
  }, 30_000)
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

  it('a run that succeeds resets the window: fail → ok → fail within it is checked again at once', async () => {
    double = await startServerDouble({ tray: { waiting: 0 } })
    const runner = new ScriptedRunner({ state: 'not_started', exitCode: 1, durationMs: 1, detail: 'x' }, { ok: true })
    const i = await start(runner, 60_000)
    await until(() => i.snapshot().socket === 'ready', 5_000)
    double.setTray({ waiting: 1 })
    const checks0 = runner.preflights
    wake('a')
    await until(() => runner.starts === 1, 5_000)
    await i.runtimeCheckSettled()
    expect(runner.preflights).toBe(checks0 + 1)
    runner.outcome = { state: 'ok', exitCode: 0, durationMs: 1 }
    wake('b')
    await until(() => runner.starts === 2, 5_000)
    runner.outcome = { state: 'not_started', exitCode: 1, durationMs: 1, detail: 'x' }
    runner.check = { ok: false, detail: 'unknown option --permission-prompts' }
    wake('c')
    await until(() => runner.starts === 3, 5_000)
    await i.runtimeCheckSettled()
    expect(runner.preflights).toBe(checks0 + 2)
    expect(i.snapshot().runs_failing?.reason).toBe('claude: unknown option --permission-prompts')
  }, 20_000)

  it('stopping kills a runtime check in flight and waits for it (its probes do not outlive the integration)', async () => {
    double = await startServerDouble({ tray: { waiting: 1 } })
    let aborted = false
    const runner: RunRunner & { starts: number } = {
      name: 'claude',
      starts: 0,
      preflight: async (options?: RunPreflightOptions) => {
        if (runner.starts === 0) return { ok: true }
        // The recheck: hangs until the integration stops it.
        await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }))
        aborted = options?.signal?.aborted === true
        return { ok: false, detail: 'stopped' }
      },
      start: async () => {
        runner.starts += 1
        return { state: 'not_started', exitCode: 1, durationMs: 1, detail: 'x' }
      },
    }
    const i = await start(runner, 60_000)
    await until(() => runner.starts === 1, 5_000)
    const t0 = Date.now()
    expect(await i.stopAndWait(5_000)).toBe(true)
    expect(Date.now() - t0).toBeLessThan(4_000)
    expect(aborted).toBe(true)
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
    // Long enough for the child to start and write its pids even on a loaded machine.
    const result = await runProbe(process.execPath, ['-e', script], { timeoutMs: 5_000 })
    expect(result.timedOut).toBe(true)
    expect(result.error?.message).toMatch(/did not answer within 5 s/)
    expect(Date.now() - startedAt).toBeLessThan(15_000)
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
    ['claude --version', installFakeClaude, (cmd: string) => inspectClaudeRuntime(path.join(sandbox, '.claude'), cmd, 5_000)],
    ['claude auth status', installFakeClaude, (cmd: string) => claudeIsLoggedIn(path.join(sandbox, '.claude'), cmd, 5_000)],
    ['codex --version', installFakeCodex, (cmd: string) => inspectCodexRuntime(path.join(sandbox, '.codex'), cmd, 5_000)],
    ['codex login status', installFakeCodex, (cmd: string) => codexIsLoggedIn(path.join(sandbox, '.codex'), cmd, 5_000)],
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
        if (label === 'claude auth status') {
          // Said as what it is: no answer, not "not signed in".
          fs.rmSync(pids, { force: true })
          const signIn = await claudeSignIn(path.join(sandbox, '.claude'), cmd, 5_000)
          expect(signIn).toEqual({ signedIn: false, unanswered: 'claude auth status did not answer within 5 s (killed)' })
          expectGone(pids)
        }
      } finally {
        delete process.env['FAKE_RUNTIME_PROBE_HANG']
        delete process.env['FAKE_RUNTIME_PROBE_PIDS']
      }
    }, 30_000)
  }
})
