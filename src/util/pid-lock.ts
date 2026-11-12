import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'

// ─── A lock file owned by one live process ──────────────────────────────────
//
// Acquired with O_EXCL (`wx`): of any number of processes creating it at once,
// exactly one succeeds. The file says who holds it: pid, the process's start
// time (so a reused pid is not mistaken for the holder), and what it serves.
//
// A lock whose holder is gone is stale, and is taken over atomically: only the
// holder of a short-lived guard (`<lock>.takeover`, itself O_EXCL) may remove a
// stale lock, it checks under the guard that the lock is still the one it judged
// stale, and the new owner then creates the lock with O_EXCL like anyone else.
// No process ever overwrites a lock in place, so two can never both believe
// they hold it.

/** Who holds a lock, as its file says. */
export interface LockHolder {
  readonly pid: number
  /** The holder's start time (epoch ms), or null in a lock an older release wrote (a bare pid). */
  readonly started_at: number | null
  /** What the holder serves (an identity home), when it said. */
  readonly home?: string
  /** A label for messages (a handle), when it said. */
  readonly label?: string
  readonly acquired_at?: string
}

export interface HeldLock {
  readonly path: string
  /** Remove the lock, if it is still this process's. Idempotent. */
  release(): void
}

export type LockAttempt = { readonly ok: true; readonly lock: HeldLock } | { readonly ok: false; readonly path: string; readonly holder: LockHolder | null }

/** This process's start time (epoch ms): when the runtime began, as precise as the platform's probes are coarse. */
export const PROCESS_STARTED_AT = Math.round(performance.timeOrigin)

/** How far a probed start time may differ from the recorded one and still be the same process (probes report whole seconds). */
const START_TOLERANCE_MS = 5_000
/** A lock file younger than this that cannot be parsed is being written, not stale. */
const WRITE_GRACE_MS = 5_000
/** A takeover guard older than this belongs to a takeover that died. */
const GUARD_STALE_MS = 10_000
const ATTEMPTS = 40
const BACKOFF_MS = 25

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
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

/**
 * When a process started (epoch ms), or null when the platform cannot say.
 * Linux: /proc/<pid>/stat field 22 (USER_HZ = 100) over /proc/stat `btime`;
 * macOS and other Unix: `ps -o lstart=`; Windows: `Get-Process`.
 */
