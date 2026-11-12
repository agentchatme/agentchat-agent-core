import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { atomicWriteFile, readJsonFile } from '../util/fsutil.js'
import { log } from '../util/log.js'
import { runProfileWarning, workdirExposesHome } from './profile.js'

// ─── Integration status, for `status` and `doctor` ──────────────────────────
//
// The resident daemon writes one small JSON file into the identity home on
// every change (and periodically), so a CLI command can answer "is the
// integration up, did a wake arrive, did a run start?" without a socket to
// the daemon. Counters only — no handles of peers, no conversation ids, no
// content.
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
  kind: 'wake' | 'invite'
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
const LastRunSchema = z.object({
  kind: z.enum(['wake', 'invite', 'knock']),
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

const StatusSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    updated_at: z.string(),
    pid: z.number(),
    runtime: z.string().nullable(),
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
    recent_cycles: z
      .array(z.object({ at: z.string(), outcome: z.string(), cards: z.number(), invites: z.number(), failure: z.string().nullable() }))
      .nullable()
      .optional(),
    intake_paused: z.boolean().nullable().optional(),
  })
  .passthrough()

function normalize(raw: z.infer<typeof StatusSchema>): IntegrationStatus {
  const lastRun: IntegrationLastRun | null =
    raw.last_run === null ? null : { ...raw.last_run, kind: raw.last_run.kind === 'knock' ? 'wake' : raw.last_run.kind }
  return {
    version: 2,
    updated_at: raw.updated_at,
    pid: raw.pid,
    runtime: raw.runtime,
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

/** Remove both spellings: a stale legacy file must not outlive the daemon that wrote it. */
export function clearIntegrationStatus(home: string): void {
  for (const file of [integrationStatusPath(home), legacyStatusPath(home)]) {
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
  const profileWarning = runProfileWarning(status.profile)
  const standby = status.standby ?? null
  const failing = status.runs_failing ?? null
  const lines = [
    `Integration: socket ${status.socket}${stale ? ` (status last written ${ago(age)} — the daemon may be down)` : ''}${
      standby !== null ? ' — standing by: another listener serves this agent' : failing !== null ? ' — but runs are failing (below)' : ''
    }`,
    ...(standby !== null
      ? [`  standby: ${standby.home ?? 'another identity home'}${standby.pid !== null ? ` (pid ${standby.pid})` : ''} serves this agent${standby.since !== null ? ` since ${standby.since}` : ''}; this one holds no socket and starts no run while it does (no message is answered twice), and takes over when it stops`]
      : []),
    ...(failing !== null
      ? [`  runs failing: ${failing.reason} — since ${failing.since} (${ago(Math.max(0, now - Date.parse(failing.since)))}), ${failing.runs_missed} run(s) missed; checked ${ago(Math.max(0, now - Date.parse(failing.checked_at)))}. Wakes still arrive and are counted; the next run that succeeds clears this.`]
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
    `  profile: ${status.profile}${status.runtime ? ` (${status.runtime})` : ''}${profileWarning !== null ? ` — ${profileWarning}` : ''}`,
    ...(status.workdir !== undefined && workdirExposesHome(status.workdir)
      ? [
          `  workdir: ${status.workdir} is your home folder or contains it — a run started by a peer's message there can see everything under it${
            status.profile === 'answer' ? " (the presets' answer runs use their own empty folder instead)" : ''
          }; point the workdir at a folder of its own`,
        ]
      : []),
  ]
  if (status.last_run) {
    const r = status.last_run
    lines.push(
      `  last run: ${r.kind}, ${r.state}${r.exit_code !== null ? ` (exit ${r.exit_code})` : ''}, ${Math.round(r.duration_ms / 1000)} s, ended ${ago(Math.max(0, now - Date.parse(r.ended_at)))}${r.detail ? ` — ${r.detail}` : ''}`,
    )
  } else {
    lines.push('  last run: none yet')
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
