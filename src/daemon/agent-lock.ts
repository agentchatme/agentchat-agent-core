import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { normalizeHandle } from '../skill/identity-line.js'
import { acquireLease, parseLease, pidAlive, type LeaseAttempt, type LeaseHolder, type LeaseOptions } from '../util/lease.js'

// ─── One agent, one listener ────────────────────────────────────────────────
//
// Two identity homes can hold the same agent's key — a CLI listener's home and
// an integration's — and each would hold a socket and start a run per wake:
// every message answered twice. The agent lock is one file per agent in a
// per-user folder every front door reads; the first daemon to hold it serves
// the agent, any other stays idle (no socket, no run) and says which home
// serves it, and takes over when that one stops.
//
// The file is named by a hash of the API origin and the agent's handle (what
// the server knows the agent by) — never the key. It names the holder's pid,
// host, identity home and last renewal: nothing secret.

/** Overrides the folder (tests and sandboxes). Two listeners given different folders do not see each other. */
export const AGENT_LOCK_DIR_ENV = 'AGENTCHAT_LOCK_DIR'

/**
 * The per-user folder the agent locks live in. Derived from the home folder
 * only — not XDG_STATE_HOME or LOCALAPPDATA, which a service's environment
 * and a shell's can disagree on:
 *
 *   macOS    ~/Library/Application Support/AgentChat/locks
 *   Windows  %USERPROFILE%\AppData\Local\AgentChat\locks
 *   other    ~/.local/state/agentchat/locks
 *
 * Created owner-only (0700).
 */
export function agentLockDir(env: NodeJS.ProcessEnv = process.env, system: NodeJS.Platform = process.platform, home: string = os.homedir()): string {
  const override = env[AGENT_LOCK_DIR_ENV]?.trim()
  if (override !== undefined && override.length > 0) return path.resolve(override)
  const p = system === 'win32' ? path.win32 : path.posix
  if (system === 'darwin') return p.join(home, 'Library', 'Application Support', 'AgentChat', 'locks')
  if (system === 'win32') return p.join(home, 'AppData', 'Local', 'AgentChat', 'locks')
  return p.join(home, '.local', 'state', 'agentchat', 'locks')
}

/** `https://API.agentchat.me/` → `https://api.agentchat.me`; a value that is not a URL is used as given. */
function originOf(apiBase: string): string {
  try {
    return new URL(apiBase).origin.toLowerCase()
  } catch {
    return apiBase.trim().toLowerCase()
  }
}

/** The agent lock's file for an agent: `agent-<32 hex>.lock`, the hash of its API origin and handle. */
export function agentLockPath(agent: { apiBase: string; handle: string }, env: NodeJS.ProcessEnv = process.env): string {
  const id = crypto.createHash('sha256').update(`${originOf(agent.apiBase)}\n${normalizeHandle(agent.handle)}`).digest('hex').slice(0, 32)
  return path.join(agentLockDir(env), `agent-${id}.lock`)
}

/**
 * Hold this agent for this process (an identity home's daemon), or learn which
 * live process does. The lock is a lease (`util/lease.ts`): renewed while held,
 * stale 45 s after its holder stops renewing (at once when its pid is dead on
 * this host); a holder that finds it replaced stands down (`Lease.onLost`).
 */
export function acquireAgentLock(agent: { apiBase: string; handle: string; home: string }, env: NodeJS.ProcessEnv = process.env, options: LeaseOptions = {}): Promise<LeaseAttempt> {
  return acquireLease(agentLockPath(agent, env), { home: path.resolve(agent.home), label: `@${normalizeHandle(agent.handle)}` }, options)
}

/** The status sentence for a daemon that does not serve its agent because another does (or the lock is contended right now). */
export function agentLockRefusal(agent: { handle: string; home: string }, holder: LeaseHolder | null, file: string): string {
  const who =
    holder === null
      ? `another listener (its lock ${file} is being taken over right now)`
      : `${holder.home !== undefined ? holder.home : 'another identity home'} (pid ${holder.pid}${holder.host !== null ? ` on ${holder.host}` : ''}${holder.acquired_at !== undefined ? `, since ${holder.acquired_at}` : ''})`
  return `@${normalizeHandle(agent.handle)} is served by ${who}: this one (${path.resolve(agent.home)}) holds no socket and starts no run while it does, so no message is answered twice. Stop that one, or log out here; this one takes over when it stops.`
}

// ─── Standby markers: a healthy listener is waiting ─────────────────────────
//
// A holder whose runs fail for a runtime reason gives the agent up only when a
// healthy listener for it is actually waiting — a lone install keeps its socket
// (wakes keep arriving, are counted, and each starts a run). A standby says it
// is waiting with a marker beside the lease (`<lock>.standby-<hash of its home>`),
// rewritten on every standby poll and removed when it stops waiting. A marker
// older than STANDBY_MARKER_FRESH_MS, or one whose pid is dead on this host, is
// nobody. A refused key is given up whatever waits: that home cannot serve.

/** How fresh a standby marker must be to count (three standby polls). */
export const STANDBY_MARKER_FRESH_MS = 90_000

function hostnameOf(): string {
  try {
    return os.hostname()
  } catch {
    return ''
  }
}

/** The marker a standby in `home` keeps beside the agent lock at `lockFile`. */
export function standbyMarkerPath(lockFile: string, home: string): string {
  return `${lockFile}.standby-${crypto.createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 16)}`
}

/** Say (again) that the standby in `home` is waiting to serve the agent. Best effort; never throws. */
export function markStandby(lockFile: string, home: string): void {
  const file = standbyMarkerPath(lockFile, home)
  const content = `${process.pid}\n${JSON.stringify({ pid: process.pid, host: hostnameOf(), home: path.resolve(home), at: Date.now() })}\n`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.${crypto.randomUUID()}`
    fs.writeFileSync(temp, content, { mode: 0o600 })
    fs.renameSync(temp, file)
  } catch {
    /* no marker: the holder simply keeps serving */
  }
}

/** The standby in `home` no longer waits (it serves now, or stops). Never throws. */
export function clearStandby(lockFile: string, home: string): void {
  try {
    fs.rmSync(standbyMarkerPath(lockFile, home), { force: true })
  } catch {
    /* gone already */
  }
}

/** Whether a healthy standby other than `home` is waiting for the agent at `lockFile`. */
export function standbyWaiting(lockFile: string, home: string, now: number = Date.now()): boolean {
  const own = standbyMarkerPath(lockFile, home)
  const prefix = `${path.basename(lockFile)}.standby-`
  let names: string[]
  try {
    names = fs.readdirSync(path.dirname(lockFile))
  } catch {
    return false
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || name.includes('.', prefix.length)) continue
    const file = path.join(path.dirname(lockFile), name)
    if (file === own) continue
    try {
      const st = fs.statSync(file)
      if (Math.abs(now - st.mtimeMs) >= STANDBY_MARKER_FRESH_MS) continue
      const marker = parseLease(fs.readFileSync(file, 'utf-8'))
      if (marker === null) continue
      const sameHost = marker.host === null || marker.host === hostnameOf()
      if (sameHost && !pidAlive(marker.pid)) continue
      return true
    } catch {
      continue
    }
  }
  return false
}
