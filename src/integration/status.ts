import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { atomicWriteFile, readJsonFile } from '../util/fsutil.js'
import { log } from '../util/log.js'
import { describeRunProfile, workdirExposesHome } from './profile.js'
import { couldNotProcessPath } from './could-not-process.js'

// ─── Integration status, for `status` and `doctor` ──────────────────────────
//
// The resident daemon writes one small JSON file into the identity home on
// every change (and periodically), so a CLI command can answer "is the
// integration up, did a wake arrive, did a run start?" without a socket to
// the daemon. Counters, and the ids of the conversations a status line has to
// name (the last run's, the ones paused for this agent) — no handles of
// peers, no content.
//
// The file was `doorbell.status.json` with `knocks` counters before the
// rename. Readers accept both spellings — an older daemon may still be
// running under a newer CLI until the service restarts — and writers use the
// new ones.

export const INTEGRATION_STATUS_FILE = 'integration.status.json'
/** The file a daemon before the rename writes; read when the current one is absent. */
export const LEGACY_STATUS_FILE = 'doorbell.status.json'

/**
 * The socket word. `blocked` is the SDK's own word for it (`RealtimeState`):
 * the server refused the credential on the hello and a fresh hello is tried
 * every 10–15 min until one is accepted — not an end state. Daemons before
 * this release wrote `terminal` for it; readers map that on the way in.
 */
export const SOCKET_STATES = ['off', 'idle', 'connecting', 'ready', 'reconnecting', 'blocked', 'closed'] as const
export type SocketState = (typeof SOCKET_STATES)[number]
/** What an older daemon wrote for `blocked`. Accepted on read, never written. */
const LEGACY_BLOCKED_STATE = 'terminal'

export type TextsSource = 'server' | 'cache' | 'none'

export interface TextsStatus {
  /** Where the texts a run starts with came from. */
  source: TextsSource
  fetched_at: string | null
  /** The served text set's version. */
  version: string | null
  manual_version: string | null
}

export interface IntegrationLastRun {
  /**
   * `invite`: a run for the pending invites; `wake` otherwise — a conversation
   * run included, so a reader from before conversation runs still reads the
   * file. `run_kind` says which.
   */
  kind: 'wake' | 'invite'
  /** What the run was for: `conversation`, `invite`, or `wake` (one run for the tray). Absent in a file an older daemon wrote. */
  run_kind?: 'wake' | 'invite' | 'conversation' | null
  /** A `conversation` run's conversation; null otherwise (absent in a file an older daemon wrote). */
  conversation_id?: string | null
  started_at: string
  ended_at: string
  state: 'ok' | 'failed' | 'timed_out' | 'not_started'
  exit_code: number | null
  duration_ms: number
  detail: string | null
}

export interface IntegrationStatus {
  version: 2
  updated_at: string
  pid: number
  runtime: string | null
  /** The runtime's name for people (`RunRunner.label`), as `status` says it; absent in a file an older daemon wrote. */
  runtime_label?: string | null
  handle: string | null
  profile: string
  /** The run workdir the daemon was given (absent in a file an older daemon wrote). */
  workdir?: string
  socket: SocketState
  wakes: number
  wakes_absorbed: number
  invites: number
  runs_started: number
  runs_ok: number
  runs_failed: number
  runs_timed_out: number
  runs_not_started: number
  /** Wakes whose tray count came back empty, so no run started. */
  runs_skipped_empty: number
  last_run: IntegrationLastRun | null
  retry_rung: number
  retry_due_at: string | null
  last_error: string | null
  texts: TextsStatus | null
  /** The socket capabilities the server accepted (`ack`, `heartbeat`, `rewake`); null before a hello, or from an older daemon. */
  capabilities?: string[] | null
  /** The receive loop's most recent wake cycles, oldest first (the kit's `status().recentCycles`, reduced); null from an older daemon. */
  recent_cycles?: IntegrationCycle[] | null
  /** The socket's backpressure: true while it refuses new messages because handlers are behind (the kit's `intakePaused`); null from an older daemon. */
  intake_paused?: boolean | null
  /**
   * Another daemon serves this agent (one agent, one listener): its identity
   * home and pid. This one holds no socket and starts no run until it stops.
   * Null or absent when this one serves it (or an older daemon wrote the file).
   */
  standby?: IntegrationStandby | null
  /**
   * Runs keep failing and the runtime's own check says why (signed out, binary
   * gone, a flag the installed version rejects): the check's words, since when,
   * how many runs did not get done, when it was last checked. Cleared when a
   * run succeeds. Null or absent when runs are fine (or an older daemon wrote the file).
   */
  runs_failing?: IntegrationRunsFailing | null
  /**
   * This home gave its agent up because it cannot serve it — the server
   * refuses its key, or its runs fail for a runtime reason while a healthy
   * listener for the agent waits — and holds no socket until a recheck passes.
   * Null or absent when it serves (or stands by for another).
   */
  unservable?: IntegrationUnservable | null
  /** Lock renewals that failed (the lock folder gone, a full disk, permissions), and the last message; null or absent when none did. */
  lease_errors?: { readonly count: number; readonly last: string | null } | null
  /**
   * Runs in a row that did not get done (failed, timed out, did not start)
   * since the last one that did; 0 after a good run. With conversation runs a
   * cycle only starts runs, so this, not the cycles, says when every run
   * fails. Null or absent from an older daemon.
   */
  failed_runs_in_a_row?: number | null
  /** When the last run that got done ended; null before one, or absent from an older daemon. */
  last_ok_run_at?: string | null
  /** Could not process: the kit's reports and the server's answers, and the conversations paused for this agent. Null or absent from an older daemon. */
  could_not_process?: IntegrationCouldNotProcess | null
}

