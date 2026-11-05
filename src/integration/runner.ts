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
   * change, refused key). A runner passes it to `spawnRun`, which SIGTERMs the
   * run's process group and SIGKILLs after a grace; the outcome is `failed`
   * with an "interrupted" detail. Optional so a runner that cannot interrupt
   * still satisfies the contract.
   */
  readonly signal?: AbortSignal
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
