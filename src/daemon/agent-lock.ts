import * as crypto from 'node:crypto'
import * as os from 'node:os'
import * as path from 'node:path'
import { normalizeHandle } from '../skill/identity-line.js'
import { acquirePidLock, type LockAttempt, type LockHolder } from '../util/pid-lock.js'

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
// start time and identity home: nothing secret.

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

/** Hold this agent for this process (an identity home's daemon), or learn which live process does. */
export function acquireAgentLock(agent: { apiBase: string; handle: string; home: string }, env: NodeJS.ProcessEnv = process.env): LockAttempt {
  return acquirePidLock(agentLockPath(agent, env), { home: path.resolve(agent.home), label: `@${normalizeHandle(agent.handle)}` })
}

/** The status sentence for a daemon that does not serve its agent because another does. */
export function agentLockRefusal(agent: { handle: string; home: string }, holder: LockHolder | null, file: string): string {
  const who = holder === null ? `another process (${file})` : `${holder.home !== undefined ? holder.home : 'another identity home'} (pid ${holder.pid}${holder.acquired_at !== undefined ? `, since ${holder.acquired_at}` : ''})`
  return `@${normalizeHandle(agent.handle)} is served by ${who}: this one (${path.resolve(agent.home)}) holds no socket and starts no run while it does, so no message is answered twice. Stop that one, or log out here; this one takes over when it stops.`
}
