import { clientIdentityHeaders, HttpTransport, type AgentChatClientIdentity } from 'agentchatme'
import type { SetupVerdict } from './setup.js'
import { serviceDryRun } from './setup.js'

// ─── Setup telemetry: one event per command that says a verdict ─────────────
//
// Every command that prints a `Setup:` line (install, register, login,
// recover, status, doctor) tells AgentChat what it said, once, at its end:
// `POST /v1/telemetry` with one `setup_verdict` event (contract v1,
// "Client telemetry"). So the setup's failure points can be seen without
// asking anyone: where agents stop, and on what.
//
// What is sent: the verdict's state, which command, whether the next step is
// the person's, the verdict's reason word, the command's exit code and how
// long it took — and the headers every SDK call carries (the client and its
// version, X-AgentChat-Platform with the install id), with the key only when
// the home holds one. Nothing else: no key in the body, no email, handle or
// code typed, no path, no server sentence, no text of the verdict.
//
// It never prints, never changes an exit code, and never holds a command up
// for more than TELEMETRY_TIMEOUT_MS (one attempt, awaited before the
// process exits: a short-lived CLI would drop a request left in flight). Any
// answer or failure is silent — an older server's 404 included.
// AGENTCHAT_TELEMETRY=off (or 0, false) sends nothing, and makes no install
// id. Under AGENTCHAT_SERVICE_DRY_RUN (sandboxes, tests) nothing reaches the
// network unless a sender is given.

export const TELEMETRY_ENV = 'AGENTCHAT_TELEMETRY'
export const TELEMETRY_PATH = '/v1/telemetry'
export const TELEMETRY_VERSION = 1 as const
/** The most a command waits for its event to be taken. */
export const TELEMETRY_TIMEOUT_MS = 1_500

/** The commands a `setup_verdict` names (the server's closed list). */
export type SetupCommand = 'install' | 'register' | 'login' | 'recover' | 'doctor' | 'status' | 'uninstall' | 'daemon' | 'other'

export interface SetupVerdictEvent {
  readonly name: 'setup_verdict'
  readonly at: string
  readonly props: {
    readonly state: string
    readonly command: SetupCommand
    readonly needs_person: boolean
    readonly reason?: string
    readonly exit_code: number
    readonly duration_ms: number
  }
}

export interface TelemetryBody {
  readonly version: typeof TELEMETRY_VERSION
  readonly events: readonly SetupVerdictEvent[]
}

/** One request, as a sender gets it. */
export interface TelemetryRequest {
  readonly apiBase: string
  /** The identity's key, or null: the event is then anonymous (the install id names it). */
  readonly apiKey: string | null
  /** What the request names itself with (the SDK turns it into the client headers and X-AgentChat-Platform). */
  readonly clientIdentity: AgentChatClientIdentity
  readonly body: TelemetryBody
  /** Aborted when the time is up. */
  readonly signal: AbortSignal
}

/** Sends one request; may throw (the caller swallows it). */
export type TelemetrySender = (request: TelemetryRequest) => Promise<void>

/** `AGENTCHAT_TELEMETRY` set to `off`, `0` or `false` (any case). */
export function telemetryOff(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[TELEMETRY_ENV]?.trim().toLowerCase()
  return v === 'off' || v === '0' || v === 'false'
}

const REASON_SHAPE = /^[a-z][a-z0-9_]{0,31}$/

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** The event for a verdict a command said. */
export function setupVerdictEvent(verdict: SetupVerdict, facts: { command: SetupCommand; exitCode: number; startedAt: number; now?: number }): SetupVerdictEvent {
  const now = facts.now ?? Date.now()
  const reason = verdict.reason
  return {
    name: 'setup_verdict',
    at: new Date(now).toISOString(),
    props: {
      state: verdict.state,
      command: facts.command,
      needs_person: verdict.needs_person,
      ...(reason !== null && REASON_SHAPE.test(reason) ? { reason } : {}),
      exit_code: clampInt(facts.exitCode, 0, 255),
      duration_ms: clampInt(now - facts.startedAt, 0, 600_000),
    },
  }
}

/**
 * The network sender: one attempt through the SDK's transport, so the request
 * carries exactly the headers every SDK call does (no copy of them here).
 */
export const httpTelemetrySender: TelemetrySender = async (request) => {
  const transport = new HttpTransport({
    baseUrl: request.apiBase,
    defaultHeaders: clientIdentityHeaders(request.clientIdentity),
    ...(request.apiKey !== null ? { apiKey: request.apiKey } : {}),
    timeoutMs: TELEMETRY_TIMEOUT_MS,
    retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
  })
  await transport.request('POST', TELEMETRY_PATH, { body: request.body, signal: request.signal })
}

export interface SendSetupVerdictOptions {
  readonly command: SetupCommand
  readonly exitCode: number
  readonly startedAt: number
  readonly apiBase: string
  readonly apiKey: string | null
  readonly clientIdentity: AgentChatClientIdentity
  /** Default: the network (`httpTelemetrySender`), or nothing at all under AGENTCHAT_SERVICE_DRY_RUN. */
  readonly sender?: TelemetrySender
  readonly env?: NodeJS.ProcessEnv
  readonly timeoutMs?: number
}

/**
 * Tell AgentChat what a command said. Resolves within the timeout whatever
 * happens; never throws, never prints. Nothing is sent when telemetry is
 * off, or when there is neither an install id nor a key to name the sender.
 */
export async function sendSetupVerdict(verdict: SetupVerdict, opts: SendSetupVerdictOptions): Promise<void> {
  const env = opts.env ?? process.env
  if (telemetryOff(env)) return
  if (opts.apiKey === null && opts.clientIdentity.installId === undefined) return
  const sender = opts.sender ?? (serviceDryRun(env) ? null : httpTelemetrySender)
  if (sender === null) return
  const controller = new AbortController()
  const timeoutMs = opts.timeoutMs ?? TELEMETRY_TIMEOUT_MS
  let timer: NodeJS.Timeout | undefined
  try {
    const body: TelemetryBody = { version: TELEMETRY_VERSION, events: [setupVerdictEvent(verdict, opts)] }
    const sent = sender({ apiBase: opts.apiBase, apiKey: opts.apiKey, clientIdentity: opts.clientIdentity, body, signal: controller.signal }).catch(() => undefined)
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        resolve()
      }, timeoutMs)
      timer.unref?.()
    })
    await Promise.race([sent, timedOut])
  } catch {
    /* never a reason for a command to fail */
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
