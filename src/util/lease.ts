import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// ─── A lock held by a live, renewing process: a lease ───────────────────────
//
// One file, created with O_EXCL (`wx`): of any number of processes creating it
// at once, exactly one succeeds. Its first line is the holder's bare pid — what
// readers from before this format (`parseInt` of the file: the Windows service
// reinstall, the 0.4.x leader lock) understand — then one line of JSON:
//
//   <pid>
//   {"pid":…,"token":"…","host":"…","home":"…","label":"…","acquired_at":"…","renewed_at":<epoch ms>}
//
// The holder rewrites it every RENEW_MS (a new `renewed_at`). Whether a holder
// is gone is decided by what a contender OBSERVES, not by comparing the
// holder's wall clock with its own (the Kubernetes leader-election rule): a
// lease is stale when its content (token + renewed_at) has not changed for
// STALE_MS on the contender's own monotonic clock since it first saw that
// content. A monotonic clock does not run while the machine sleeps, so after a
// laptop wakes the holder's next renewal (≤ RENEW_MS) arrives before any
// contender can judge it stale; wall-clock steps and another host's skew do not
// enter at all. One shortcut: a holder whose pid is dead on this host is gone
// at once.
//
// Taking over a stale lease, renewing one and releasing one all happen under a
// short O_EXCL guard (`<file>.takeover`), and no one but the holder writes the
// file. On every renewal the holder re-reads it and stands down at once if it
// is no longer its own (its token); a renewal that keeps failing (the folder
// gone, a full disk) for STALE_MS also stands it down — cleanly, never a crash.

export const LEASE_RENEW_MS = 10_000
export const LEASE_STALE_MS = 45_000

/** Who holds a lease, as its file says. */
export interface LeaseHolder {
  readonly pid: number
  /** Null in a lock written before leases (a bare pid). */
  readonly token: string | null
  readonly host: string | null
  readonly home?: string
  readonly label?: string
  readonly acquired_at?: string
  /** The holder's wall clock at its last renewal (informational: staleness is observed, not computed from it); null before leases. */
  readonly renewed_at: number | null
}

export interface Lease {
  readonly path: string
  /** True once the lease is no longer this process's (replaced, removed, unrenewable, or released). */
  readonly lost: boolean
  /** Renewals that failed (an error writing or reading the file), and the last one's message. */
  readonly renewErrors: number
  readonly lastRenewError: string | null
  /** Called once, when the lease is no longer this process's (not on `release`). */
  onLost(listener: (why: string) => void): void
  /** Give the lease up (stop renewing; remove the file if it is still ours). Idempotent; never throws. */
  release(): void
}

export type LeaseAttempt = { readonly ok: true; readonly lease: Lease } | { readonly ok: false; readonly path: string; readonly holder: LeaseHolder | null }

export interface LeaseOptions {
  readonly renewMs?: number
  readonly staleMs?: number
  /** Test seam: the wall clock (for `renewed_at` and file ages). */
  readonly now?: () => number
  /** Test seam: the monotonic clock (ms) staleness is observed on. Defaults to `performance.now()`, which does not run while the machine sleeps. */
  readonly monotonic?: () => number
  /** Test seam: when this machine booted (epoch ms). */
  readonly bootedAt?: () => number
}

const WRITE_GRACE_MS = 5_000
const GUARD_STALE_MS = 10_000
/** A lock file older than the current boot by more than this was written before it (its pid may be someone else's now). */
const BOOT_MARGIN_MS = 60_000
const ATTEMPTS = 40
const BACKOFF_MS = 25

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function hostname(): string {
  try {
    return os.hostname()
  } catch {
    return ''
  }
}

/** When this machine booted (epoch ms): now minus its uptime. */
export function bootedAt(now: number = Date.now()): number {
  return now - os.uptime() * 1000
}

/** Whether a pid names a live process (signal 0; EPERM means it exists under another user). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** A lease file's holder: `<pid>\n{json}`, or a bare pid (a lock from before leases); null when it says neither. */
export function parseLease(raw: string): LeaseHolder | null {
  const text = raw.trim()
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? ''
  if (!/^\d+$/.test(firstLine)) return null
  const pid = Number(firstLine)
  const rest = text.slice(firstLine.length).trim()
  if (rest.length === 0) return { pid, token: null, host: null, renewed_at: null }
  try {
    const j = JSON.parse(rest) as Record<string, unknown>
    return {
      pid,
      token: typeof j['token'] === 'string' ? j['token'] : null,
      host: typeof j['host'] === 'string' ? j['host'] : null,
      ...(typeof j['home'] === 'string' ? { home: j['home'] } : {}),
      ...(typeof j['label'] === 'string' ? { label: j['label'] } : {}),
      ...(typeof j['acquired_at'] === 'string' ? { acquired_at: j['acquired_at'] } : {}),
      renewed_at: typeof j['renewed_at'] === 'number' && Number.isFinite(j['renewed_at']) ? j['renewed_at'] : null,
    }
  } catch {
    return null
  }
}

const sameHost = (holder: LeaseHolder): boolean => holder.host === null || holder.host === hostname()