/** A conversation paused for this agent (the server's 24 h mute, source `could_not_process`). */
export interface IntegrationPausedConversation {
  readonly conversation_id: string
  /** When the pause ends, as the server answered. */
  readonly paused_until: string
  /** When the server answered `paused`. */
  readonly at: string
}

/**
 * Could not process (the SDK kit's `status().processingFailures`, since the
 * daemon started, and the paused conversations this machine was told about).
 */
export interface IntegrationCouldNotProcess {
  /**
   * Whether the runtime has its own check (`RunRunner.checkRuntime`: a
   * minimal model call). Without one, a failed conversation run is reported
   * only after another run completes.
   */
  readonly runtime_check: boolean
  /** Reports the server answered, and its answers. */
  readonly reported: number
  readonly retry: number
  readonly hidden: number
  readonly paused: number
  readonly none: number
  /** Reports that failed (network, server); nothing more was done for them. */
  readonly report_errors: number
  /** Runs started again on a `retry` or `hidden` answer. */
  readonly reruns: number
  readonly reruns_capped: number
  /** Failures waiting for another run to complete (the evidence a report needs), now. */
  readonly awaiting_evidence: number
  readonly runtime_checks_ok: number
  readonly runtime_checks_failed: number
  readonly last_runtime_check: { readonly at: string; readonly ok: boolean; readonly detail: string | null } | null
  /** Conversations paused for this agent now, newest first. */
  readonly paused_conversations: IntegrationPausedConversation[]
}

export interface IntegrationUnservable {
  /** `key_refused`: the server refuses this home's key. `runs_failing`: the runtime's own check fails. */
  readonly reason: 'key_refused' | 'runs_failing'
  /** What was said: the refusal, or the runtime check's words. */
  readonly detail: string
  /** When this home gave the agent up. */
  readonly since: string
  /** When it checks again (the runtime first, for `runs_failing`). */
  readonly retry_at: string
}

export interface IntegrationStandby {
  /** The identity home of the daemon that serves the agent, as its lock says. */
  readonly home: string | null
  readonly pid: number | null
  readonly since: string | null
}

export interface IntegrationRunsFailing {
  /** The runtime's own check (preflight), in its words. */
  readonly reason: string
  /** When the first of the failing runs ended. */
  readonly since: string
  /** Runs that did not get done since then (each one a wake cycle that started a run). */
  readonly runs_missed: number
  /** When the runtime was last checked. */
  readonly checked_at: string
}

/** One wake cycle as the status file keeps it: what it found and how it ended. Counts and outcomes only. */
export interface IntegrationCycle {
  at: string
  /** The kit's cycle outcome: `empty`, `nothing_owed`, `run_completed`, `run_failed`, `abandoned`, … */
  outcome: string
  cards: number
  invites: number
  /** Why it did not finish, bounded; null when it did. */
  failure: string | null
}

