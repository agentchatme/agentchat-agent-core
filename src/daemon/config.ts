import * as path from 'node:path'
import { resolveIdentity } from '../identity/credentials.js'
import { getMeLite } from '../wire/index.js'

// ─── Daemon identity resolution ─────────────────────────────────────────────
//
// The daemon runs AS one host agent — the same identity that agent's in-session
// hooks use, never a separate account. It reads that credential from the home
// it is GIVEN.
//
// The predecessor of this file mapped a `runtime` enum to a home
// (`codex → ~/.codex/agentchat`, `claude-code → ~/.claude/agentchat`). That
// mapping is exactly the "a function that decides can decide wrong" defect this
// package exists to make unrepresentable, so it is gone: the caller passes its
// own home and there is no enum to mis-set.

export interface DaemonConfig {
  apiKey: string
  handle: string
  apiBase: string
  wsUrl: string
  /** The identity home. Credentials, leader lock, and heartbeat all live here. */
  home: string
  /** Scratch dir for the adapter (spawned-turn cwd, generated MCP config). */
  workdir: string
}

/** `https://api.agentchat.me` → `wss://api.agentchat.me/v1/ws`. */
export function wsUrlFor(apiBase: string): string {
  return apiBase.replace(/^http/, 'ws').replace(/\/+$/, '') + '/v1/ws'
}

export interface ResolveDaemonOpts {
  /** THE identity home. Required — this module never derives one. */
  home: string
  workdir?: string
}

/**
 * Resolve the identity the daemon runs as.
 *
 * Async because the handle is load-bearing at runtime — it filters this agent's
 * own outbound echoed back by server fan-out, and decides whether a group
 * mention names it. An env-only identity (`AGENTCHAT_API_KEY`, no credentials
 * file) has no handle on disk, so we ask the server rather than starting up
 * blind and replying to ourselves.
 */
export async function resolveDaemonConfig(opts: ResolveDaemonOpts): Promise<DaemonConfig> {
  const home = path.resolve(opts.home)
  const id = resolveIdentity(home)
  if (id === null) {
    throw new Error(`no AgentChat identity in ${home} — register this agent first`)
  }

  let handle = id.handle
  if (handle === null) {
    const me = await getMeLite({ apiKey: id.apiKey, apiBase: id.apiBase })
    if (me === null) {
      throw new Error(
        'could not determine this agent’s handle (no credentials file, and /v1/agents/me did not answer)',
      )
    }
    handle = me.handle
  }

  return {
    apiKey: id.apiKey,
    handle,
    apiBase: id.apiBase,
    wsUrl: wsUrlFor(id.apiBase),
    home,
    workdir: opts.workdir ?? path.join(home, 'daemon-workdir'),
  }
}