/** A lock from before leases (a bare pid): there while its pid lives — unless the file predates this boot (the pid is someone else's now). */
function legacyLive(holder: LeaseHolder, mtimeMs: number | null, booted: number): boolean {
  if (!pidAlive(holder.pid)) return false
  return mtimeMs === null || mtimeMs >= booted - BOOT_MARGIN_MS
}

/**
 * A one-look judgement (no history): for naming a holder and for the service
 * reinstall, which stops the daemon a lock names only when it is really there.
 * A dead pid on this host is gone; a lock from before leases is judged by its
 * pid and the boot; a lease by a renewal within `staleMs` of this wall clock.
 * Taking a lease over uses the observed rule (`acquireLease`), never this.
 */
export function holderLive(holder: LeaseHolder, at: { now?: number; staleMs?: number; mtimeMs?: number | null; bootedAt?: number } = {}): boolean {
  const now = at.now ?? Date.now()
  if (holder.renewed_at === null) return legacyLive(holder, at.mtimeMs ?? null, at.bootedAt ?? bootedAt(now))
  if (sameHost(holder) && !pidAlive(holder.pid)) return false
  return Math.abs(now - holder.renewed_at) < (at.staleMs ?? LEASE_STALE_MS)
}

/** What a contender has seen of each lease: its content, and when (monotonic) it first saw that content. */
const observations = new Map<string, { readonly signature: string; readonly firstSeen: number }>()

/**
 * The observed judgement a contender takes over by: 'held', 'stale', or
 * 'writing' (a file being created right now).
 */
function judge(file: string, holder: LeaseHolder | null, ctx: { now: number; mono: number; staleMs: number; booted: number }): 'held' | 'stale' | 'writing' {
  if (holder === null) return mtimeOf(file) !== null && ctx.now - (mtimeOf(file) ?? 0) < WRITE_GRACE_MS ? 'writing' : 'stale'
  if (holder.renewed_at === null) return legacyLive(holder, mtimeOf(file), ctx.booted) ? 'held' : 'stale'
  if (sameHost(holder) && !pidAlive(holder.pid)) return 'stale'
  const signature = `${holder.token ?? ''}\u0000${holder.renewed_at}`
  const seen = observations.get(file)
  if (seen === undefined || seen.signature !== signature) {
    observations.set(file, { signature, firstSeen: ctx.mono })
    return 'held'
  }
  return ctx.mono - seen.firstSeen >= ctx.staleMs ? 'stale' : 'held'
}

function readRaw(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8')
  } catch {
    return null
  }
}

function mtimeOf(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return null
  }
}

