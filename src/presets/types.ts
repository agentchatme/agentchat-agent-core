import type { TextsRuntime } from 'agentchatme'
import type { RunProfile } from '../integration/profile.js'
import type { RunRunner } from '../integration/runner.js'

// ─── Presets: how to start one headless run of a known coding agent ─────────
//
// The engine (everything in this package outside `presets/`) names no coding
// agent and never imports from here; `tests/core-is-host-agnostic`
// asserts both. A preset is the one place that does: the flags a runtime's
// headless mode takes per run profile, how to tell it is installed and signed
// in, and how a run of it reaches the hosted AgentChat tools AS a given agent.
//
// Two front doors select one, and only ever for the run command: the
// `agentchat listen --preset <name>` listener (@agentchatme/cli; its identity
// is the listener's own home, injected into each run), and the runtime's own
// integration package (its identity home and placement stay the integration's). A preset
// never decides which identity home is acted on — the caller passes it.

/** What a preset needs to build a runner acting as one agent. */
export interface PresetContext {
  /** The identity home of the agent the runs act as. Runs' file tools are kept off it where the runtime allows. */
  readonly home: string
  /** The run's working directory. */
  readonly workdir: string
  readonly profile: RunProfile
  /** The agent's key and API base, for the hosted tool server the runs reach. Never put on argv. */
  readonly apiKey: string
  readonly apiBase: string
  /** The environment runs inherit (defaults to `process.env`). */
  readonly env?: NodeJS.ProcessEnv
  /** Test seam: the runtime's binary. */
  readonly command?: string
  /**
   * The version the runs name in `X-AgentChat-Client-Version`: the front door
   * that placed them (the `agentchat` listener passes its own). Defaults to
   * this engine's version. The client name is the runtime's (`claude-code`,
   * `codex`): a run the listener wakes needs no wake-webhook tools, and the
   * hosted tools spell their names per runtime by it.
   */
  readonly clientVersion?: string
}

export interface PresetInspection {
  readonly ok: boolean
  readonly detail: string
}

export interface Preset {
  /** The name a user types (`--preset <name>`). */
  readonly name: string
  /** Human name for output. */
  readonly label: string
  /** How the served texts spell the hosted tools for this runtime (`GET /v1/texts?runtime=`). */
  readonly runtime: TextsRuntime
  /** Is the runtime installed, new enough and signed in? For `doctor` and `status`. */
  inspect(env?: NodeJS.ProcessEnv, command?: string): PresetInspection
  /**
   * A runner whose runs act as the agent in `ctx`: the hosted tool server is
   * given to each run with that agent's key (a file or an environment
   * variable, never an argument), whatever the runtime's own configuration
   * registers. May write owner-only files into `ctx.home`.
   */
  runner(ctx: PresetContext): RunRunner
  /**
   * The hosted-tool configuration a listener's run of this preset sees, as
   * lines for `doctor` (keys never printed): what the run is given, and what
   * of the user's own configuration still applies.
   */
  describeMcp(ctx: { readonly home: string; readonly apiBase: string; readonly env?: NodeJS.ProcessEnv }): string[]
  /** Variables a service must capture for this runtime (where it keeps its config, when relocated). */
  readonly serviceEnv: readonly string[]
  /** Whether the run can read files under the identity home (decides how the manual is pointed to). */
  readonly readsIdentityHome: boolean
}

// ─── A run's environment carries nothing of the session that started it ─────
//
// A listener or daemon started from inside a Claude Code or Codex session
// inherits that session's variables, and every run it starts would too: a
// session id, a messaging socket and its token (CLAUDE_CODE_MESSAGING_TOKEN
// lets a process post into the parent session), a sandbox marker
// (CODEX_SANDBOX makes a child believe it is already sandboxed). They are the
// parent's, never the run's, in every profile.

/**
 * Documented `CLAUDE_CODE_*` variables that configure how Claude Code signs in
 * and reaches its provider, or switch off traffic and secrets — the user's own
 * settings, kept (code.claude.com/docs/en/env-vars). Every other `CLAUDE_CODE_*`
 * variable is dropped: the ones Claude Code sets for the processes it spawns
 * share the prefix (CLAUDE_CODE_SESSION_ID, _CHILD_SESSION, _MESSAGING_SOCKET,
 * _MESSAGING_TOKEN, _BRIDGE_SESSION_ID, _REMOTE_SESSION_ID, …), and a variable
 * not listed here is one a headless run can do without.
 */
export const CLAUDE_CODE_ENV_KEPT: readonly string[] = [
  // Sign-in and provider
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'CLAUDE_CODE_SKIP_MANTLE_AUTH',
  'CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH',
  'CLAUDE_CODE_AWS_CHAIN_RESOLVE_TIMEOUT_MS',
  // Network and TLS
  'CLAUDE_CODE_CLIENT_CERT',
  'CLAUDE_CODE_CLIENT_KEY',
  'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
  'CLAUDE_CODE_CERT_STORE',
  'CLAUDE_CODE_PROXY_RESOLVES_HOSTS',
  'CLAUDE_CODE_CONNECT_TIMEOUT_MS',
  // Privacy and secrets switches the user turned on
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB',
  'CLAUDE_CODE_MCP_ALLOWLIST_ENV',
  // Platform
  'CLAUDE_CODE_GIT_BASH_PATH',
  'CLAUDE_CODE_TMPDIR',
  // Set by the preset itself (a larger value of the user's is kept)
  'CLAUDE_CODE_MCP_STARTUP_WAIT_MS',
]

/** Claude Code session variables outside the `CLAUDE_CODE_` prefix (code.claude.com/docs/en/env-vars), and `AI_AGENT`. */
export const CLAUDE_SESSION_ENV: readonly string[] = ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'AI_AGENT']

/**
 * What a Codex session sets in the processes it spawns (openai/codex at
 * rust-v0.154.0: core/src/spawn.rs, core/src/exec_env.rs,
 * protocol/src/shell_environment.rs, network-proxy/src/proxy.rs,
 * shell-escalation/src/unix/escalate_protocol.rs). Not the whole `CODEX_`
 * prefix: CODEX_HOME, CODEX_API_KEY, CODEX_CA_CERTIFICATE are the user's.
 */
export const CODEX_SESSION_ENV: readonly string[] = [
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'CODEX_VERSION',
  'CODEX_PERMISSION_PROFILE',
  'CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN',
  'CODEX_ESCALATE_SOCKET',
  'CODEX_NETWORK_PROXY_ACTIVE',
  'CODEX_NETWORK_ALLOW_LOCAL_BINDING',
]

/** Whether `key` is a parent session's variable (`withoutParentSession` drops it). Case-insensitive, as Windows names are. */
export function isParentSessionEnv(key: string): boolean {
  const upper = key.toUpperCase()
  if (upper.startsWith('CLAUDE_CODE_')) return !CLAUDE_CODE_ENV_KEPT.includes(upper)
  return CLAUDE_SESSION_ENV.includes(upper) || CODEX_SESSION_ENV.includes(upper)
}

/** A copy of `env` without any Claude Code or Codex parent-session variable: what every preset run, in every profile, starts from. */
export function withoutParentSession(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) if (!isParentSessionEnv(key)) copy[key] = value
  return copy
}

/** The environment a listener's preset runs inherit: the caller's, minus any `AGENTCHAT_API_KEY` in it. */
export function withoutInheritedKey(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env }
  delete copy['AGENTCHAT_API_KEY']
  return copy
}
