import * as path from 'node:path'
import { log } from '../util/log.js'
import { acquireLease, type Lease, type LeaseOptions } from '../util/lease.js'

// ─── Single-instance lock (per identity home) ───────────────────────────────
//
// Two daemons for one home = duplicate replies + socket thrash. `daemon.lock`
// in the home enforces one: a lease (`util/lease.ts`) — created with O_EXCL,
// renewed by its holder, taken over under a guard when its holder is gone.
// Its first line is the holder's bare pid, as older readers expect (the
// Windows service reinstall stops the daemon by it; a 0.4.x daemon reads it to
// decide the lock is held). One agent served from two homes is the agent
// lock's business (`daemon/agent-lock.ts`).

export type LockHandle = Lease

/** The leader lock's file name in an identity home (consumers that stop or inspect a daemon read it). */
export const DAEMON_LOCK_FILE = 'daemon.lock'

export async function acquireLeaderLock(home: string, options: LeaseOptions = {}): Promise<LockHandle | null> {
  const lockPath = path.join(home, DAEMON_LOCK_FILE)
  const attempt = await acquireLease(lockPath, { home: path.resolve(home) }, options)
  if (attempt.ok) return attempt.lease
  log.error(`another agentchat daemon already holds ${lockPath}${attempt.holder !== null ? ` (pid ${attempt.holder.pid})` : ''}`)
  return null
}
