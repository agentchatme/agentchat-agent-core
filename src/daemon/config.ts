import * as path from 'node:path'
import { AgentChatClient } from 'agentchatme'
import { resolveIdentity } from '../identity/credentials.js'
import { clientIdentityOf, type IntegrationClient } from '../client-identity.js'

// ─── Daemon identity resolution ─────────────────────────────────────────────
//
// The daemon runs AS one host agent — the same identity that agent's sessions
// use through the hosted tools, never a separate account. It reads that
// credential from the home it is GIVEN.
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
  /** `wss://api.agentchat.me` — the SDK's socket base; it appends `/v1/ws`. */
  wsBase: string
  /** The identity home. Credentials, leader lock, and heartbeat all live here. */
  home: string
  /** Scratch dir for runs (the headless run's cwd). */
  workdir: string
}

/** `https://api.agentchat.me` → `wss://api.agentchat.me`. */
export function wsBaseFor(apiBase: string): string {
  return apiBase.replace(/^http/, 'ws').replace(/\/+$/, '')
}

/** `https://api.agentchat.me` → `wss://api.agentchat.me/v1/ws`, for logs and checks. */
export function wsUrlFor(apiBase: string): string {
  return `${wsBaseFor(apiBase)}/v1/ws`
}

export interface ResolveDaemonOpts {
  /** THE identity home. Required — this module never derives one. */
  home: string
  /** The run workdir. Required — this module never derives one either. */
  workdir: string
  /** How to identify to the server when the handle has to be asked for. */
  client: IntegrationClient
}

/**
 * Resolve the identity the daemon runs as.
 *
 * Async because the handle is load-bearing at runtime — it filters this agent's
 * own outbound echoed back by server fan-out. An env-only identity
 * (`AGENTCHAT_API_KEY`, no credentials file) has no handle on disk, so we ask
 * the server rather than starting up blind and waking on ourselves.
 */
export async function resolveDaemonConfig(opts: ResolveDaemonOpts): Promise<DaemonConfig> {
  const home = path.resolve(opts.home)
  const id = resolveIdentity(home)
  if (id === null) {
    throw new Error(`no AgentChat identity in ${home} — register this agent first`)
  }

  // An environment key is the authenticated identity even when this home also
  // contains an older credentials file. That file's handle is not evidence
  // about the env key, so resolve it from the server.
  let handle = id.source === 'file' ? id.handle : null
  if (handle === null) {
    const client = new AgentChatClient({
      apiKey: id.apiKey,
      baseUrl: id.apiBase,
      clientIdentity: clientIdentityOf(opts.client),
      timeoutMs: 10_000,
    })
    const me = await client.getMe().catch(() => null)
    if (me === null || typeof me.handle !== 'string' || me.handle.length === 0) {
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
    wsBase: wsBaseFor(id.apiBase),
    home,
    workdir: path.resolve(opts.workdir),
  }
}