/** Cycle outcomes that mean a wake was owed something and it did not get done. */
export const FAILED_CYCLE_OUTCOMES: ReadonlySet<string> = new Set([
  'tray_failed',
  'texts_missing',
  'tools_unavailable',
  'fail_closed',
  'run_failed',
  'run_not_started',
  'abandoned',
])

/** How many of the newest cycles in a row did not get done, with the newest failure; null when the newest cycle did. */
export function failedCyclesInARow(status: Pick<IntegrationStatus, 'recent_cycles'> | null): { count: number; latest: IntegrationCycle } | null {
  const cycles = status?.recent_cycles ?? []
  let count = 0
  for (let i = cycles.length - 1; i >= 0; i--) {
    const cycle = cycles[i]
    if (cycle === undefined || !FAILED_CYCLE_OUTCOMES.has(cycle.outcome)) break
    count += 1
  }
  const latest = cycles[cycles.length - 1]
  return count === 0 || latest === undefined ? null : { count, latest }
}

/** This many failed cycles in a row is a warning in `status` and `doctor`: one is a hiccup, three is a pattern. */
export const REPEATED_FAILED_CYCLES = 3

// What is accepted on read: the current shape (version 2, `wakes`) and the
// one before it (version 1, `knocks`, `last_run.kind: 'knock'`, `ack_negotiated`).
// `kind` and `run_kind` are any string, so a run kind a newer daemon adds does
// not make the whole file unreadable here (`kind` reads as `wake`, an unknown
// `run_kind` as none).
const LastRunSchema = z.object({
  kind: z.string(),
  run_kind: z.string().nullable().optional(),
  conversation_id: z.string().nullable().optional(),
  started_at: z.string(),
  ended_at: z.string(),
  state: z.enum(['ok', 'failed', 'timed_out', 'not_started']),
  exit_code: z.number().nullable(),
  duration_ms: z.number(),
  detail: z.string().nullable(),
})

const TextsStatusSchema = z.object({
  source: z.enum(['server', 'cache', 'none']),
  fetched_at: z.string().nullable(),
  version: z.string().nullable(),
  manual_version: z.string().nullable(),
})

const CouldNotProcessSchema = z.object({
  runtime_check: z.boolean(),
  reported: z.number(),
  retry: z.number(),
  hidden: z.number(),
  paused: z.number(),
  none: z.number(),
  report_errors: z.number(),
  reruns: z.number(),
  reruns_capped: z.number(),
  awaiting_evidence: z.number(),
  runtime_checks_ok: z.number(),
  runtime_checks_failed: z.number(),
  last_runtime_check: z.object({ at: z.string(), ok: z.boolean(), detail: z.string().nullable() }).nullable(),
  paused_conversations: z.array(z.object({ conversation_id: z.string(), paused_until: z.string(), at: z.string() })),
})

const RUN_KINDS: ReadonlySet<string> = new Set(['wake', 'invite', 'conversation'])

const StatusSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    updated_at: z.string(),
    pid: z.number(),
    runtime: z.string().nullable(),
    runtime_label: z.string().nullable().optional(),
    handle: z.string().nullable(),
    profile: z.string(),
    workdir: z.string().optional(),
    socket: z.enum([...SOCKET_STATES, LEGACY_BLOCKED_STATE]),
    wakes: z.number().optional(),
    wakes_absorbed: z.number().optional(),
    knocks: z.number().optional(),
    knocks_absorbed: z.number().optional(),
    invites: z.number(),
    runs_started: z.number(),
    runs_ok: z.number(),
    runs_failed: z.number(),
    runs_timed_out: z.number(),
    runs_not_started: z.number(),
    runs_skipped_empty: z.number().default(0),
    last_run: LastRunSchema.nullable(),
    retry_rung: z.number(),
    retry_due_at: z.string().nullable(),
    last_error: z.string().nullable(),
    texts: TextsStatusSchema.nullable().default(null),
    capabilities: z.array(z.string()).nullable().optional(),
    standby: z.object({ home: z.string().nullable(), pid: z.number().nullable(), since: z.string().nullable() }).nullable().optional(),
    runs_failing: z.object({ reason: z.string(), since: z.string(), runs_missed: z.number(), checked_at: z.string() }).nullable().optional(),
    unservable: z.object({ reason: z.enum(['key_refused', 'runs_failing']), detail: z.string(), since: z.string(), retry_at: z.string() }).nullable().optional(),
    lease_errors: z.object({ count: z.number(), last: z.string().nullable() }).nullable().optional(),
    recent_cycles: z
      .array(z.object({ at: z.string(), outcome: z.string(), cards: z.number(), invites: z.number(), failure: z.string().nullable() }))
      .nullable()
      .optional(),
    intake_paused: z.boolean().nullable().optional(),
    failed_runs_in_a_row: z.number().nullable().optional(),
    last_ok_run_at: z.string().nullable().optional(),
    could_not_process: CouldNotProcessSchema.nullable().optional(),
  })
  .passthrough()

