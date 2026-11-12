import * as path from 'node:path'
import { log } from '../util/log.js'
import { acquirePidLock, type HeldLock } from '../util/pid-lock.js'

// ─── Single-instance lock (per identity home) ───────────────────────────────
//
// Two daemons for one home = duplicate replies + socket thrash. `daemon.lock`
// in the home enforces one: created with O_EXCL, naming its holder's pid and
// start time; a stale one (holder gone, or the pid reused) is taken over
// atomically (`util/pid-lock.ts`). One agent served from two homes is the agent
// lock's business (`daemon/agent-lock.ts`).

export type LockHandle = HeldLock

export function acquireLeaderLock(home: string): LockHandle | null {
  const lockPath = path.join(home, 'daemon.lock')
  const attempt = acquirePidLock(lockPath, { home: path.resolve(home) })
  if (attempt.ok) return attempt.lock
  log.error(`another agentchat daemon already holds ${lockPath}${attempt.holder !== null ? ` (pid ${attempt.holder.pid})` : ''}`)
  return null
}
