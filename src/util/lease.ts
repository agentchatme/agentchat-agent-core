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
// The holder renews `renewed_at` every RENEW_MS. A holder is gone when its pid
// is dead on this host, or — whatever the pid says (reused, or alive under
// another user: EPERM) — when it has not renewed for STALE_MS. No process
// start-time probes (`ps`, PowerShell): time zones, DST and a reboot's reused
// pid cannot fool a renewal clock.
//
// Taking over a stale lease, renewing one and releasing one all happen under a
// short O_EXCL guard (`<file>.takeover`), and the file is never overwritten by
// anyone but its holder. On every renewal the holder re-reads the file and
// stands down at once if it is no longer its own (its token).
//
// Clock steps: a backward step makes a dead lease look fresher, delaying a
// takeover by at most the step; a forward step can make a live lease look stale,
// so a contender may take over — then the old holder's next renewal (≤ RENEW_MS)
// finds a token not its own and stands down: one overlap of at most one renewal
// interval. A dead pid on this host is stale at once, clock or no clock.

export const LEASE_RENEW_MS = 10_000
export const LEASE_STALE_MS = 45_000

/** Who holds a lease, as its file says. */
export interface LeaseHolder {
  readonly pid: number
  /** Null in a lock written before leases (a bare pid): judged by its pid alone. */
  readonly token: string | null
  readonly host: string | null
  readonly home?: string
  readonly label?: string
  readonly acquired_at?: string
  /** Epoch ms of the last renewal; null in a lock written before leases. */
  readonly renewed_at: number | null
}

export interface Lease {
  readonly path: string
  /** True once the lease is no longer this process's (replaced, removed, or released). */
  readonly lost: boolean
  /** Called once, when a renewal finds the lease is no longer this process's. */
  onLost(listener: (why: string) => void): void
  /** Give the lease up (stop renewing; remove the file if it is still ours). Idempotent. */
  release(): void
}

export type LeaseAttempt = { readonly ok: true; readonly lease: Lease } | { readonly ok: false; readonly path: string; readonly holder: LeaseHolder | null }

export interface LeaseOptions {
  readonly renewMs?: number
  readonly staleMs?: number
  /** Test seam: the clock. */
  readonly now?: () => number
}

const WRITE_GRACE_MS = 5_000
const GUARD_STALE_MS = 10_000
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

/**
 * Whether a lease's holder is still there: a lock from before leases by its pid
 * alone; otherwise a dead pid on this host is gone at once, and anything else
 * is there while its renewal is fresh.
 */
export function holderLive(holder: LeaseHolder, now: number = Date.now(), staleMs: number = LEASE_STALE_MS): boolean {
  if (holder.renewed_at === null) return pidAlive(holder.pid)
  const sameHost = holder.host === null || holder.host === hostname()
  if (sameHost && !pidAlive(holder.pid)) return false
  return now - holder.renewed_at < staleMs
}

function readRaw(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8')
  } catch {
    return null
  }
}

function ageMs(file: string, now: number): number {
  try {
    return now - fs.statSync(file).mtimeMs
  } catch {
    return Infinity
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

/** Run `fn` holding the guard (`<file>.takeover`, O_EXCL). False when another process holds it now. */
function withGuard(file: string, now: number, fn: () => void): boolean {
  const guard = `${file}.takeover`
  const mine = `${process.pid}\n${JSON.stringify({ pid: process.pid, token: crypto.randomUUID(), host: hostname(), renewed_at: now })}\n`
  if (!createExclusive(guard, mine)) {
    // A guard whose holder died (on this host), or one left far longer than any guarded step takes, is removed.
    const raw = readRaw(guard)
    const g = raw === null ? null : parseLease(raw)
    const dead = g !== null && (g.host === null || g.host === hostname()) && !pidAlive(g.pid)
    if (raw !== null && (dead || ageMs(guard, now) > GUARD_STALE_MS)) removeIfStill(guard, raw)
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
 * Acquire the lease at `file`. Refused (naming the holder) while a live holder
 * has it; a stale one is taken over under the guard. Async: it waits on other
 * processes without blocking this one.
 */
export async function acquireLease(file: string, info: { home?: string; label?: string } = {}, options: LeaseOptions = {}): Promise<LeaseAttempt> {
  const now = options.now ?? Date.now
  const staleMs = options.staleMs ?? LEASE_STALE_MS
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const token = crypto.randomUUID()
  const acquiredAt = new Date(now()).toISOString()
  const render = (renewedAt: number): string =>
    `${process.pid}\n${JSON.stringify({ pid: process.pid, token, host: hostname(), ...info, acquired_at: acquiredAt, renewed_at: renewedAt })}\n`
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (createExclusive(file, render(now()))) return { ok: true, lease: startLease(file, token, render, options) }
    const raw = readRaw(file)
    if (raw === null) continue // removed in between: create again
    const holder = parseLease(raw)
    if (holder === null && ageMs(file, now()) < WRITE_GRACE_MS) {
      await sleep(BACKOFF_MS) // being written right now
      continue
    }
    if (holder !== null && holderLive(holder, now(), staleMs)) return { ok: false, path: file, holder }
    // Stale: removed under the guard, if it is still the very file judged stale.
    if (!withGuard(file, now(), () => removeIfStill(file, raw))) await sleep(BACKOFF_MS)
  }
  // Contended past every attempt: name a holder only if one is live now.
  const raw = readRaw(file)
  const holder = raw === null ? null : parseLease(raw)
  return { ok: false, path: file, holder: holder !== null && holderLive(holder, now(), staleMs) ? holder : null }
}

function startLease(file: string, token: string, render: (renewedAt: number) => string, options: LeaseOptions): Lease {
  const now = options.now ?? Date.now
  const listeners: Array<(why: string) => void> = []
  let lost = false
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
    withGuard(file, now(), () => {
      const raw = readRaw(file)
      const holder = raw === null ? null : parseLease(raw)
      if (holder?.token !== token) {
        loseIt(raw === null ? `${file} was removed` : `${file} now names another holder (pid ${holder?.pid ?? '?'})`)
        return
      }
      const next = render(now())
      replaceContent(file, next)
      content = next
    })
  }
  const timer = setInterval(renew, options.renewMs ?? LEASE_RENEW_MS)
  timer.unref()
  return {
    path: file,
    get lost() {
      return lost
    },
    onLost(listener) {
      listeners.push(listener)
    },
    release() {
      if (lost) return
      lost = true
      clearInterval(timer)
      // Under the guard when it is free; otherwise only if the file is still exactly ours.
      const done = withGuard(file, now(), () => {
        const raw = readRaw(file)
        if (raw !== null && parseLease(raw)?.token === token) removeIfStill(file, raw)
      })
      if (!done) removeIfStill(file, readRaw(file) === content ? content : '\u0000')
    },
  }
}

/** The live holder of the lease at `file`, or null. */
export function leaseHolder(file: string, staleMs: number = LEASE_STALE_MS): LeaseHolder | null {
  const raw = readRaw(file)
  const holder = raw === null ? null : parseLease(raw)
  return holder !== null && holderLive(holder, Date.now(), staleMs) ? holder : null
}