function normalize(raw: z.infer<typeof StatusSchema>): IntegrationStatus {
  const lastRun: IntegrationLastRun | null =
    raw.last_run === null
      ? null
      : {
          ...raw.last_run,
          kind: raw.last_run.kind === 'invite' ? 'invite' : 'wake',
          run_kind:
            typeof raw.last_run.run_kind === 'string' && RUN_KINDS.has(raw.last_run.run_kind)
              ? (raw.last_run.run_kind as NonNullable<IntegrationLastRun['run_kind']>)
              : raw.last_run.kind === 'invite' || raw.last_run.kind === 'conversation'
                ? raw.last_run.kind
                : raw.last_run.kind === 'knock' || raw.last_run.kind === 'wake'
                  ? 'wake'
                  : null,
          conversation_id: raw.last_run.conversation_id ?? null,
        }
  return {
    version: 2,
    updated_at: raw.updated_at,
    pid: raw.pid,
    runtime: raw.runtime,
    ...(raw.runtime_label !== undefined ? { runtime_label: raw.runtime_label } : {}),
    handle: raw.handle,
    profile: raw.profile,
    ...(raw.workdir !== undefined ? { workdir: raw.workdir } : {}),
    socket: raw.socket === LEGACY_BLOCKED_STATE ? 'blocked' : raw.socket,
    wakes: raw.wakes ?? raw.knocks ?? 0,
    wakes_absorbed: raw.wakes_absorbed ?? raw.knocks_absorbed ?? 0,
    invites: raw.invites,
    runs_started: raw.runs_started,
    runs_ok: raw.runs_ok,
    runs_failed: raw.runs_failed,
    runs_timed_out: raw.runs_timed_out,
    runs_not_started: raw.runs_not_started,
    runs_skipped_empty: raw.runs_skipped_empty,
    last_run: lastRun,
    retry_rung: raw.retry_rung,
    retry_due_at: raw.retry_due_at,
    last_error: raw.last_error,
    texts: raw.texts,
    capabilities: raw.capabilities ?? null,
    recent_cycles: raw.recent_cycles ?? null,
    intake_paused: raw.intake_paused ?? null,
    standby: raw.standby ?? null,
    runs_failing: raw.runs_failing ?? null,
    unservable: raw.unservable ?? null,
    lease_errors: raw.lease_errors ?? null,
    failed_runs_in_a_row: raw.failed_runs_in_a_row ?? null,
    last_ok_run_at: raw.last_ok_run_at ?? null,
    could_not_process: raw.could_not_process ?? null,
  }
}

export function integrationStatusPath(home: string): string {
  return path.join(home, INTEGRATION_STATUS_FILE)
}

export function legacyStatusPath(home: string): string {
  return path.join(home, LEGACY_STATUS_FILE)
}

/** Best effort: the status file is diagnostics, never a dependency of waking. */
export function writeIntegrationStatus(home: string, status: IntegrationStatus): void {
  try {
    atomicWriteFile(integrationStatusPath(home), `${JSON.stringify(status, null, 2)}\n`, 0o600)
  } catch (err) {
    log.debug(`integration status write failed: ${String(err)}`)
  }
}

/** The current file, or — when a daemon from before the rename is the one running — the file it writes. */
export function readIntegrationStatus(home: string): IntegrationStatus | null {
  for (const file of [integrationStatusPath(home), legacyStatusPath(home)]) {
    const raw = readJsonFile<unknown>(file)
    if (raw === null) continue
    const parsed = StatusSchema.safeParse(raw)
    if (parsed.success) return normalize(parsed.data)
  }
  return null
}

