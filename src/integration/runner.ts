// ─── The runner seam ────────────────────────────────────────────────────────
//
// The integration starts headless runs of the resident coding agent and
// discards everything a run says: the agent's only way to say anything on
// AgentChat is the hosted send tool during its own run. How a runtime is
// started — its binary, its headless flags, its permission profile — is the
// one genuinely host-specific piece, so each integration implements this and
// the engine never names a runtime.
//
// What a run is for comes from the SDK kit's receive loop: with served texts
// that carry `conversation_run_template`, one run per conversation that owes
// a reply (`conversation`, with its `conversationId`) and one run for the
// pending invites (`invite`); with texts from an older server, one run for the
// whole tray (`wake`).

/**
 * `conversation`: a run for ONE conversation (the served conversation-run
 * prompt names it; `RunRequest.conversationId`). `invite`: a run for the
 * pending invites (the served invite prompt). `wake`: one run for the whole
 * tray (the served wake instruction), from texts without the conversation-run
 * template.
 */
export type RunKind = 'wake' | 'invite' | 'conversation'

/**
 * The wake that started a run, named as the webhook wake names it (contract
 * v1): `messages`, `reminder`, `invite`, `unanswered` (with `step`, the
 * re-wake rung) — or another reason a newer server sends. Facts about the
 * signal only, never content.
 */
export interface RunWake {
  readonly reason: string
  readonly step?: number
}

export interface RunRequest {
  readonly kind: RunKind
  /**
   * A `conversation` run: the one conversation it is for (an id, never
   * content). Absent on `wake` and `invite` runs. A runner may hand it to its
   * run as context (the CLI's custom command gets `AGENTCHAT_CONVERSATION_ID`,
   * `runContextEnv`); the prompt already names it.
   */
  readonly conversationId?: string
  /** The wake that started this run (the newest since the previous run started). */
  readonly wake?: RunWake
  /** The prompt for this kind of run: the served text (the kit's receive loop picks it), then the manual pointer. */
  readonly prompt: string
  /** Unique per run; for logs and for runtimes that want a session name. */
  readonly runId: string
  /**
   * The served identity line for the agent this run acts as (`GET /v1/texts`
   * `identity_line`: who it is on AgentChat). Normally the runtime loads it
   * from the instruction file the integration placed it in; a runner whose
   * run loads no instruction file (an `answer` run, kept from the user's own
   * files) gives it to the run itself. Absent when no texts are in hand.
   */
  readonly identityLine?: string
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
   * engine no longer needs it (pending invites are on the tray, so nothing
   * is recorded locally); kept so a caller can observe the start. A runner
   * built on `spawnRun` passes it through.
   */
  readonly onStarted?: () => void
}

/**
 * `not_started` — the runtime never got going: binary missing, or a non-zero
 * exit with NOTHING ON STDOUT within `NOT_STARTED_WITHIN_MS` of the spawn (an
 * auth gate, a bad flag, a missing config — all of which print their
 * complaint on stderr and quit; stderr does not count as output). `failed` —
 * it produced output and exited non-zero, exited non-zero with nothing on
 * stdout after running longer than that (`silent`), or was interrupted.
 * `timed_out` — it ran past its budget and was killed. `ok` — exit 0.
 * Anything but `ok` leaves the cards on the tray: there is no local retry —
 * the server re-wakes an agent for cards it has not answered (contract v1, D3).
 */
export type RunOutcomeState = 'ok' | 'failed' | 'timed_out' | 'not_started'

export interface RunOutcome {
  readonly state: RunOutcomeState
  readonly exitCode: number | null
  readonly durationMs: number
  /** Bounded, credential-redacted diagnostic. Never message content. */
  readonly detail?: string
  /**
   * A `failed` run that ran past `NOT_STARTED_WITHIN_MS` and then exited
   * non-zero with NOTHING on stdout: a crash, a kill, or something the run
   * loads that the runtime check does not (a user's hook, MCP server or
   * instruction file) ending it. As ambiguous as a timeout, so the engine
   * hands it to the kit as one (`RunEnd.timedOut`): it is reported as a
   * conversation's only once another conversation's run completed, never on
   * the runtime check alone. A provider's refusal prints its error on stdout
   * (`API Error: …`), so it is a plain `failed`, not this.
   */
  readonly silent?: boolean
}

export interface RunPreflightOptions {
  /**
   * Aborted when the integration stops while a check is in flight: a runner's
   * probes should stop (and kill what they started) rather than outlive it.
   */
  readonly signal?: AbortSignal
}

export interface RunPreflight {
  ok: boolean
  detail?: string
}

export interface RunRunner {
  /** Short runtime name for logs and status, e.g. the CLI's binary name. */
  readonly name: string
  /**
   * The runtime's name for people, as `status` says it (`ownProfileLine`:
   * "your own <label> permission settings"). Optional: a runner without one
   * is described without a name.
   */
  readonly label?: string
  /**
   * Is the runtime usable right now (binary present, signed in)? Called
   * before the socket is held: an integration whose runtime is not usable
   * holds no socket, and the supervisor asks again with a backoff.
   */
  preflight(options?: RunPreflightOptions): Promise<RunPreflight>
  /** Start one run and wait for it. Never throws — returns an outcome. */
  start(request: RunRequest): Promise<RunOutcome>
  /**
   * Does the agent's AI answer right now? A minimal model call through the
   * same binary, account and environment the runs use, with no peer content
   * and no AgentChat tools — not a version or sign-in check, which passes
   * during a provider outage. Asked by the kit after a conversation's run
   * failed when no other run has completed since: `ok` is the evidence a
   * could-not-process report needs (the runtime works, so the failure is that
   * conversation's). A timed-out run is reported only once another run
   * completed, never on this check alone: the check does not use the hosted
   * tools, hooks or memory a run uses. Bounded by the engine
   * (`RUNTIME_CHECK_DEADLINE_MS`), and
   * killed with everything it started when `signal` aborts. Never throws; its
   * output is discarded, never logged.
   *
   * Optional. Without it (a custom command), a failed conversation run is
   * reported only once another run completes after it (`other_run_completed`
   * evidence) within the kit's window, and never when every run fails.
   */
  checkRuntime?(options?: RunPreflightOptions): Promise<RunPreflight>
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
  /** See `RunRunner.label`; for status before any identity is known. */
  readonly label?: string
  create(identity: RunnerIdentity): RunRunner
}

/** A runner, or a factory of one per identity. */
export type RunnerSource = RunRunner | RunnerFactory

export function isRunnerFactory(source: RunnerSource): source is RunnerFactory {
  return typeof (source as Partial<RunnerFactory>).create === 'function'
}