/** Create `file` with `content` only if it does not exist (O_EXCL). False when it exists. */
function createExclusive(file: string, content: string): boolean {
  let fd: number
  try {
    fd = fs.openSync(file, 'wx', 0o600)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
  try {
    fs.writeSync(fd, content)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  return true
}

/** Remove `file` if it still holds exactly `content`: moved aside first, so a file created in between is never the one removed. */
function removeIfStill(file: string, content: string): void {
  if (readRaw(file) !== content) return
  const aside = `${file}.gone-${crypto.randomUUID()}`
  try {
    fs.renameSync(file, aside)
  } catch {
    return
  }
  if (readRaw(aside) === content) fs.rmSync(aside, { force: true })
  else {
    try {
      fs.linkSync(aside, file)
    } catch {
      /* a newer file exists already */
    }
    fs.rmSync(aside, { force: true })
  }
}

/** Replace `file` with `content` (the holder renewing): a temp file renamed over it; in place where a rename over an open file is refused (Windows). */
function replaceContent(file: string, content: string): void {
  const temp = `${file}.renew-${crypto.randomUUID()}`
  try {
    fs.writeFileSync(temp, content, { mode: 0o600 })
    fs.renameSync(temp, file)
  } catch {
    fs.rmSync(temp, { force: true })
    fs.writeFileSync(file, content, { mode: 0o600 })
  }
}

/** Run `fn` holding the guard (`<file>.takeover`, O_EXCL). False when another process holds it now. Throws only what `fn` or the file system throws. */
function withGuard(file: string, now: number, fn: () => void): boolean {
  const guard = `${file}.takeover`
  const mine = `${process.pid}\n${JSON.stringify({ pid: process.pid, token: crypto.randomUUID(), host: hostname(), renewed_at: now })}\n`
  if (!createExclusive(guard, mine)) {
    // A guard whose holder died (on this host), or one left far longer than any guarded step takes, is removed.
    const raw = readRaw(guard)
    const g = raw === null ? null : parseLease(raw)
    const dead = g !== null && sameHost(g) && !pidAlive(g.pid)
    if (raw !== null && (dead || now - (mtimeOf(guard) ?? now) > GUARD_STALE_MS)) removeIfStill(guard, raw)
    return false
  }
  try {
    fn()
  } finally {
    removeIfStill(guard, mine)
  }
  return true
}

/**
 * Acquire the lease at `file`. Refused (naming the holder) while a holder is
 * there; a stale one — by the observed rule — is taken over under the guard.
 * Async: it waits on other processes without blocking this one.
 */
export async function acquireLease(file: string, info: { home?: string; label?: string } = {}, options: LeaseOptions = {}): Promise<LeaseAttempt> {
  const now = options.now ?? Date.now
  const mono = options.monotonic ?? (() => performance.now())
  const staleMs = options.staleMs ?? LEASE_STALE_MS
  const booted = (options.bootedAt ?? (() => bootedAt(now())))()
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const token = crypto.randomUUID()
  const acquiredAt = new Date(now()).toISOString()
  const render = (renewedAt: number): string =>
    `${process.pid}\n${JSON.stringify({ pid: process.pid, token, host: hostname(), ...info, acquired_at: acquiredAt, renewed_at: renewedAt })}\n`
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (createExclusive(file, render(now()))) {
      observations.delete(file)
      return { ok: true, lease: startLease(file, token, render, options) }
    }
    const raw = readRaw(file)
    if (raw === null) continue // removed in between: create again
    const holder = parseLease(raw)
    const verdict = judge(file, holder, { now: now(), mono: mono(), staleMs, booted })
    if (verdict === 'writing') {
      await sleep(BACKOFF_MS)
      continue
    }
    if (verdict === 'held') return { ok: false, path: file, holder }
    // Stale: removed under the guard, if it is still the very file judged stale.
    if (!withGuard(file, now(), () => removeIfStill(file, raw))) await sleep(BACKOFF_MS)
  }
  // Contended past every attempt: name a holder only if one is there by a one-look judgement.
  const raw = readRaw(file)
  const holder = raw === null ? null : parseLease(raw)
  return { ok: false, path: file, holder: holder !== null && holderLive(holder, { now: now(), staleMs, mtimeMs: mtimeOf(file), bootedAt: booted }) ? holder : null }
}

function startLease(file: string, token: string, render: (renewedAt: number) => string, options: LeaseOptions): Lease {
  const now = options.now ?? Date.now
  const mono = options.monotonic ?? (() => performance.now())
  const staleMs = options.staleMs ?? LEASE_STALE_MS
  const listeners: Array<(why: string) => void> = []
  let lost = false
  let renewErrors = 0
  let lastRenewError: string | null = null
  let lastRenewedMono = mono()
  // What createExclusive just wrote (for a release that cannot take the guard).
  let content = readRaw(file) ?? ''
  const loseIt = (why: string): void => {
    if (lost) return
    lost = true
    clearInterval(timer)
    for (const l of listeners) {
      try {
        l(why)
      } catch {
        /* a listener's failure is its own */
      }
    }
  }
  const renew = (): void => {
    if (lost) return
    try {
      const done = withGuard(file, now(), () => {
        const raw = readRaw(file)
        const holder = raw === null ? null : parseLease(raw)
        if (holder?.token !== token) {
          loseIt(raw === null ? `${file} was removed` : `${file} now names another holder (pid ${holder?.pid ?? '?'})`)
          return
        }
        const next = render(now())
        replaceContent(file, next)
        content = next
        lastRenewedMono = mono()
      })
      if (!done && mono() - lastRenewedMono >= staleMs) loseIt(`could not renew ${file} for ${Math.round(staleMs / 1000)} s (its guard stayed taken)`)
    } catch (err) {
      // The folder gone, a full disk, permissions: never a crash. Counted; a
      // lease that cannot be renewed for as long as others wait is given up.
      renewErrors += 1
      lastRenewError = err instanceof Error ? err.message : String(err)
      if (readRaw(file) === null) loseIt(`${file} is gone (${lastRenewError})`)
      else if (mono() - lastRenewedMono >= staleMs) loseIt(`could not renew ${file} for ${Math.round(staleMs / 1000)} s (${lastRenewError})`)
    }
  }
  const timer = setInterval(renew, options.renewMs ?? LEASE_RENEW_MS)
  timer.unref()
  return {
    path: file,
    get lost() {
      return lost
    },
    get renewErrors() {
      return renewErrors
    },
    get lastRenewError() {
      return lastRenewError
    },
    onLost(listener) {
      listeners.push(listener)
    },
    release() {
      if (lost) return
      lost = true
      clearInterval(timer)
      try {
        // Under the guard when it is free; otherwise only if the file is still exactly ours.
        const done = withGuard(file, now(), () => {
          const raw = readRaw(file)
          if (raw !== null && parseLease(raw)?.token === token) removeIfStill(file, raw)
        })
        if (!done) removeIfStill(file, readRaw(file) === content ? content : '\u0000')
      } catch {
        /* the lease expires for others on its own */
      }
    },
  }
}

/** The holder of the lease at `file` by a one-look judgement (`holderLive`), or null. */
export function leaseHolder(file: string, staleMs: number = LEASE_STALE_MS): LeaseHolder | null {
  const raw = readRaw(file)
  const holder = raw === null ? null : parseLease(raw)
  return holder !== null && holderLive(holder, { staleMs, mtimeMs: mtimeOf(file) }) ? holder : null
}

/** Test seam: forget what this process has observed of leases. */
export function resetLeaseObservations(): void {
  observations.clear()
}
