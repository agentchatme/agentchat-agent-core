import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { acquireLease, holderLive, leaseConfirmMs, leaseStartupObserveMs, parseLease, pidAlive, resetLeaseObservations, type LeaseHolder } from '../src/util/lease.js'
import { acquireAgentLock, agentLockDir, agentLockPath, AGENT_LOCK_DIR_ENV, standbyMarkerPath } from '../src/daemon/agent-lock.js'
import { acquireLeaderLock } from '../src/daemon/leader-lock.js'
import { lockedDaemonPid } from '../src/daemon/service.js'
import { runIntegration } from '../src/integration/run.js'
import { Integration } from '../src/integration/integration.js'
import { formatIntegrationStatus, readIntegrationStatus, writeIntegrationStatus, type IntegrationStatus } from '../src/integration/status.js'
import { AgentChatClient } from 'agentchatme'
import { createIdentityCommands } from '../src/identity/commands.js'
import { writeCredentials } from '../src/identity/credentials.js'
import type { HostProfile } from '../src/identity/host-profile.js'
import { mockServedTexts } from './helpers/served-texts.js'
import { runProbe } from '../src/util/probe.js'
import { claudeIsLoggedIn, claudeSignIn, inspectClaudeRuntime, inspectCodexRuntime, codexIsLoggedIn, CodexRunner } from '../src/presets/index.js'
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
    // A 0.4.x daemon's bare pid: stopped while it lives; a dead one names nothing (its pid may be someone else's now).
    const live = sleeper()
    try {
      fs.writeFileSync(path.join(home, 'daemon.lock'), String(live.pid))
      expect(lockedDaemonPid(home)).toBe(live.pid)
      fs.writeFileSync(path.join(home, 'daemon.lock'), String(deadPid()))
      expect(lockedDaemonPid(home)).toBeNull()
      // A lease its holder stopped renewing long ago: nothing to stop either.
      leaseFile(path.join(home, 'daemon.lock'), { pid: live.pid ?? 0, renewed_at: Date.now() - 3_600_000 })
      expect(lockedDaemonPid(home)).toBeNull()
    } finally {
      live.kill('SIGKILL')
    }
  })

  it('liveness: a dead pid here is gone at once; a live pid that stopped renewing (a reboot reused it) is gone; EPERM with a fresh lease is held, with a stale one is not', () => {
    const now = Date.now()
    const live = sleeper()
    try {
      const h = (pid: number, renewed: number, host?: string): LeaseHolder => ({ pid, token: 't', host: host ?? os.hostname(), renewed_at: renewed })
      expect(holderLive(h(deadPid(), now), { now })).toBe(false)
      expect(holderLive(h(live.pid ?? 0, now - 1_000), { now })).toBe(true)
      expect(holderLive(h(live.pid ?? 0, now - 120_000), { now })).toBe(false) // reboot-stale: alive pid, no renewal
      expect(pidAlive(EPERM_PID)).toBe(true)
      expect(holderLive(h(EPERM_PID, now - 1_000), { now })).toBe(true)
      expect(holderLive(h(EPERM_PID, now - 120_000), { now })).toBe(false) // reused by an elevated process
      // Another host: its pid means nothing here; the lease alone decides.
      expect(holderLive(h(deadPid(), now - 1_000, 'other-host'), { now })).toBe(true)
      expect(holderLive(h(deadPid(), now - 120_000, 'other-host'), { now })).toBe(false)
      // A lock from before leases: its pid — unless the file predates this boot.
      expect(holderLive({ pid: live.pid ?? 0, token: null, host: null, renewed_at: null }, { now })).toBe(true)
      expect(holderLive({ pid: deadPid(), token: null, host: null, renewed_at: null }, { now })).toBe(false)
      expect(holderLive({ pid: live.pid ?? 0, token: null, host: null, renewed_at: null }, { now, mtimeMs: now - 3_600_000, bootedAt: now - 60_000 })).toBe(false)
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
        expect(holderLive({ pid: live.pid ?? 0, token: 't', host: os.hostname(), renewed_at: renewed }, { now: renewed + 20_000 })).toBe(true)
        expect(holderLive({ pid: live.pid ?? 0, token: 't', host: os.hostname(), renewed_at: renewed }, { now: renewed + 3_600_000 })).toBe(false)
      } finally {
        live.kill('SIGKILL')
      }
    } finally {
      if (prev === undefined) delete process.env['TZ']
      else process.env['TZ'] = prev
    }
  })

  it('taken over at once: a dead holder here, an old bare pid of a dead process, a bare pid from before this boot; refused: a live bare pid', async () => {
    const file = path.join(sandbox, 'x.lock')
    const take = async (options = {}): Promise<boolean> => {
      const r = await acquireLease(file, {}, options)
      if (r.ok) r.lease.release()
      return r.ok
    }
    const live = sleeper()
    try {
      leaseFile(file, { pid: deadPid(), renewed_at: Date.now() })
      expect(await take()).toBe(true)
      fs.writeFileSync(file, String(deadPid()))
      expect(await take()).toBe(true)
      fs.writeFileSync(file, String(live.pid))
      expect(await acquireLease(file)).toMatchObject({ ok: false, holder: { pid: live.pid, renewed_at: null } })
      // The same live bare pid, but the file was written before this boot: someone else's pid now.
      const old = new Date(Date.now() - 3_600_000)
      fs.utimesSync(file, old, old)
      expect(await take({ bootedAt: () => Date.now() - 60_000 })).toBe(true)
    } finally {
      live.kill('SIGKILL')
    }
  })

  it('a live pid (or EPERM) is taken over only when its lease content has not changed for 45 s on the contender\'s own monotonic clock', async () => {
    resetLeaseObservations()
    const file = path.join(sandbox, 'x.lock')
    const live = sleeper()
    try {
      for (const pid of [live.pid ?? 0, EPERM_PID]) {
        resetLeaseObservations()
        leaseFile(file, { pid, renewed_at: Date.now() - 3_600_000 }) // an hour-old wall clock: not evidence
        let mono = 0
        const clocks = { monotonic: () => mono, renewMs: 20 } // the second look after a stale verdict: 30 ms here
        expect((await acquireLease(file, {}, clocks)).ok).toBe(false) // first seen: held
        mono = 44_000
        expect((await acquireLease(file, {}, clocks)).ok).toBe(false)
        mono = 45_500
        const r = await acquireLease(file, {}, clocks)
        expect(r.ok).toBe(true)
        if (r.ok) r.lease.release()
      }
    } finally {
      live.kill('SIGKILL')
    }
  })

  it('a stale verdict by observation is confirmed by a second look 1.5 renewals later: a holder that renews in between keeps its lease', async () => {
    expect(leaseConfirmMs()).toBe(15_000)
    resetLeaseObservations()
    const file = path.join(sandbox, 'x.lock')
    const live = sleeper()
    try {
      leaseFile(file, { pid: live.pid ?? 0, renewed_at: Date.now(), token: 'holder' })
      let mono = 0
      const opts = { monotonic: () => mono, renewMs: 200 }
      expect((await acquireLease(file, {}, opts)).ok).toBe(false)
      // Unchanged for the window, as a clock that ran on through a macOS sleep says on wake.
      mono = 46_000
      const t0 = performance.now()
      const pending = acquireLease(file, {}, opts)
      await new Promise((r) => setTimeout(r, 50))
      leaseFile(file, { pid: live.pid ?? 0, renewed_at: Date.now(), token: 'holder' }) // the holder, awake too, renews
      expect((await pending).ok).toBe(false)
      expect(performance.now() - t0).toBeGreaterThanOrEqual(250)
      // Unchanged through the second look as well: gone, taken over.
      mono = 100_000
      const r = await acquireLease(file, {}, opts)
      expect(r.ok).toBe(true)
      if (r.ok) r.lease.release()
    } finally {
      live.kill('SIGKILL')
    }
  })

  it.skipIf(!posix() || !stripTypes())('sleep on a clock that keeps running (macOS): the standby wakes first and finds the lease unchanged past the window, the holder renews late — no takeover, no two serving', async () => {
    const file = path.join(sandbox, 'sleep.lock')
    const holderOut = path.join(sandbox, 'holder.txt')
    const contenderOut = path.join(sandbox, 'contender.txt')
    const done = path.join(sandbox, 'done')
    const lib = pathToFileURL(path.join(__dirname, '..', 'src', 'util', 'lease.ts')).href
    const timing = '{ renewMs: 500, staleMs: 1500 }'
    const holderScript = [
      "const fs = require('node:fs')",
      'const [lib, file, out, done] = process.argv.slice(1)',
      'import(lib).then(async (m) => {',
      `  const r = await m.acquireLease(file, { label: 'holder' }, ${timing})`,
      "  if (!r.ok) { fs.appendFileSync(out, 'refused\\n'); process.exit(3) }",
      "  r.lease.onLost((why) => fs.appendFileSync(out, 'lost ' + why + '\\n'))",
      "  fs.appendFileSync(out, 'held\\n')",
      '  const poll = setInterval(() => { if (fs.existsSync(done)) { clearInterval(poll); r.lease.release(); process.exit(0) } }, 20)',
      '})',
      'setTimeout(() => process.exit(2), 120000).unref()',
    ].join('\n')
    const contenderScript = [
      "const fs = require('node:fs')",
      'const [lib, file, out, done] = process.argv.slice(1)',
      'import(lib).then(async (m) => {',
      '  let looks = 0',
      '  while (!fs.existsSync(done)) {',
      `    const r = await m.acquireLease(file, { label: 'contender' }, ${timing})`,
      "    if (r.ok) { fs.appendFileSync(out, 'took\\n'); r.lease.release(); break }",
      "    if (++looks === 1) fs.appendFileSync(out, 'watching\\n')",
      '    await new Promise((resolve) => setTimeout(resolve, 100))',
      '  }',
      '  process.exit(0)',
      '})',
      'setTimeout(() => process.exit(2), 120000).unref()',
    ].join('\n')
    const spawnScript = (script: string, out: string): ChildProcess => spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '-e', script, lib, file, out, done], { stdio: 'ignore' })
    const read = (f: string): string => (fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : '')
    const exited = (k: ChildProcess): Promise<unknown> => new Promise((r) => (k.exitCode !== null || k.signalCode !== null ? r(null) : k.once('exit', r)))
    const holder = spawnScript(holderScript, holderOut)
    let contender: ChildProcess | null = null
    try {
      await until(() => read(holderOut).includes('held'), 30_000)
      contender = spawnScript(contenderScript, contenderOut)
      await until(() => read(contenderOut).includes('watching'), 30_000)
      await new Promise((r) => setTimeout(r, 700))
      // Both asleep, on clocks that keep counting (a stopped process's monotonic clock runs on, as macOS's does in sleep).
      holder.kill('SIGSTOP')
      contender.kill('SIGSTOP')
      await new Promise((r) => setTimeout(r, 2_500))
      // The standby wakes first; the holder's overdue renewal comes a moment later.
      contender.kill('SIGCONT')
      await new Promise((r) => setTimeout(r, 150))
      holder.kill('SIGCONT')
      await new Promise((r) => setTimeout(r, 2_000))
      expect(read(contenderOut)).not.toContain('took')
      expect(read(holderOut)).not.toContain('lost')
    } finally {
      fs.writeFileSync(done, '')
      for (const k of [holder, contender]) {
        if (k === null) continue
        try {
          k.kill('SIGCONT')
        } catch {
          /* gone */
        }
      }
      await Promise.race([Promise.all([exited(holder), contender === null ? null : exited(contender)]), new Promise((r) => setTimeout(r, 3_000))])
      for (const k of [holder, contender]) if (k !== null && k.exitCode === null && k.signalCode === null) k.kill('SIGKILL')
    }
  }, 60_000)

  it('a lease on this host last written before this boot is stale at once (its pid is someone else\'s now); another host\'s, or one written since, is not', async () => {
    resetLeaseObservations()
    const file = path.join(sandbox, 'x.lock')
    const live = sleeper()
    try {
      const old = Date.now() - 3 * 3_600_000
      const bootedAt = (): number => Date.now() - 3_600_000
      leaseFile(file, { pid: live.pid ?? 0, renewed_at: old })
      fs.utimesSync(file, new Date(old), new Date(old))
      const r = await acquireLease(file, {}, { bootedAt })
      expect(r.ok).toBe(true)
      if (r.ok) r.lease.release()
      leaseFile(file, { pid: live.pid ?? 0, renewed_at: old, host: 'other-host' })
      fs.utimesSync(file, new Date(old), new Date(old))
      expect((await acquireLease(file, {}, { bootedAt })).ok).toBe(false)
      resetLeaseObservations()
      leaseFile(file, { pid: live.pid ?? 0, renewed_at: old }) // the file touched since the boot
      expect((await acquireLease(file, {}, { bootedAt })).ok).toBe(false)
      resetLeaseObservations()
      leaseFile(file, { pid: live.pid ?? 0, renewed_at: Date.now() }) // renewed since the boot, the file's time kept (a restore)
      fs.utimesSync(file, new Date(old), new Date(old))
      expect((await acquireLease(file, {}, { bootedAt })).ok).toBe(false)
    } finally {
      live.kill('SIGKILL')
    }
  })

  it('another host\'s skewed clock is no evidence either way: a lease stamped hours ago there is held until observed unchanged for 45 s', async () => {
    resetLeaseObservations()
    const file = path.join(sandbox, 'x.lock')
    leaseFile(file, { pid: 999_999, renewed_at: Date.now() - 10 * 3_600_000, host: 'skewed-host' })
    let mono = 0
    expect((await acquireLease(file, {}, { monotonic: () => mono, renewMs: 20 })).ok).toBe(false)
    mono = 46_000
    const r = await acquireLease(file, {}, { monotonic: () => mono, renewMs: 20 })
    expect(r.ok).toBe(true)
    if (r.ok) r.lease.release()
  })

  it('a renewal that fails never crashes the process: the lock folder removed stands the holder down; a folder it cannot write to is counted, then given up', async () => {
    const dir = path.join(sandbox, 'locks')
    const a = await acquireLease(path.join(dir, 'x.lock'), {}, { renewMs: 30 })
    if (!a.ok) throw new Error('not acquired')
    let why: string | null = null
    a.lease.onLost((w) => {
      why = w
    })
    fs.rmSync(dir, { recursive: true, force: true })
    await until(() => why !== null, 3_000)
    expect(why).toMatch(/is gone|was removed/)
    expect(a.lease.lost).toBe(true)
    if (posix() && process.getuid?.() !== 0) {
      const dir2 = path.join(sandbox, 'ro-locks')
      const b = await acquireLease(path.join(dir2, 'y.lock'), {}, { renewMs: 30, staleMs: 300 })
      if (!b.ok) throw new Error('not acquired')
      let lost: string | null = null
      b.lease.onLost((w) => {
        lost = w
      })
      fs.chmodSync(dir2, 0o500)
      try {
        await until(() => lost !== null, 5_000)
        expect(b.lease.renewErrors).toBeGreaterThan(0)
        expect(lost).toMatch(/could not renew/)
      } finally {
        fs.chmodSync(dir2, 0o700)
      }
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
      // Every contender stays alive until all have answered (and never past two minutes, whatever happens to the test).
      '  const poll = setInterval(() => { if (fs.existsSync(done)) { clearInterval(poll); process.exit(0) } }, 20)',
      '})',
      'setTimeout(() => process.exit(2), 120000).unref()',
    ].join('\n')
    const kids = Array.from({ length: 8 }, () => spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '-e', script, lib, file, go, out, done], { stdio: 'ignore' }))
    const exited = (k: ChildProcess): Promise<unknown> => new Promise((r) => (k.exitCode !== null || k.signalCode !== null ? r(null) : k.once('exit', r)))
    try {
      await new Promise((r) => setTimeout(r, 1500))
      fs.writeFileSync(go, '')
      await until(() => fs.existsSync(out) && fs.readFileSync(out, 'utf-8').trim().split('\n').length === 8, 60_000)
      const results = fs.readFileSync(out, 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as { pid: number; ok: boolean })
      fs.writeFileSync(done, '')
      expect(results.filter((r) => r.ok)).toHaveLength(1)
      expect(parseLease(fs.readFileSync(file, 'utf-8'))?.pid).toBe(results.find((r) => r.ok)?.pid)
      await Promise.all(kids.map(exited))
    } finally {
      // A failed run leaves no contender behind.
      for (const k of kids) if (k.exitCode === null && k.signalCode === null) k.kill('SIGKILL')
      await Promise.all(kids.map(exited))
    }
  }, 90_000)

  it('the home lock (leader lock) is the same lease; a holder seen renewing is refused within a renewal; an older release\'s stale bare-pid lock is taken over', async () => {
    const home = path.join(sandbox, 'home')
    const a = await acquireLeaderLock(home, { renewMs: 100, staleMs: 600 })
    expect(a).not.toBeNull()
    const t0 = performance.now()
    expect(await acquireLeaderLock(home, { renewMs: 100, staleMs: 600 })).toBeNull()
    expect(performance.now() - t0).toBeLessThan(600) // refused on its renewal, not at the end of the window
    a?.release()
    fs.writeFileSync(path.join(home, 'daemon.lock'), String(deadPid()))
    const b = await acquireLeaderLock(home)
    expect(b).not.toBeNull()
    b?.release()
  })

  it('a fresh start observes a held daemon.lock before refusing: pid 1 / EPERM renewed 3 h ago is taken over by the same process within the stale window plus a renewal', async () => {
    expect(leaseStartupObserveMs()).toBe(55_000)
    const home = path.join(sandbox, 'home')
    fs.mkdirSync(home, { recursive: true })
    resetLeaseObservations() // a new process: nothing observed yet
    leaseFile(path.join(home, 'daemon.lock'), { pid: EPERM_PID, renewed_at: Date.now() - 3 * 3_600_000 })
    const t0 = performance.now()
    const b = await acquireLeaderLock(home, { renewMs: 100, staleMs: 600 })
    const took = performance.now() - t0
    expect(b).not.toBeNull()
    expect(took).toBeGreaterThanOrEqual(600) // observed for the window, not taken on sight
    expect(took).toBeLessThan(10_000)
    b?.release()
  }, 30_000)
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
  /** A wake's run starts within a fraction of a second (no 2 s quiet window, no pacing). */
  const promptRuns = { quietMs: 50, maxMs: 200, paceMs: 50 }
  const wakeStartsRun = async (runner: ScriptedRunner, id: string): Promise<void> => {
    const before = runner.starts
    double.send({ type: 'message.new', payload: { id, conversation_id: 'conv_1', sender: 'peer', content: { text: 'x' } } })
    await until(() => runner.starts > before, 3_000)
  }

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
      expect(gaveUp?.unservable).toMatchObject({ reason: 'key_refused', detail: expect.stringMatching(/refuses this home's key/), since: expect.any(String), retry_at: expect.any(String) })
      expect(formatIntegrationStatus(gaveUp).join('\n')).toContain('this home gave the agent up')
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
      expect(gaveUp?.unservable).toMatchObject({ reason: 'runs_failing', detail: 'runs failing: claude: claude is not signed in (run `claude` once and sign in)' })
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

  it('a lone install whose runs fail keeps its socket: no other listener waits, so nothing is handed over and wakes keep starting runs', async () => {
    double = await startServerDouble({ tray: { waiting: 1 } })
    const home1 = path.join(sandbox, 'lone-home')
    signIn(home1, KEY, double.apiBase)
    const broken = new ScriptedRunner({ state: 'ok', exitCode: 0, durationMs: 1 }, { ok: true })
    // The supervisor looks every 200 ms here, so the wait below spans several of its health checks.
    const a = daemon(home1, broken, { runtimeRecheckMs: 50, pollMs: 200 })
    try {
      await until(() => readIntegrationStatus(home1)?.socket === 'ready', 10_000)
      // Markers of standbys that are not there: one whose process died, one that stopped renewing it. Nobody waits.
      const lockFile = agentLockPath({ apiBase: double.apiBase, handle: 'probe' })
      const marker = (home: string, pid: number): string => {
        const file = standbyMarkerPath(lockFile, home)
        fs.writeFileSync(file, `${pid}\n${JSON.stringify({ pid, host: os.hostname(), home, at: Date.now() })}\n`)
        return file
      }
      marker('/crashed/standby', deadPid())
      const old = marker('/silent/standby', process.pid)
      fs.utimesSync(old, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000))
      const connections = double.served.length
      broken.outcome = { state: 'not_started', exitCode: 1, durationMs: 1, detail: 'Not logged in' }
      broken.check = { ok: false, detail: 'claude is not signed in (run `claude` once and sign in)' }
      double.send({ type: 'message.new', payload: { id: 'm1', conversation_id: 'conv_1', sender: 'peer', content: { text: 'x' } } })
      await until(() => (readIntegrationStatus(home1)?.runs_failing ?? null) !== null, 10_000)
      const starts = broken.starts
      double.send({ type: 'message.new', payload: { id: 'm2', conversation_id: 'conv_1', sender: 'peer', content: { text: 'y' } } })
      await until(() => broken.starts > starts, 10_000)
      await new Promise((r) => setTimeout(r, 1_500)) // several supervisor polls
      const status = readIntegrationStatus(home1)
      expect(status?.socket).toBe('ready')
      expect(status?.unservable ?? null).toBeNull()
      // The socket was never dropped: no give-up and take-back, not even a brief one.
      expect(double.served.length).toBe(connections)
      expect(formatIntegrationStatus(status).join('\n')).toContain('the next run that succeeds clears this')
    } finally {
      await a.stop()
    }
  }, 30_000)

  it('after giving the agent up, its runtime recheck is bounded by a deadline and stopped with the daemon', async () => {
    double = await startServerDouble({ tray: { waiting: 1 } })
    const home1 = path.join(sandbox, 'gave-up-home')
    const home2 = path.join(sandbox, 'waiting-home')
    signIn(home1, KEY, double.apiBase)
    signIn(home2, KEY, double.apiBase)
    const broken = new ScriptedRunner({ state: 'ok', exitCode: 0, durationMs: 1 }, { ok: true })
    const a = daemon(home1, broken, { runtimeRecheckMs: 50, preflightDeadlineMs: 300 })
    await until(() => readIntegrationStatus(home1)?.socket === 'ready', 10_000)
    const b = daemon(home2, okRunner())
    try {
      await until(() => (readIntegrationStatus(home2)?.standby ?? null) !== null, 10_000)
      broken.outcome = { state: 'not_started', exitCode: 1, durationMs: 1, detail: 'Not logged in' }
      broken.check = { ok: false, detail: 'claude is not signed in (run `claude` once and sign in)' }
      double.send({ type: 'message.new', payload: { id: 'm1', conversation_id: 'conv_1', sender: 'peer', content: { text: 'x' } } })
      await until(() => (readIntegrationStatus(home1)?.unservable ?? null) !== null, 15_000)
      // A check that never answers: the deadline answers for it, and the home keeps waiting (it does not hang).
      broken.hang = 'never'
      await until(() => /did not answer within/.test(readIntegrationStatus(home1)?.unservable?.detail ?? ''), 10_000)
      expect(readIntegrationStatus(home1)?.unservable?.reason).toBe('runs_failing')
      // A check in flight when the daemon stops: it gets the stop signal, and the daemon exits at once.
      broken.hang = 'until-stopped'
      const asked = broken.preflights
      await until(() => broken.preflights > asked, 10_000)
      const t0 = Date.now()
      expect(await a.stop()).toBe(0)
      expect(Date.now() - t0).toBeLessThan(2_000)
      expect(broken.signals.at(-1)?.aborted).toBe(true)
    } finally {
      await a.stop()
      await b.stop()
    }
  }, 60_000)

  it('a lone install whose key the server refuses gives the agent up all the same (it cannot serve it), and says so', async () => {
    double = await startServerDouble({ tray: { waiting: 0 } })
    const oldKey = 'ac_' + 'r'.repeat(40)
    const home1 = path.join(sandbox, 'refused-home')
    signIn(home1, oldKey, double.apiBase)
    const a = daemon(home1, okRunner(), { unservableRecheckMs: 60_000 })
    try {
      await until(() => readIntegrationStatus(home1)?.socket === 'ready', 10_000)
      double.refuseKey(oldKey)
      double.kick(oldKey)
      await until(() => readIntegrationStatus(home1)?.unservable?.reason === 'key_refused', 15_000)
      expect(fs.existsSync(agentLockPath({ apiBase: double.apiBase, handle: 'probe' }))).toBe(false)
    } finally {
      await a.stop()
    }
  }, 30_000)

  it.skipIf(!posix() || process.getuid?.() === 0)('a lock folder it cannot write to: renewals fail, are counted in status, and the daemon keeps serving', async () => {
    double = await startServerDouble({ tray: { waiting: 1 } })
    const home1 = path.join(sandbox, 'ro-lock-home')
    signIn(home1, KEY, double.apiBase)
    const a = daemon(home1, okRunner())
    const lockDir = agentLockDir(process.env)
    try {
      await until(() => readIntegrationStatus(home1)?.socket === 'ready', 10_000)
      fs.chmodSync(lockDir, 0o500)
      await new Promise((r) => setTimeout(r, 500)) // several renewals (every 100 ms here)
      double.send({ type: 'message.new', payload: { id: 'm1', conversation_id: 'conv_1', sender: 'peer', content: { text: 'x' } } })
      await until(() => (readIntegrationStatus(home1)?.lease_errors?.count ?? 0) > 0, 10_000)
      const status = readIntegrationStatus(home1)
      expect(status?.socket).toBe('ready')
      expect(status?.lease_errors?.last).toMatch(/EACCES|permission/i)
      expect(formatIntegrationStatus(status).join('\n')).toMatch(/lock: \d+ renewal\(s\) failed/)
    } finally {
      fs.chmodSync(lockDir, 0o700)
      await a.stop()
    }
  }, 30_000)

  it('a daemon whose home lock is taken over exits at once (code 1)', async () => {
    double = await startServerDouble({ tray: { waiting: 0 } })
    const home1 = path.join(sandbox, 'h-lost')
    signIn(home1, KEY, double.apiBase)
    // A minute between polls: only the nudge can make the exit immediate.
    const a = daemon(home1, okRunner(), { pollMs: 60_000 })
    await until(() => readIntegrationStatus(home1)?.socket === 'ready', 10_000)
    const other = sleeper()
    try {
      leaseFile(path.join(home1, 'daemon.lock'), { pid: other.pid ?? 0, renewed_at: Date.now(), home: home1 })
      const t0 = Date.now()
      expect(await a.done).toBe(1)
      expect(Date.now() - t0).toBeLessThan(5_000)
    } finally {
      other.kill('SIGKILL')
    }
  }, 30_000)

  it('a lost home lock stops the integration at once: a wake right after the loss starts no run, though the loop has not looked yet', async () => {
    double = await startServerDouble({ tray: { waiting: 1 } })
    const home1 = path.join(sandbox, 'h-lost-run')
    signIn(home1, KEY, double.apiBase)
    const runner = new ScriptedRunner({ state: 'ok', exitCode: 0, durationMs: 1 }, { ok: true })
    // The loop ticks every 20 s here: it does not look during the test, so only the lease's own stop can be at once.
    const a = daemon(home1, runner, { tickMs: 20_000, lease: { renewMs: 50 }, ...promptRuns })
    await until(() => readIntegrationStatus(home1)?.socket === 'ready', 10_000)
    const other = sleeper()
    try {
      await wakeStartsRun(runner, 'm-before') // the control: here a wake starts a run within a fraction of a second
      const starts = runner.starts
      leaseFile(path.join(home1, 'daemon.lock'), { pid: other.pid ?? 0, renewed_at: Date.now(), home: home1 })
      await new Promise((r) => setTimeout(r, 400)) // its next renewal (50 ms) finds it lost
      double.send({ type: 'message.new', payload: { id: 'm-after', conversation_id: 'conv_1', sender: 'peer', content: { text: 'x' } } })
      await new Promise((r) => setTimeout(r, 1_000))
      expect(runner.starts).toBe(starts)
      const t0 = Date.now()
      expect(await a.stop()).toBe(1)
      expect(Date.now() - t0).toBeLessThan(3_000) // a stop does not wait out the loop's tick
    } finally {
      other.kill('SIGKILL')
    }
  }, 30_000)

  it('a lost agent lock stops the integration at once: a wake right after the loss starts no run, before the loop next looks', async () => {
    double = await startServerDouble({ tray: { waiting: 1 } })
    const home1 = path.join(sandbox, 'h-lost-agent')
    signIn(home1, KEY, double.apiBase)
    const runner = new ScriptedRunner({ state: 'ok', exitCode: 0, durationMs: 1 }, { ok: true })
    // The loop ticks every 20 s here: it does not look during the test, so only the lease's own stop can be at once.
    const a = daemon(home1, runner, { tickMs: 20_000, lease: { renewMs: 50 }, ...promptRuns })
    const other = sleeper()
    try {
      await until(() => readIntegrationStatus(home1)?.socket === 'ready', 10_000)
      await wakeStartsRun(runner, 'm-before') // the control: here a wake starts a run within a fraction of a second
      const starts = runner.starts
      leaseFile(agentLockPath({ apiBase: double.apiBase, handle: 'probe' }), { pid: other.pid ?? 0, renewed_at: Date.now(), home: '/the/other/home' })
      await new Promise((r) => setTimeout(r, 400)) // its next renewal (50 ms) finds it lost
      double.send({ type: 'message.new', payload: { id: 'm-after', conversation_id: 'conv_1', sender: 'peer', content: { text: 'x' } } })
      await new Promise((r) => setTimeout(r, 1_000))
      expect(runner.starts).toBe(starts)
      expect(readIntegrationStatus(home1)?.socket).not.toBe('ready')
    } finally {
      other.kill('SIGKILL')
      await a.stop()
    }
  }, 30_000)

  it('a standby in the middle of a second look (15 s at the real renewal interval) stops at once with the daemon', async () => {
    double = await startServerDouble({ tray: { waiting: 0 } })
    const home1 = path.join(sandbox, 'confirming-home')
    signIn(home1, KEY, double.apiBase)
    const other = sleeper()
    try {
      // An agent lock held by a live pid that never renews: observed stale after 300 ms here, then the 15 s second look.
      leaseFile(agentLockPath({ apiBase: double.apiBase, handle: 'probe' }), { pid: other.pid ?? 0, renewed_at: Date.now(), home: '/the/other/home' })
      const a = daemon(home1, okRunner(), { lease: { renewMs: 10_000, staleMs: 300 } })
      await until(() => (readIntegrationStatus(home1)?.standby ?? null) !== null, 10_000)
      await new Promise((r) => setTimeout(r, 1_000)) // well into the second look
      const t0 = Date.now()
      expect(await a.stop()).toBe(0)
      expect(Date.now() - t0).toBeLessThan(3_000)
    } finally {
      other.kill('SIGKILL')
    }
  }, 30_000)

  it('a daemon.lock whose pid was reused (pid 1 / EPERM, renewed 3 h ago): a fresh start takes it over within the stale window plus a renewal, instead of exiting into a restart loop', async () => {
    double = await startServerDouble({ tray: { waiting: 0 } })
    const home1 = path.join(sandbox, 'rebooted-home')
    signIn(home1, KEY, double.apiBase)
    leaseFile(path.join(home1, 'daemon.lock'), { pid: EPERM_PID, renewed_at: Date.now() - 3 * 3_600_000, home: home1 })
    resetLeaseObservations() // a new process: nothing observed yet
    const t0 = Date.now()
    const a = daemon(home1, okRunner(), { lease: { renewMs: 100, staleMs: 600 } })
    try {
      await until(() => readIntegrationStatus(home1)?.socket === 'ready', 15_000)
      expect(Date.now() - t0).toBeGreaterThanOrEqual(600)
      expect(parseLease(fs.readFileSync(path.join(home1, 'daemon.lock'), 'utf-8'))?.pid).toBe(process.pid)
    } finally {
      await a.stop()
    }
  }, 30_000)

  it('a standby whose own runtime does not check out does not offer to take over: the holder whose runs fail keeps serving; once the standby checks out, it hands over', async () => {
    double = await startServerDouble({ tray: { waiting: 1 } })
    const home1 = path.join(sandbox, 'failing-holder')
    const home2 = path.join(sandbox, 'signed-out-standby')
    signIn(home1, KEY, double.apiBase)
    signIn(home2, KEY, double.apiBase)
    const held = new ScriptedRunner({ state: 'ok', exitCode: 0, durationMs: 1 }, { ok: true })
    const a = daemon(home1, held, { runtimeRecheckMs: 50, pollMs: 200 })
    await until(() => readIntegrationStatus(home1)?.socket === 'ready', 10_000)
    const waiting = new ScriptedRunner({ state: 'ok', exitCode: 0, durationMs: 1 }, { ok: false, detail: 'claude is not signed in (run `claude` once and sign in)' })
    const b = daemon(home2, waiting, { runtimeRecheckMs: 300 })
    try {
      await until(() => /does not check out \(claude: claude is not signed in/.test(readIntegrationStatus(home2)?.last_error ?? ''), 10_000)
      expect(fs.existsSync(standbyMarkerPath(agentLockPath({ apiBase: double.apiBase, handle: 'probe' }), home2))).toBe(false)
      // The holder's runs fail, and no standby that could serve waits: it keeps its socket.
      held.outcome = { state: 'not_started', exitCode: 1, durationMs: 1, detail: 'Not logged in' }
      held.check = { ok: false, detail: 'claude is not signed in (run `claude` once and sign in)' }
      double.send({ type: 'message.new', payload: { id: 'm1', conversation_id: 'conv_1', sender: 'peer', content: { text: 'x' } } })
      await until(() => (readIntegrationStatus(home1)?.runs_failing ?? null) !== null, 10_000)
      await new Promise((r) => setTimeout(r, 1_500)) // several of the holder's health checks
      expect(readIntegrationStatus(home1)?.socket).toBe('ready')
      expect(readIntegrationStatus(home1)?.unservable ?? null).toBeNull()
      // The standby signs in: its next check passes, it says it waits, and the holder hands over.
      waiting.check = { ok: true }
      await until(() => readIntegrationStatus(home2)?.socket === 'ready', 15_000)
      expect(readIntegrationStatus(home1)?.unservable?.reason).toBe('runs_failing')
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
  /** 'never': the check never answers, stop signal or not; 'until-stopped': it answers only when its signal fires. */
  hang: 'no' | 'never' | 'until-stopped' = 'no'
  signals: Array<AbortSignal | undefined> = []
  constructor(
    public outcome: RunOutcome,
    public check: RunPreflight,
  ) {}
  async preflight(options?: RunPreflightOptions): Promise<RunPreflight> {
    this.preflights += 1
    this.signals.push(options?.signal)
    if (this.hang === 'never') return new Promise<RunPreflight>(() => undefined)
    if (this.hang === 'until-stopped') {
      const signal = options?.signal
      return new Promise<RunPreflight>((resolve) => {
        if (signal === undefined) return
        if (signal.aborted) resolve({ ok: false, detail: 'stopped' })
        else signal.addEventListener('abort', () => resolve({ ok: false, detail: 'stopped' }), { once: true })
      })
    }
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
    await i.runtimeCheckDone()
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
    await i.runtimeCheckDone()
    expect(i.snapshot().runs_failing?.reason).toBe('claude: claude CLI not found on PATH')
    const checks = runner.preflights
    await new Promise((r) => setTimeout(r, 300))
    runner.check = { ok: false, detail: 'unknown option --permission-prompts' }
    wake('m1')
    await until(() => runner.starts === 2, 5_000)
    await i.runtimeCheckDone()
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
    await i.runtimeCheckDone()
    expect(runner.preflights).toBe(checks0 + 1)
    runner.outcome = { state: 'ok', exitCode: 0, durationMs: 1 }
    wake('b')
    await until(() => runner.starts === 2, 5_000)
    runner.outcome = { state: 'not_started', exitCode: 1, durationMs: 1, detail: 'x' }
    runner.check = { ok: false, detail: 'unknown option --permission-prompts' }
    wake('c')
    await until(() => runner.starts === 3, 5_000)
    await i.runtimeCheckDone()
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
    await i.runtimeCheckDone()
    expect(i.snapshot().runs_failing ?? null).toBeNull()
  }, 20_000)
})

// ─── 3. probes ──────────────────────────────────────────────────────────────

describe('doctor says what clears a failing home: a run that succeeds, or (after a give-up) the recheck', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })
  const at = '2026-11-12T10:00:00.000Z'
  const status = (extra: Partial<IntegrationStatus>): IntegrationStatus => ({
    version: 2, updated_at: new Date().toISOString(), pid: 1, runtime: 'x', handle: 'probe', profile: 'answer', socket: 'ready',
    wakes: 1, wakes_absorbed: 0, invites: 0, runs_started: 0, runs_ok: 0, runs_failed: 0, runs_timed_out: 0, runs_not_started: 0,
    runs_skipped_empty: 0, last_run: null, retry_rung: 0, retry_due_at: null, last_error: null, texts: null, ...extra,
  })
  const failing = { reason: 'claude: claude is not signed in', since: at, runs_missed: 2, checked_at: at }
  async function doctor(s: IntegrationStatus): Promise<string> {
    const home = path.join(sandbox, 'doctor-home')
    fs.mkdirSync(home, { recursive: true })
    writeCredentials(home, { api_key: KEY, handle: 'probe' })
    writeIntegrationStatus(home, s)
    mockServedTexts('probe')
    vi.spyOn(AgentChatClient.prototype, 'getMe').mockResolvedValue({ handle: 'probe', status: 'active' } as never)
    const out: string[] = []
    vi.spyOn(console, 'log').mockImplementation((v) => void out.push(String(v)))
    const profile: HostProfile = { label: 'Example', id: 'example', client: { runtime: 'generic', version: '0' }, home: () => home, invocation: () => 'example', renderAnchor: (l) => l }
    await createIdentityCommands(profile).runDoctor({})
    return out.join('\n')
  }

  it('runs failing while serving: the next run that succeeds clears it', async () => {
    const out = await doctor(status({ runs_failing: failing }))
    expect(out).toMatch(/FAIL runs: runs failing: claude: claude is not signed in .*the next run that succeeds clears this/)
  })

  it('gave up for failing runs: no run happens, so the runtime recheck (every 60 s) is what clears it', async () => {
    const out = await doctor(status({ socket: 'idle', runs_failing: failing, unservable: { reason: 'runs_failing', detail: 'runs failing: claude: claude is not signed in', since: at, retry_at: at } }))
    expect(out).toMatch(/FAIL runs: this home gave the agent up: runs failing: claude: claude is not signed in .*checked again at .* \(every 60 s\) and a check that passes clears this/)
    expect(out).not.toContain('the next run that succeeds')
  })

  it('gave up for a refused key: tried again every 5 min; sign in again, or log out', async () => {
    const out = await doctor(status({ socket: 'idle', unservable: { reason: 'key_refused', detail: "the server refuses this home's key", since: at, retry_at: at } }))
    expect(out).toMatch(/FAIL runs: this home gave the agent up: the server refuses its key .*\(every 5 min\).*sign in again here \(login\/recover; that clears this at once\)/)
    expect(out).not.toContain('the next run that succeeds')
  })
})