/**
 * Remove what the daemon keeps for `status` in the identity home: both
 * spellings of the status file (a stale legacy file must not outlive the
 * daemon that wrote it) and the could-not-process ledger
 * (`could-not-process.json`). For uninstall: nothing of it is left behind.
 */
export function clearIntegrationStatus(home: string): void {
  for (const file of [integrationStatusPath(home), legacyStatusPath(home), couldNotProcessPath(home)]) {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* absent is fine */
    }
  }
}

/** Age of the status file, in ms, or null when absent. */
export function integrationStatusAge(status: IntegrationStatus | null, now = Date.now()): number | null {
  if (status === null) return null
  const t = Date.parse(status.updated_at)
  return Number.isNaN(t) ? null : Math.max(0, now - t)
}

function ago(ms: number): string {
  if (ms < 45_000) return 'just now'
  if (ms < 90_000) return '1 minute ago'
  if (ms < 45 * 60_000) return `${Math.round(ms / 60_000)} minutes ago`
  if (ms < 36 * 3_600_000) return `${Math.round(ms / 3_600_000)} hour(s) ago`
  return `${Math.round(ms / 86_400_000)} day(s) ago`
}

/** `ms` from now, in words: when a pause ends. */
function fromNow(ms: number): string {
  if (ms < 90_000) return 'in about a minute'
  if (ms < 45 * 60_000) return `in ${Math.round(ms / 60_000)} minutes`
  if (ms < 36 * 3_600_000) return `in ${Math.round(ms / 3_600_000)} hour(s)`
  return `in ${Math.round(ms / 86_400_000)} day(s)`
}

/** How many paused conversations a line names; the rest are counted. */
const PAUSED_NAMED = 5

/**
 * The conversations paused for this agent, in one plain line (no indent), or
 * null when none is paused now: which ones, until when, and why.
 */
export function describePausedConversations(paused: readonly IntegrationPausedConversation[], now = Date.now()): string | null {
  const current = paused.filter((p) => Date.parse(p.paused_until) > now)
  if (current.length === 0) return null
  const when = (p: IntegrationPausedConversation): string => `${p.paused_until} (${fromNow(Date.parse(p.paused_until) - now)})`
  const why =
    "this agent's AI kept failing on messages there, so they are hidden from this agent (it sees a note in their place) and no run starts there until the pause ends; it ends on its own"
  if (current.length === 1) {
    const only = current[0]!
    return `could not process: 1 conversation paused until ${when(only)} — ${only.conversation_id}: ${why}`
  }
  const named = current.slice(0, PAUSED_NAMED).map((p) => `${p.conversation_id} until ${when(p)}`)
  const more = current.length > PAUSED_NAMED ? `, and ${current.length - PAUSED_NAMED} more` : ''
  return `could not process: ${current.length} conversations paused — ${named.join(', ')}${more}: ${why}`
}

/**
 * The could-not-process counts in one plain line (no indent), or null when
 * nothing has happened: what was reported and answered, what waits, and the
 * runtime check.
 */
export function describeCouldNotProcessCounts(c: IntegrationCouldNotProcess, now = Date.now()): string | null {
  const checks = c.runtime_checks_ok + c.runtime_checks_failed
  if (c.reported + c.report_errors + c.awaiting_evidence + checks === 0) return null
  const parts = [`${c.reported} report(s) answered (${c.retry} retry, ${c.hidden} hidden, ${c.paused} paused, ${c.none} nothing to do)`]
  if (c.report_errors > 0) parts.push(`${c.report_errors} report(s) failed`)
  if (c.reruns > 0) parts.push(`${c.reruns} run(s) started again`)
  if (c.reruns_capped > 0) parts.push(`${c.reruns_capped} not started again (already re-run 3 times in that cycle)`)
  if (c.awaiting_evidence > 0) parts.push(`${c.awaiting_evidence} failed run(s) waiting for another run to complete before they are reported`)
  const last = c.last_runtime_check
  if (checks > 0) {
    parts.push(
      `runtime check ${c.runtime_checks_ok} ok, ${c.runtime_checks_failed} failed${
        last !== null ? ` (last: ${last.ok ? 'ok' : 'failed'}${last.detail ? ` — ${last.detail}` : ''}, ${ago(Math.max(0, now - Date.parse(last.at)))})` : ''
      }`,
    )
  }
  if (!c.runtime_check) parts.push("no runtime check for this runtime: a failed run is reported only after another conversation's run completes")
  return `could not process: ${parts.join('; ')} — since the daemon started`
}

