import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { atomicWriteFile, readJsonFile } from '../util/fsutil.js'
import { log } from '../util/log.js'

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
}

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
  const lines = [
    `Integration: socket ${status.socket}${stale ? ` (status last written ${ago(age)} — the daemon may be down)` : ''}`,
    '  delivery: acknowledged on receipt by the SDK socket (delivered = this machine received it; read is the agent’s own verdict inside its run)',
    `  wakes: ${status.wakes} (${status.wakes_absorbed} absorbed into a pending run), invites: ${status.invites}`,
    `  runs: ${status.runs_started} started, ${status.runs_ok} ok, ${status.runs_failed} failed, ${status.runs_timed_out} timed out, ${status.runs_not_started} did not start; ${status.runs_skipped_empty} wake(s) found the tray empty (no run)`,
    textsLine(status.texts, now),
    `  profile: ${status.profile}${status.runtime ? ` (${status.runtime})` : ''}`,
  ]
  if (status.last_run) {
    const r = status.last_run
    lines.push(
      `  last run: ${r.kind}, ${r.state}${r.exit_code !== null ? ` (exit ${r.exit_code})` : ''}, ${Math.round(r.duration_ms / 1000)} s, ended ${ago(Math.max(0, now - Date.parse(r.ended_at)))}${r.detail ? ` — ${r.detail}` : ''}`,
    )
  } else {
    lines.push('  last run: none yet')
  }
  if (status.retry_due_at) {
    const due = Date.parse(status.retry_due_at) - now
    lines.push(`  retry: rung ${status.retry_rung}, next wake ${due > 0 ? `in ${Math.round(due / 1000)} s` : 'due'}`)
  }
  if (status.last_error) lines.push(`  last error: ${status.last_error}`)
  return lines
}
