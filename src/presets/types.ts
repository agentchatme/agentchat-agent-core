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

/** The environment a listener's preset runs inherit: the caller's, minus any `AGENTCHAT_API_KEY` in it. */
export function withoutInheritedKey(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env }
  delete copy['AGENTCHAT_API_KEY']
  return copy
}