/**
 * Whether the last runtime check failed and nothing has got done since: a run
 * that completed after the check says the runtime works again, and the failed
 * check is history (the counts say it).
 */
export function runtimeCheckFailingNow(status: Pick<IntegrationStatus, 'could_not_process' | 'last_ok_run_at'> | null): boolean {
  const last = status?.could_not_process?.last_runtime_check ?? null
  if (last === null || last.ok) return false
  const okAt = Date.parse(status?.last_ok_run_at ?? '')
  return !(Number.isFinite(okAt) && okAt > Date.parse(last.at))
}

/** Runs in a row that did not get done, when that is a pattern (`REPEATED_FAILED_CYCLES` or more) and no runtime reason explains it; null otherwise. */
export function repeatedFailedRuns(status: Pick<IntegrationStatus, 'failed_runs_in_a_row' | 'runs_failing' | 'unservable'> | null): number | null {
  const count = status?.failed_runs_in_a_row ?? 0
  if (count < REPEATED_FAILED_CYCLES || (status?.runs_failing ?? null) !== null || (status?.unservable ?? null) !== null) return null
  return count
}

function textsLine(texts: TextsStatus | null, now: number): string {
  if (texts === null || texts.source === 'none') {
    return '  texts: not fetched yet (GET /v1/texts unreachable and nothing cached — a run waits for them)'
  }
  const fetched = texts.fetched_at === null ? '' : `, fetched ${ago(Math.max(0, now - Date.parse(texts.fetched_at)))}`
  const versions = `${texts.version !== null ? `v${texts.version}` : 'unversioned'}${texts.manual_version !== null ? `, manual ${texts.manual_version}` : ''}`
  return texts.source === 'server'
    ? `  texts: served (${versions}${fetched}; refreshed daily)`
    : `  texts: from the identity-home cache (${versions}${fetched}; the server has not answered since the daemon started)`
}