describe('a probe that hangs is killed with everything it started, and answers', () => {
  // A test that fails (a tree that was not killed) leaves nothing running behind it. A passing test
  // removed its pids file once it saw them all gone, so only a failed test's processes are killed here.
  afterEach(() => {
    for (const name of ['pids.json', 'probe-pids.json']) {
      let pids: number[] = []
      try {
        pids = JSON.parse(fs.readFileSync(path.join(sandbox, name), 'utf-8')) as number[]
      } catch {
        continue
      }
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* gone */
        }
      }
    }
  })

  // A killed process can sit unreaped for a moment on a loaded machine; one that was never killed lives on for ten minutes.
  const expectGone = async (file: string): Promise<void> => {
    const pids = JSON.parse(fs.readFileSync(file, 'utf-8')) as number[]
    expect(pids).toHaveLength(2)
    const deadline = Date.now() + 5_000
    while (pids.some(alive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
    for (const pid of pids) expect(alive(pid), `pid ${pid} still alive`).toBe(false)
    fs.rmSync(file, { force: true }) // checked: nothing for the cleanup below to kill
  }

  it('runProbe: a timeout kills the tree, waits for it to exit, and says it timed out', async () => {
    const pids = path.join(sandbox, 'pids.json')
    // A native shell on POSIX starts at once even on a loaded machine; node on Windows (no load there in CI).
    const [cmd, args, timeoutMs] = posix()
      ? (['/bin/sh', ['-c', `sleep 600 & echo "[$$, $!]" > ${JSON.stringify(pids)}; wait`], 3_000] as const)
      : ([
          process.execPath,
          [
            '-e',
            [
              "const kid = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: ['ignore', 'inherit', 'inherit'] })",
              `require('node:fs').writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, kid.pid]))`,
              'setTimeout(() => {}, 600000)',
            ].join('\n'),
          ],
          10_000,
        ] as const)
    const result = await runProbe(cmd, [...args], { timeoutMs })
    expect(result.timedOut).toBe(true)
    expect(result.error?.message).toMatch(/did not answer within/)
    await expectGone(pids)
  }, 30_000)

  it('runProbe: stopped by its signal once the hung tree exists, it kills the whole tree and answers', async () => {
    const pids = path.join(sandbox, 'pids.json')
    const script = [
      "const kid = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: ['ignore', 'inherit', 'inherit'] })",
      `require('node:fs').writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, kid.pid]))`,
      'setTimeout(() => {}, 600000)',
    ].join('\n')
    const stop = new AbortController()
    const pending = runProbe(process.execPath, ['-e', script], { timeoutMs: 120_000, signal: stop.signal })
    await until(() => fs.existsSync(pids), 60_000)
    stop.abort()
    const result = await pending
    expect(result.error?.message).toMatch(/was stopped/)
    expect(result.timedOut).toBe(false)
    await expectGone(pids)
  }, 90_000)

  it('runProbe: an ordinary command answers with its exit code and output', async () => {
    const r = await runProbe(process.execPath, ['-e', "process.stdout.write('v1'); process.exit(3)"], { timeoutMs: 10_000 })
    expect(r).toMatchObject({ timedOut: false, status: 3, stdout: 'v1' })
    const missing = await runProbe(path.join(sandbox, 'no-such-binary'), ['--version'], { timeoutMs: 5_000 })
    expect(missing.error).toBeDefined()
    expect(missing.timedOut).toBe(false)
  })

  for (const [label, install, probe] of [
    ['claude --version', installFakeClaude, (cmd: string, signal: AbortSignal) => inspectClaudeRuntime(path.join(sandbox, '.claude'), cmd, 120_000, signal)],
    ['claude auth status', installFakeClaude, (cmd: string, signal: AbortSignal) => claudeSignIn(path.join(sandbox, '.claude'), cmd, 120_000, signal)],
    ['codex --version', installFakeCodex, (cmd: string, signal: AbortSignal) => inspectCodexRuntime(path.join(sandbox, '.codex'), cmd, 120_000, signal)],
    ['codex login status', installFakeCodex, (cmd: string, signal: AbortSignal) => codexIsLoggedIn(path.join(sandbox, '.codex'), cmd, 120_000, signal)],
  ] as const) {
    it(`${label} that hangs (through the .cmd shim on Windows): stopped once hung, it answers, and its whole tree is gone`, async () => {
      const fake = install(sandbox)
      const pids = path.join(sandbox, 'probe-pids.json')
      process.env['PATH'] = `${fake.binDir}${path.delimiter}${originalPath ?? ''}`
      process.env['FAKE_RUNTIME_PROBE_HANG'] = label.endsWith('--version') ? 'version' : 'auth'
      process.env['FAKE_RUNTIME_PROBE_PIDS'] = pids
      try {
        const cmd = label.startsWith('claude') ? 'claude' : 'codex'
        const stop = new AbortController()
        const pending = probe(cmd, stop.signal)
        await until(() => fs.existsSync(pids), 60_000)
        stop.abort()
        const answer = await pending
        // Said as stopped — never as a runtime missing from PATH or a user signed out.
        if ('signedIn' in answer) expect(answer).toEqual({ signedIn: false, unanswered: 'claude auth status was stopped' })
        else expect(answer).toEqual({ ok: false, detail: `${label} was stopped` })
        await expectGone(pids)
      } finally {
        delete process.env['FAKE_RUNTIME_PROBE_HANG']
        delete process.env['FAKE_RUNTIME_PROBE_PIDS']
      }
    }, 90_000)
  }

  it('a hung claude auth status is reported as not answering, not as signed out (the timeout path)', async () => {
    const fake = installFakeClaude(sandbox)
    const pids = path.join(sandbox, 'probe-pids.json')
    process.env['PATH'] = `${fake.binDir}${path.delimiter}${originalPath ?? ''}`
    process.env['FAKE_RUNTIME_PROBE_HANG'] = 'auth'
    process.env['FAKE_RUNTIME_PROBE_PIDS'] = pids
    try {
      // A slow start on a loaded machine still ends in the same answer; the tree is checked whenever it got as far as starting.
      expect(await claudeSignIn(path.join(sandbox, '.claude'), 'claude', 3_000)).toEqual({ signedIn: false, unanswered: 'claude auth status did not answer within 3 s (killed)' })
      if (fs.existsSync(pids)) await expectGone(pids)
      expect(await claudeIsLoggedIn(path.join(sandbox, '.claude'), 'claude', 3_000)).toBe(false)
      if (fs.existsSync(pids)) await expectGone(pids)
    } finally {
      delete process.env['FAKE_RUNTIME_PROBE_HANG']
      delete process.env['FAKE_RUNTIME_PROBE_PIDS']
    }
  }, 90_000)
})

