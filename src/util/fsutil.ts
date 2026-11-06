import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ─── Atomic replacement ─────────────────────────────────────────────────────
//
// Tmp file + rename in the same directory: a reader sees the old file or the
// new one, never part of one, and a crash leaves the old file or a stray tmp —
// never a truncated JSON that would make every later invocation throw. A
// failed write removes its tmp file and leaves the old file exactly as it was.
//
// The tmp file is never a path someone else can prepare: its name carries a
// random suffix, it is created exclusively (`wx`: O_CREAT|O_EXCL, which
// refuses an existing name — a planted symlink included — instead of following
// it), its mode is set on the open descriptor rather than on a path, and its
// contents are flushed before the rename. On Windows a rename onto a file
// another process has open fails transiently (EPERM / EBUSY / EACCES while a
// scanner or an editor holds it), so the rename is retried for ~100 ms.

/** A fresh, unguessable tmp name beside `file`. */
function tmpPathFor(file: string): string {
  return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
}

const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RENAME_ATTEMPTS = 6
const RENAME_DELAY_MS = 20

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export interface RenameRetryOptions {
  /** Defaults to `fs.renameSync`; injectable for tests. */
  readonly rename?: (from: string, to: string) => void
  /** Defaults to Windows only, where the transient sharing errors happen. */
  readonly retry?: boolean
  readonly attempts?: number
  readonly delayMs?: number
}

/** `renameSync`, retried a few times over ~100 ms on a transient EPERM / EBUSY / EACCES (Windows). */
export function renameWithRetry(from: string, to: string, options: RenameRetryOptions = {}): void {
  const rename = options.rename ?? ((a: string, b: string) => fs.renameSync(a, b))
  const retry = options.retry ?? process.platform === 'win32'
  const attempts = retry ? (options.attempts ?? RENAME_ATTEMPTS) : 1
  for (let attempt = 1; ; attempt++) {
    try {
      rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= attempts || code === undefined || !RENAME_RETRY_CODES.has(code)) throw err
      sleepSync(options.delayMs ?? RENAME_DELAY_MS)
    }
  }
}

function removeQuietly(file: string): void {
  try {
    fs.rmSync(file, { force: true })
  } catch {
    /* preserve the original error */
  }
}

/** `mode` is set exactly (whatever the umask); without one the file gets the umask's default, as `writeFileSync` would. */
export function atomicWriteFile(filePath: string, data: string | Uint8Array, mode?: number): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = tmpPathFor(filePath)
  try {
    const fd = fs.openSync(tmp, 'wx', mode ?? 0o666)
    try {
      if (mode !== undefined) fs.fchmodSync(fd, mode)
      fs.writeFileSync(fd, data)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    renameWithRetry(tmp, filePath)
  } catch (err) {
    removeQuietly(tmp)
    throw err
  }
}

/** Crash-safe file replacement for shipped executable bundles. */
export function atomicCopyFile(source: string, destination: string, mode = 0o755): void {
  const dir = path.dirname(destination)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = tmpPathFor(destination)
  try {
    fs.copyFileSync(source, tmp, fs.constants.COPYFILE_EXCL)
    const fd = fs.openSync(tmp, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    try {
      fs.fchmodSync(fd, mode)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    renameWithRetry(tmp, destination)
  } catch (err) {
    removeQuietly(tmp)
    throw err
  }
}

export function readJsonFile<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}