/** Human lines for `status`. Pure. */
export function formatIntegrationStatus(status: IntegrationStatus | null, now = Date.now()): string[] {
  if (status === null) return ['Integration: no status recorded yet (the daemon has not run, or is still starting)']
  const age = integrationStatusAge(status, now)
  const stale = age !== null && age > 3 * 60_000
  const standby = status.standby ?? null
  const failing = status.runs_failing ?? null
  const unservable = status.unservable ?? null
  const lines = [
    `Integration: socket ${status.socket}${stale ? ` (status last written ${ago(age)} — the daemon may be down)` : ''}${
      unservable !== null
        ? ' — this home gave the agent up (below)'
        : standby !== null
          ? ' — standing by: another listener serves this agent'
          : failing !== null
            ? ' — but runs are failing (below)'
            : ''
    }`,
    ...(unservable !== null
      ? [
          `  gave up: ${unservable.reason === 'key_refused' ? 'the server refuses this home\'s key' : 'runs fail for a runtime reason, and another listener for the agent was waiting'} — ${unservable.detail} (since ${unservable.since}). No socket, no run here while another listener can serve it; looks again at ${unservable.retry_at}${
            unservable.reason === 'runs_failing' ? ' (the runtime checked first: a check that passes clears this)' : ' (signing in again here clears this at once)'
          }, and takes the agent back whenever no other listener holds it.`,
        ]
      : []),
    ...(standby !== null
      ? [`  standby: ${standby.home ?? 'another identity home'}${standby.pid !== null ? ` (pid ${standby.pid})` : ''} serves this agent${standby.since !== null ? ` since ${standby.since}` : ''}; this one holds no socket and starts no run while it does (no message is answered twice), and takes over when it stops`]
      : []),
    ...(failing !== null
      ? [
          `  runs failing: ${failing.reason} — since ${failing.since} (${ago(Math.max(0, now - Date.parse(failing.since)))}), ${failing.runs_missed} run(s) missed; checked ${ago(Math.max(0, now - Date.parse(failing.checked_at)))}. ${
            unservable !== null ? 'The runtime recheck clears this.' : 'Wakes still arrive, are counted and start runs; the next run that succeeds clears this.'
          }`,
        ]
      : []),
    ...(status.lease_errors !== undefined && status.lease_errors !== null && status.lease_errors.count > 0
      ? [`  lock: ${status.lease_errors.count} renewal(s) failed${status.lease_errors.last ? ` (last: ${status.lease_errors.last})` : ''}; a lock that cannot be renewed for 45 s is given up`]
      : []),
    '  delivery: acknowledged on receipt by the SDK socket (delivered = this machine received it; read is the agent’s own verdict inside its run)',
    `  wakes: ${status.wakes} (${status.wakes_absorbed} absorbed into a pending run), invites: ${status.invites}`,
    `  runs: ${status.runs_started} started, ${status.runs_ok} ok, ${status.runs_failed} failed, ${status.runs_timed_out} timed out, ${status.runs_not_started} did not start; ${status.runs_skipped_empty} wake(s) found the tray empty (no run)`,
    textsLine(status.texts, now),
    ...(status.capabilities === null || status.capabilities === undefined
      ? []
      : [
          status.capabilities.includes('rewake')
            ? '  re-wake: the server wakes this agent again for cards it has not answered (+1 m, +5 m, +30 m, +3 h)'
            : '  re-wake: not offered by this server — an unanswered card waits for the next message',
        ]),
    // What the active profile does, in one line with its warning (`describeRunProfile`).
    `  profile: ${status.profile}${status.runtime ? ` (${status.runtime})` : ''} — ${describeRunProfile(status.profile, status.runtime_label ?? null)}`,
    ...(status.workdir !== undefined && workdirExposesHome(status.workdir)
      ? [
          `  workdir: ${status.workdir} is your home folder or contains it — a run started by a peer's message there can see everything under it${
            status.profile === 'answer' || status.profile === 'own' ? " (the presets' own and answer runs use their own empty folder instead)" : ''
          }; point the workdir at a folder of its own`,
        ]
      : []),
  ]
  if (status.last_run) {
    const r = status.last_run
    lines.push(
      `  last run: ${r.run_kind ?? r.kind}${r.conversation_id ? ` ${r.conversation_id}` : ''}, ${r.state}${r.exit_code !== null ? ` (exit ${r.exit_code})` : ''}, ${Math.round(r.duration_ms / 1000)} s, ended ${ago(Math.max(0, now - Date.parse(r.ended_at)))}${r.detail ? ` — ${r.detail}` : ''}`,
    )
  } else {
    lines.push('  last run: none yet')
  }
  const failedRuns = repeatedFailedRuns(status)
  if (failedRuns !== null) {
    lines.push(`  WARNING: the last ${failedRuns} runs did not get done${status.last_run ? ` (latest: ${status.last_run.state}${status.last_run.detail ? ` — ${status.last_run.detail}` : ''})` : ''}; the cards stay on the tray`)
  }
  const cnp = status.could_not_process ?? null
  if (cnp !== null) {
    const paused = describePausedConversations(cnp.paused_conversations, now)
    if (paused !== null) lines.push(`  ${paused}`)
    const counts = describeCouldNotProcessCounts(cnp, now)
    if (counts !== null) lines.push(`  ${counts}`)
  }
  if (status.intake_paused === true) {
    lines.push('  WARNING: the socket is refusing new messages (backpressure: earlier ones are still being handled); they stay on the server and arrive when it catches up')
  }
  const cycles = status.recent_cycles ?? []
  if (cycles.length > 0) {
    const last = cycles[cycles.length - 1]!
    lines.push(`  cycles: ${cycles.length} recent; the last one ${last.outcome} (${last.cards} card(s), ${last.invites} invite(s)) ${ago(Math.max(0, now - Date.parse(last.at)))}`)
    const failing = failedCyclesInARow(status)
    if (failing !== null && failing.count >= REPEATED_FAILED_CYCLES) {
      lines.push(`  WARNING: the last ${failing.count} wake cycles did not get done (latest: ${failing.latest.outcome}${failing.latest.failure ? ` — ${failing.latest.failure}` : ''})`)
    }
  }
  if (status.retry_due_at) {
    const due = Date.parse(status.retry_due_at) - now
    lines.push(`  retry: rung ${status.retry_rung}, next wake ${due > 0 ? `in ${Math.round(due / 1000)} s` : 'due'}`)
  }
  if (status.last_error) lines.push(`  last error: ${status.last_error}`)
  return lines
}
