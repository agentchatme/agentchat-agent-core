import * as fs from 'node:fs'
import * as path from 'node:path'
import { AgentChatClient, integration as kit, type ListenerState } from 'agentchatme'
import { clientIdentityOf, type IntegrationClient } from '../client-identity.js'
import { agentLockPath } from '../daemon/agent-lock.js'
import type { ListenerReasonKind } from '../identity/setup.js'
import { leaseHolder } from '../util/lease.js'
import { log } from '../util/log.js'
import type { IntegrationListenerReport } from './status.js'

// ─── The listener report (contract v1 §3.13) ────────────────────────────────
//
// The resident listener tells AgentChat when it cannot do its job, so the
// agent's `reachability` and its person's dashboard say so, instead of a
// socket that looks healthy while every run fails, or a silence that looks
// like a closed laptop. What is true is decided here and in the integration;
// when it is sent (one report per burst of changes, again every 30 minutes
// while not `ok`, backoff, never a throw) is the SDK kit's `ListenerReporter`.
//
//   the start preflight fails (signed out, missing, too old)    → not_ready, its reason
//   connected (the hello accepted) and the runtime healthy       → ok
//   the recheck after a failed run fails                         → runs_failing, its reason
//   the runtime check after a failed run fails (a usage limit,
//   a provider outage; health and the hand-over are unchanged)   → runs_failing, runtime_check_failed
//   while runs_failing: checked again after 30 min, 1 h, 2 h,
//   then every 4 h (the preflight; the runtime check only when
//   that is what failed), passing                                → ok
//   `logout`, `uninstall`, `daemon disable`                      → stopped, sent by that command
//                                                                   before the key or the service goes
//   a daemon that starts with AGENTCHAT_INTEGRATION=off          → stopped, once per identity it finds
//
// Only the home that holds the agent lock reports: a standby and a home that
// gave the agent up report nothing, and a daemon switched off nothing but
// that one `stopped` (none when another live home holds the agent). (A start that
// failed its preflight decided `not_ready` while it held the lock; the report
// goes out just after, while that home waits out its retry with the lock free,
// and the reporter is dropped as soon as a retry finds another home holding
// the agent.) A shutdown (SIGTERM: a service stop, a reboot) reports nothing
// either: a machine that comes back must read as offline meanwhile, not as
// uninstalled.
//
// One instance id per identity home (`listener-id`, made by the first
// listener there that reports), so a restarted daemon is the same install to
// the server, and the command that stops it on purpose names that install.

/** The file in the identity home that keeps this install's listener id. */
export const LISTENER_ID_FILE = 'listener-id'

/** `<home>/listener-id`. */
export function listenerIdPath(home: string): string {
  return path.join(home, LISTENER_ID_FILE)
}

/**
 * The home's listener id, made once and reused (the kit's
 * `listenerInstanceId`), or null when the home can keep none (said at warn):
 * the listener then serves without reporting.
 */
export async function ensureListenerInstanceId(home: string): Promise<string | null> {
  try {
    return await kit.listenerInstanceId(listenerIdPath(home))
  } catch (err) {
    log.warn(`listener report: no listener id could be kept in ${listenerIdPath(home)} (${err instanceof Error ? err.message : String(err)}); this listener serves without telling AgentChat its state`)
    return null
  }
}

/** The home's listener id when a listener made one; null otherwise. Never creates one. */
export function readListenerInstanceId(home: string): string | null {
  try {
    const id = fs.readFileSync(listenerIdPath(home), 'utf-8').trim()
    return kit.isListenerInstanceId(id) ? id : null
  } catch {
    return null
  }
}

/** What the integration tells AgentChat through: the kit's `ListenerReporter` (a fake in tests). */
export type ListenerReportSink = Pick<kit.ListenerReporter, 'set' | 'status'>

/** The kit reporter's timing (test seams; a listener uses the kit's defaults). */
export type ListenerReportTiming = Pick<kit.ListenerReporterOptions, 'coalesceMs' | 'minIntervalMs' | 'retryMs' | 'retryMaxMs' | 'resendMs'>

/** One attempt per report, this long: the reporter retries on its own clock. */
const DAEMON_REPORT_TIMEOUT_MS = 10_000
/** What a command waits for its `stopped` report, at most. */
export const STOPPED_REPORT_TIMEOUT_MS = 5_000

interface KeyedIdentity {
  readonly apiKey: string
  readonly apiBase: string
}

/** A client for reports only: one attempt each (the reporter, not the transport, retries). */
function reportClient(identity: KeyedIdentity, client: IntegrationClient, timeoutMs: number): AgentChatClient {
  return new AgentChatClient({
    apiKey: identity.apiKey,
    baseUrl: identity.apiBase,
    clientIdentity: clientIdentityOf(client),
    timeoutMs,
    retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
  })
}

export interface CreateListenerReporterOptions extends KeyedIdentity {
  readonly client: IntegrationClient
  readonly instanceId: string
  /** Test seam: what sends the reports (default: a client for this identity). */
  readonly api?: kit.ListenerReportClient
  readonly timing?: ListenerReportTiming
}

/** The daemon's reporter for one identity: a failure is said at warn, once per new failure, and retried by the kit. */
export function createListenerReporter(options: CreateListenerReporterOptions): kit.ListenerReporter {
  return new kit.ListenerReporter({
    client: options.api ?? reportClient(options, options.client, DAEMON_REPORT_TIMEOUT_MS),
    instanceId: options.instanceId,
    ...(options.timing ?? {}),
    onError: (err) => log.warn(err.message),
  })
}