export function processStartedAt(pid: number): number | null {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8')
      // The command name (field 2) is parenthesised and may hold spaces: split after it.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const ticks = Number(fields[19])
      const btime = Number(/^btime (\d+)$/m.exec(fs.readFileSync('/proc/stat', 'utf-8'))?.[1])
      return Number.isFinite(ticks) && Number.isFinite(btime) ? Math.round(btime * 1000 + (ticks * 1000) / 100) : null
    }
    if (process.platform === 'win32') {
      const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`], {
        encoding: 'utf-8',
        timeout: 10_000,
        windowsHide: true,
      })
      const at = Date.parse(String(out.stdout ?? '').trim())
      return out.status === 0 && Number.isFinite(at) ? at : null
    }
    // Local time, in the C locale's format, in this process's zone (the child inherits it): what Date.parse reads.
    const out = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf-8', timeout: 5_000, env: { ...process.env, LC_ALL: 'C' } })
    const at = Date.parse(String(out.stdout ?? '').trim())
    return out.status === 0 && Number.isFinite(at) ? at : null
  } catch {
    return null
  }
}

/**
 * Whether the process a lock names is the one that wrote it and is still
 * running. A reused pid (a different start time) is not. When the start time
 * cannot be probed, a live pid counts as the holder: refusing is safe, and the
 * refusal names the lock file.
 */
export function holderAlive(holder: LockHolder): boolean {
  if (!pidAlive(holder.pid)) return false
  if (holder.pid === process.pid) return holder.started_at === null || Math.abs(holder.started_at - PROCESS_STARTED_AT) <= START_TOLERANCE_MS
  if (holder.started_at === null) return true
  const observed = processStartedAt(holder.pid)
  return observed === null || Math.abs(observed - holder.started_at) <= START_TOLERANCE_MS
}

/** A lock file's holder: the JSON this module writes, or a bare pid (an older release); null when it says neither. */
export function parseHolder(raw: string): LockHolder | null {
  const text = raw.trim()
  if (/^\d+$/.test(text)) return { pid: Number(text), started_at: null }
  try {
    const parsed = JSON.parse(text) as Partial<LockHolder> | null
    if (parsed === null || typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid)) return null
    return {
      pid: parsed.pid,
      started_at: typeof parsed.started_at === 'number' ? parsed.started_at : null,
      ...(typeof parsed.home === 'string' ? { home: parsed.home } : {}),
      ...(typeof parsed.label === 'string' ? { label: parsed.label } : {}),
      ...(typeof parsed.acquired_at === 'string' ? { acquired_at: parsed.acquired_at } : {}),
    }
  } catch {
    return null
  }
}

function readRaw(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8')
  } catch {
    return null
  }
}

function ageMs(file: string): number {
  try {
    return Date.now() - fs.statSync(file).mtimeMs
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

/** Remove `file` only if it still holds exactly `content` (best effort; a guard against removing a lock someone else now holds). */
function removeIfStill(file: string, content: string): void {
  if (readRaw(file) !== content) return
  // Moved aside first, so a lock someone creates in between is never the one removed.
  const aside = `${file}.gone-${crypto.randomUUID()}`
  try {
    fs.renameSync(file, aside)
  } catch {
    return
  }
  if (readRaw(aside) === content) fs.rmSync(aside, { force: true })
  else {
    // Not the one judged (a new holder slipped in): put it back where it was.
    try {
      fs.linkSync(aside, file)
    } catch {
      /* a newer lock exists already; the moved one is no one's now */
    }
    fs.rmSync(aside, { force: true })
  }
}

/**
 * Acquire the lock at `file` for this process. Refused (with who holds it)
 * when a live process holds it; a stale one (its holder gone, or a reused pid)
 * is taken over atomically.
 */
export function acquirePidLock(file: string, info: { home?: string; label?: string } = {}): LockAttempt {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const content = `${JSON.stringify({ pid: process.pid, started_at: PROCESS_STARTED_AT, ...info, acquired_at: new Date().toISOString() })}\n`
  const guard = `${file}.takeover`
  let holder: LockHolder | null = null
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (createExclusive(file, content)) return { ok: true, lock: handleFor(file, content) }
    const raw = readRaw(file)
    if (raw === null) continue // removed in between: try to create again
    holder = parseHolder(raw)
    if (holder === null && ageMs(file) < WRITE_GRACE_MS) {
      sleepSync(BACKOFF_MS) // being written right now
      continue
    }
    if (holder !== null && holderAlive(holder)) return { ok: false, path: file, holder }
    // Stale. Only the guard's holder removes it.
    const guardContent = `${JSON.stringify({ pid: process.pid, started_at: PROCESS_STARTED_AT })}\n`
    if (!createExclusive(guard, guardContent)) {
      const g = parseHolder(readRaw(guard) ?? '')
      if ((g !== null && holderAlive(g) && ageMs(guard) < GUARD_STALE_MS) || (g === null && ageMs(guard) < WRITE_GRACE_MS)) {
        sleepSync(BACKOFF_MS) // another process is taking it over; see what it leaves
        continue
      }
      removeIfStill(guard, readRaw(guard) ?? '')
      continue
    }
    try {
      // Still the very lock judged stale? Then it goes; anything else is someone's.
      if (readRaw(file) === raw) removeIfStill(file, raw)
    } finally {
      removeIfStill(guard, guardContent)
    }
  }
  return { ok: false, path: file, holder }
}

function handleFor(file: string, content: string): HeldLock {
  let released = false
  return {
    path: file,
    release(): void {
      if (released) return
      released = true
      removeIfStill(file, content)
    },
  }
}

/** Who holds the lock at `file`, if a live process does. */
export function lockHolder(file: string): LockHolder | null {
  const holder = parseHolder(readRaw(file) ?? '')
  return holder !== null && holderAlive(holder) ? holder : null
}
