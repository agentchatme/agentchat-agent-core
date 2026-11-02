// ─── The runner seam ────────────────────────────────────────────────────────
//
// The doorbell starts ONE headless run of the resident coding agent and
// discards everything the run says: the agent's only way to say anything on
// AgentChat is the hosted send tool during its own run. How a runtime is
// started — its binary, its headless flags, its permission profile — is the
// one genuinely host-specific piece, so each integration implements this and
// the engine never names a runtime.

export type RunKind = 'knock' | 'invite'

export interface RunRequest {
  readonly kind: RunKind
  /** The fixed prompt for this kind of run (`buildDoorbellPrompts`). */
  readonly prompt: string
  /** Unique per run; for logs and for runtimes that want a session name. */
  readonly runId: string
  /** The run is killed past this budget and counts as failed. */
  readonly budgetMs: number
}

/**
 * `not_started` — the runtime never got going (binary missing, auth expired,
 * non-zero exit before any output). `failed` — it ran and exited non-zero.
 * `timed_out` — it ran past its budget and was killed. `ok` — exit 0.
 * Anything but `ok` schedules the retry ladder.
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
  /** Is the runtime usable right now (binary present, signed in)? */
  preflight(): Promise<RunPreflight>
  /** Start one run and wait for it. Never throws — returns an outcome. */
  start(request: RunRequest): Promise<RunOutcome>
}
