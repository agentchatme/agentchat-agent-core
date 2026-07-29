import * as fs from 'node:fs'
import * as path from 'node:path'

// Atomic write: tmp file + rename in the same directory. A crash mid-write
// leaves either the old file or a stray tmp — never a truncated JSON that
// would make every subsequent hook invocation throw.
export function atomicWriteFile(filePath: string, data: string, mode?: number): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`)
  fs.writeFileSync(tmp, data, mode === undefined ? {} : { mode })
  fs.renameSync(tmp, filePath)
  if (mode !== undefined) {
    // rename preserves the tmp file's mode, but be explicit in case the
    // file pre-existed with looser permissions.
    fs.chmodSync(filePath, mode)
  }
}

/** Crash-safe file replacement for shipped executable bundles. */
export function atomicCopyFile(source: string, destination: string, mode = 0o755): void {
  const dir = path.dirname(destination)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = path.join(dir, `.${path.basename(destination)}.${process.pid}.tmp`)
  try {
    fs.copyFileSync(source, tmp)
    fs.chmodSync(tmp, mode)
    fs.renameSync(tmp, destination)
    fs.chmodSync(destination, mode)
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* preserve the original error */
    }
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
