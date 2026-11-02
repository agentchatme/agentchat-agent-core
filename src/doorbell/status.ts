import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { atomicWriteFile, readJsonFile } from '../util/fsutil.js'
import { log } from '../util/log.js'

// ─── Doorbell status, for `status` and `doctor` ─────────────────────────────
//
// The resident daemon writes one small JSON file into the identity home on
// every change (and periodically), so a CLI command can answer "is the
// doorbell up, did it ring, did a run start?" without a socket to the daemon.
// Counters only — no handles of peers, no conversation ids, no content.

export const DOORBELL_STATUS_FILE = 'doorbell.status.json'

export const SOCKET_STATES = ['off', 'idle', 'connecting', 'ready', 'reconnecting', 'terminal', 'closed'] as const
export type SocketState = (typeof SOCKET_STATES)[number]

const LastRunSchema = z.object({
  kind: z.enum(['knock', 'invite']),
  started_at: z.string(),
  ended_at: z.string(),
  state: z.enum(['ok', 'failed', 'timed_out', 'not_started']),
  exit_code: z.number().nullable(),
  duration_ms: z.number(),
  detail: z.string().nullable(),
})

const StatusSchema = z.object({
  version: z.literal(1),
  updated_at: z.string(),
  pid: z.number(),
  runtime: z.string().nullable(),
  handle: z.string().nullable(),
  profile: z.string(),
  socket: z.enum(SOCKET_STATES),
  /** null until the server answered the capability negotiation. */
  ack_negotiated: z.boolean().nullable(),
  knocks: z.number(),
  knocks_absorbed: z.number(),
  invites: z.number(),
  runs_started: z.number(),
  runs_ok: z.number(),
  runs_failed: z.number(),
  runs_timed_out: z.number(),
  runs_not_started: z.number(),
  last_run: LastRunSchema.nullable(),
  retry_rung: z.number(),
  retry_due_at: z.string().nullable(),
  last_error: z.string().nullable(),
})

export type DoorbellLastRun = z.infer<typeof LastRunSchema>
export type DoorbellStatus = z.infer<typeof StatusSchema>

export function doorbellStatusPath(home: string): string {
  return path.join(home, DOORBELL_STATUS_FILE)
}

/** Best effort: the status file is diagnostics, never a dependency of ringing. */
export function writeDoorbellStatus(home: string, status: DoorbellStatus): void {
  try {
    atomicWriteFile(doorbellStatusPath(home), `${JSON.stringify(status, null, 2)}\n`, 0o600)
  } catch (err) {
    log.debug(`doorbell status write failed: ${String(err)}`)
  }
}

export function readDoorbellStatus(home: string): DoorbellStatus | null {
  const parsed = StatusSchema.safeParse(readJsonFile<unknown>(doorbellStatusPath(home)))
  return parsed.success ? parsed.data : null
}

export function clearDoorbellStatus(home: string): void {
  try {
    fs.rmSync(doorbellStatusPath(home), { force: true })
  } catch {
    /* absent is fine */
  }
}

/** Age of the status file, in ms, or null when absent. */
export function doorbellStatusAge(status: DoorbellStatus | null, now = Date.now()): number | null {
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

/** Human lines for `status`. Pure. */
export function formatDoorbellStatus(status: DoorbellStatus | null, now = Date.now()): string[] {
  if (status === null) return ['Doorbell: no status recorded yet (the daemon has not run, or is still starting)']
  const age = doorbellStatusAge(status, now)
  const stale = age !== null && age > 3 * 60_000
  const lines = [
    `Doorbell: socket ${status.socket}${stale ? ` (status last written ${ago(age)} — the daemon may be down)` : ''}`,
    `  ack capability: ${status.ack_negotiated === null ? 'not negotiated yet' : status.ack_negotiated ? 'negotiated (the server keeps envelopes stored until the agent decides; this daemon never acknowledges)' : 'NOT echoed by the server (legacy server marks on send)'}`,
    `  knocks: ${status.knocks} (${status.knocks_absorbed} absorbed into a pending run), invites: ${status.invites}`,
    `  runs: ${status.runs_started} started, ${status.runs_ok} ok, ${status.runs_failed} failed, ${status.runs_timed_out} timed out, ${status.runs_not_started} did not start`,
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
    lines.push(`  retry: rung ${status.retry_rung}, next knock ${due > 0 ? `in ${Math.round(due / 1000)} s` : 'due'}`)
  }
  if (status.last_error) lines.push(`  last error: ${status.last_error}`)
  return lines
}
