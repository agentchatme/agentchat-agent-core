// ─── The runner seam ────────────────────────────────────────────────────────
//
// The integration starts ONE headless run of the resident coding agent and
// discards everything the run says: the agent's only way to say anything on
// AgentChat is the hosted send tool during its own run. How a runtime is
// started — its binary, its headless flags, its permission profile — is the
// one genuinely host-specific piece, so each integration implements this and
// the engine never names a runtime.

export type RunKind = 'wake' | 'invite'

export interface RunRequest {
  readonly kind: RunKind
  /** The prompt for this kind of run: the served text, then the manual pointer (`buildRunPrompts`). */
  readonly prompt: string
  /** Unique per run; for logs and for runtimes that want a session name. */
  readonly runId: string
  /** The run is killed past this budget and counts as failed. */
  readonly budgetMs: number
  /**
   * Aborted when the integration is stopping (daemon shutdown, identity
   * change). A runner passes it to `spawnRun`, which SIGTERMs the
   * run's process group and SIGKILLs after a grace; the outcome is `failed`
   * with an "interrupted" detail. Optional so a runner that cannot interrupt
   * still satisfies the contract.
   */
  readonly signal?: AbortSignal
  /**
   * Called once, as soon as the runtime's process has been started. The
   * invoker records a group invite as offered at this moment — not when the
   * run ends — so a run cut short by a shutdown or a crash still counts as
   * the invite's one offer from this machine. A runner built on `spawnRun`
   * passes it through; a runner that cannot tell may leave it uncalled, and
   * the invoker then records the offer when the run ends instead.
   */
  readonly onStarted?: () => void
}

/**
 * `not_started` — the runtime never got going: binary missing, or a non-zero
 * exit with NOTHING ON STDOUT (an auth gate, a bad flag, a missing config —
 * all of which print their complaint on stderr and quit; stderr does not
 * count as output). `failed` — it produced output and exited non-zero, or was
 * interrupted. `timed_out` — it ran past its budget and was killed. `ok` —
 * exit 0. Anything but `ok` schedules the retry ladder.
 */
export type RunOutcomeState = 'ok' | 'failed' | 'timed_out' | 'not_started'

export interface RunOutcome {
  readonly state: RunOutcomeState
  readonly exitCode: number | null
  readonly durationMs: number
  /** Bounded, credential-redacted diagnostic. Never message content. */
  readonly detail?: string
}

export interface RunPreflight {
  ok: boolean
  detail?: string
}

export interface RunRunner {
  /** Short runtime name for logs and status, e.g. the CLI's binary name. */
  readonly name: string
  /**
   * Is the runtime usable right now (binary present, signed in)? Called
   * before the socket is held, and — after the retry ladder is exhausted —
   * periodically, so a runtime that comes back (the user signs in again)
   * earns one re-wake without waiting for the next peer.
   */
  preflight(): Promise<RunPreflight>
  /** Start one run and wait for it. Never throws — returns an outcome. */
  start(request: RunRequest): Promise<RunOutcome>
}

/** The agent a runner's runs act as: what a `RunnerFactory` is given for each identity the integration serves. */
export interface RunnerIdentity {
  /** The identity home. */
  readonly home: string
  /** Bare handle. */
  readonly handle: string
  /** The agent's key. A runner hands it to its runs only as a file or an environment variable, never on argv. */
  readonly apiKey: string
  readonly apiBase: string
  /** The run's working directory. */
  readonly workdir: string
}

/**
 * Builds the runner for one identity. For runners whose runs must be told
 * which agent they act as (a listener's preset writes the agent's hosted tool
 * config; a forwarder reads that agent's tray): the resident supervisor calls
 * `create` again whenever the credential changes.
 */
export interface RunnerFactory {
  /** Short runtime name for logs and status, before any identity is known. */
  readonly name: string
  create(identity: RunnerIdentity): RunRunner
}

/** A runner, or a factory of one per identity. */
export type RunnerSource = RunRunner | RunnerFactory

export function isRunnerFactory(source: RunnerSource): source is RunnerFactory {
  return typeof (source as Partial<RunnerFactory>).create === 'function'
}