// ─── Engine follow-ups ──────────────────────────────────────────────────────

describe('engine follow-ups', () => {
  it('Codex: an integration\'s runs pin the hosted server\'s URL on every profile, before the prompt (no other config layer can move it)', async () => {
    const fake = installFakeCodex(sandbox)
    process.env['PATH'] = `${fake.binDir}${path.delimiter}${originalPath ?? ''}`
    const env = { ...process.env, FAKE_RUNTIME_RECORD: fake.recordPath }
    for (const profile of ['answer', 'work', 'full'] as const) {
      const runner = new CodexRunner({ codexHome: path.join(sandbox, '.codex'), workdir: path.join(sandbox, 'w'), profile, apiKey: () => KEY, keyEnv: 'AGENTCHAT_API_KEY', pinMcpUrl: 'https://api.agentchat.me/mcp', env })
      const args = runner.args()
      expect(args.slice(-3)).toEqual(['-c', 'mcp_servers.agentchat.url="https://api.agentchat.me/mcp"', '-'])
      expect(await runner.preflight()).toEqual({ ok: true })
      expect((await runner.start({ kind: 'wake', prompt: 'P', runId: profile, budgetMs: 20_000 })).state).toBe('ok')
    }
    const { readFakeRuns } = await import('./helpers/fake-runtimes.js')
    for (const run of readFakeRuns(fake)) expect(run.argv).toContain('mcp_servers.agentchat.url="https://api.agentchat.me/mcp"')
  }, 30_000)

  it('an empty manual pointer adds nothing to a run\'s prompt', async () => {
    const double = await startServerDouble({ tray: { waiting: 1 } })
    const home = path.join(sandbox, 'home-pointer')
    fs.mkdirSync(home, { recursive: true })
    const seen: RunRequest[] = []
    const runner: RunRunner = { name: 'fake-runtime', preflight: async () => ({ ok: true }), start: async (r) => (seen.push(r), { state: 'ok', exitCode: 0, durationMs: 1 }) }
    const i = new Integration({ cfg: { apiKey: KEY, handle: 'me', apiBase: double.apiBase, wsBase: double.wsBase, home, workdir: path.join(home, 'w') }, runner, client: CLIENT, manualPointer: '', profile: 'answer', budgetMs: 60_000, quietMs: 50, maxMs: 200 })
    try {
      await i.start()
      await until(() => seen.length === 1, 5_000)
      expect(seen[0]?.prompt.endsWith('\n')).toBe(false)
      expect(seen[0]?.prompt).not.toContain('\n\n\n')
    } finally {
      await i.stopAndWait(5_000)
      await double.close()
    }
  }, 20_000)
})
