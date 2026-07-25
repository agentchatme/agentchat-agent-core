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

export function readJsonFile<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}
