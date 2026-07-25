import * as fs from 'node:fs'
import * as path from 'node:path'
import { log } from '../util/log.js'

// ─── Single-instance lock (per identity) ────────────────────────────────────
//
// Two daemons for one agent = duplicate replies + WS thrash. A PID lockfile in
// the agent's home enforces one. If a stale lock is found (holder PID dead),
// we steal it. Portable (no native flock); good enough for one-box-per-agent.

export interface LockHandle {
  release(): void
}

export function acquireLeaderLock(home: string): LockHandle | null {
  const lockPath = path.join(home, 'daemon.lock')
  fs.mkdirSync(home, { recursive: true })

  const tryWrite = (): boolean => {
    try {
      const fd = fs.openSync(lockPath, 'wx') // fails if exists
      fs.writeSync(fd, String(process.pid))
      fs.closeSync(fd)
      return true
    } catch {
      return false
    }
  }

  if (tryWrite()) return makeHandle(lockPath)

  // Lock exists — is the holder alive?
  let holderPid = 0
  try {
    holderPid = Number.parseInt(fs.readFileSync(lockPath, 'utf-8').trim(), 10)
  } catch {
    /* unreadable — treat as stale */
  }
  if (holderPid && isAlive(holderPid)) {
    log.error(`another agentchatd already holds ${lockPath} (pid ${holderPid})`)
    return null
  }

  // Stale — steal it.
  log.warn(`stealing stale lock ${lockPath} (dead pid ${holderPid || '?'})`)
  try {
    fs.writeFileSync(lockPath, String(process.pid))
    return makeHandle(lockPath)
  } catch (err) {
    log.error(`could not steal stale lock: ${String(err)}`)
    return null
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0) // signal 0 = existence check
    return true
  } catch {
    return false
  }
}

function makeHandle(lockPath: string): LockHandle {
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    try {
      // Only remove if it's still ours.
      if (fs.readFileSync(lockPath, 'utf-8').trim() === String(process.pid)) {
        fs.unlinkSync(lockPath)
      }
    } catch {
      /* already gone */
    }
  }
  return { release }
}