/**
 * Say what is true now through `sink` (none: nothing). The reporter sends a
 * change about a second later and nothing for the same state again; a change
 * is said in the log.
 */
export function tellListener(sink: ListenerReportSink | null | undefined, state: Exclude<ListenerState, 'stopped'>, reasonKind?: ListenerReasonKind): void {
  if (sink === null || sink === undefined) return
  const reason = state === 'ok' ? null : (reasonKind ?? 'other')
  const now = sink.status()
  if (now.state !== state || now.reasonKind !== reason) {
    log.info(`listener report: ${state}${reason !== null ? ` (${reason})` : ''} — what AgentChat shows as this agent's reachability`)
  }
  sink.set(state, reason ?? undefined)
}

/** The reporter as the status file keeps it; null without one. */
export function listenerReportStatusOf(sink: ListenerReportSink | null | undefined): IntegrationListenerReport | null {
  if (sink === null || sink === undefined) return null
  const s = sink.status()
  return {
    instance_id: s.instanceId,
    state: s.state,
    reason_kind: s.reasonKind,
    reported: s.reported === null ? null : { state: s.reported.state, reason_kind: s.reported.reasonKind, at: s.reported.at },
    pending: s.pending,
    failures: s.failures,
    last_error: s.lastError,
    next_attempt_at: s.nextAttemptAt,
  }
}

// ─── An explicit stop ───────────────────────────────────────────────────────

export interface ReportListenerStoppedOptions {
  /** The identity home whose listener stops. */
  readonly home: string
  /** How the integration names itself to the server. */
  readonly client: IntegrationClient
  /**
   * The agent that home's listener serves (its key, base and handle, as
   * `resolveIdentity` gives it); null: nothing to report. Only a key the home
   * holds counts (`source: 'file'`): an exported key is not what the home's
   * listener serves (a service never carries one).
   */
  readonly identity: (KeyedIdentity & { readonly handle: string | null; readonly source?: 'file' | 'env' }) | null
  /** The one attempt's bound (default `STOPPED_REPORT_TIMEOUT_MS`). */
  readonly timeoutMs?: number
  /** Test seam: what sends the report. */
  readonly api?: kit.ListenerReportClient
}

/**
 * What came of a `stopped` report: `reported` (AgentChat holds it),
 * `failed` (it does not: `detail` says why; it then reads the listener as
 * offline once its socket is gone), or `skipped`: `no_identity` (no key
 * the home holds),
 * `no_listener` (no listener of this home ever reported: there is nothing
 * to stop), `standby` (another home's listener serves this agent: a
 * standby reports nothing).
 */
export type ListenerStoppedResult =
  | { readonly outcome: 'reported' }
  | { readonly outcome: 'failed'; readonly detail: string }
  | { readonly outcome: 'skipped'; readonly reason: 'no_identity' | 'no_listener' | 'standby' }

/**
 * Tell AgentChat this home's listener stops on purpose (`stopped`, contract
 * v1 §3.13), so the agent reads as switched off rather than as a computer
 * that is off. For the commands that end it — `logout`, `uninstall`, `daemon
 * disable` — and called BEFORE the key or the service goes: the report needs
 * the key, and it must come before the listener closes its socket. And for a
 * daemon that starts switched off (`AGENTCHAT_INTEGRATION=off`), once. One
 * attempt, bounded by `timeoutMs`; never throws (the command goes on either
 * way).
 */
export async function reportListenerStopped(options: ReportListenerStoppedOptions): Promise<ListenerStoppedResult> {
  const { home, identity } = options
  if (identity === null || identity.source === 'env') return { outcome: 'skipped', reason: 'no_identity' }
  const instanceId = readListenerInstanceId(home)
  if (instanceId === null) return { outcome: 'skipped', reason: 'no_listener' }
  if (identity.handle !== null) {
    // The agent lock names the home whose listener serves the agent. Another
    // home's, alive: this one stands by and reports nothing (its `stopped`
    // would be the agent's newest report, read as the serving listener's).
    let holder: ReturnType<typeof leaseHolder> = null
    try {
      holder = leaseHolder(agentLockPath({ apiBase: identity.apiBase, handle: identity.handle }))
    } catch {
      holder = null
    }
    if (holder !== null && holder.home !== undefined && path.resolve(holder.home) !== path.resolve(home)) return { outcome: 'skipped', reason: 'standby' }
  }
  const reporter = new kit.ListenerReporter({
    client: options.api ?? reportClient(identity, options.client, options.timeoutMs ?? STOPPED_REPORT_TIMEOUT_MS),
    instanceId,
  })
  try {
    reporter.set('stopped')
    if (await reporter.flush()) return { outcome: 'reported' }
    return { outcome: 'failed', detail: reporter.status().lastError ?? 'AgentChat did not take it' }
  } catch (err) {
    // The kit never rejects here; a bug must not stop the command that called it.
    return { outcome: 'failed', detail: err instanceof Error ? err.message : String(err) }
  } finally {
    reporter.stop()
  }
}

/** The line a command prints for a `stopped` report (no indent), or null when there was nothing to report. */
export function describeListenerStopped(result: ListenerStoppedResult): string | null {
  if (result.outcome === 'reported') return 'listener: AgentChat was told it stopped on purpose'
  if (result.outcome === 'failed') return `listener: could not tell AgentChat it stopped (${result.detail}); AgentChat shows it as offline instead`
  return null
}
