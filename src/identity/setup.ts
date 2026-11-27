import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import type { SignupFlow, integration as kit } from 'agentchatme'
import { credentialsPath, type PendingSignup } from './credentials.js'
import type { ListenerEnsure, PlacementProblem } from './host-profile.js'
import { alwaysOnOptedOut, alwaysOnState, alwaysOnWanted, readAlwaysOnInstalledVersion } from '../daemon/health.js'
import { DAEMON_LOCK_FILE } from '../daemon/leader-lock.js'
import { leaseHolder } from '../util/lease.js'
import { INTEGRATION_ENV } from '../integration/profile.js'
import { integrationStatusFresh, readIntegrationStatus, runtimeCheckFailingNow } from '../integration/status.js'

// ─── The setup verdict: is this agent set up, and what is left? ─────────────
//
// One answer, computed here and nowhere else. `status` prints it first (and
// as `.setup` in `--json`), install and every account command that did what
// it was asked print it last. It says one of three things, with no guessing
// left to whoever runs the command, an agent or a person at a terminal:
//
//   done                     `ready`;
//   the exact next command   `command`, named in `next`;
//   the one thing only the person can do   `needs_person`, with `ask`.
//
// "Set up" means a peer's message starts a run on this computer: an account,
// the hosted tools in place, and this host's listener connected as the agent.
// Every input is a plain value (`setupVerdict` is pure); `readListener` reads
// the listener's own files in the identity home, and the server's view is
// one `GET /v1/agents/me` (with `reachability` when the server sends it:
// contract v1 §3.12, read loosely here until the SDK types carry it).

/** A listener registered, or a key saved, this recently is still coming up: not "down". The daemon follows a credential within 5 s; a service manager's cold start can take far longer than that. */
export const SETUP_GRACE_MS = 90_000

/**
 * A daemon follows a key change within its 5 s poll. A status older than the
 * key, from a daemon still alive this long after the key was saved, is its
 * word for this key: the key did not change (the same key saved again), so
 * the daemon had nothing to follow and nothing new to write.
 */
const KEY_FOLLOW_MS = 15_000

export const SETUP_STATES = [
  'no_account',
  'code_pending',
  'code_expired',
  'key_refused',
  'suspended',
  'unreachable',
  'paused',
  'tools_missing',
  'listener_off',
  'listener_missing',
  'listener_down',
  'listener_starting',
  'listener_failing',
  'ready',
] as const
export type SetupState = (typeof SETUP_STATES)[number]

export interface SetupVerdict {
  readonly state: SetupState
  /** What is the case and what to do, in plain words with the exact command: the text after `Setup: <state> — `. */
  readonly next: string
  /** The exact command to run next, or null (done, or the next step is the person's). */
  readonly command: string | null
  /** Only the person can do the next step (sign the runtime in, turn the listener back on, …). */
  readonly needs_person: boolean
  /** What to ask the person, in plain words; null when there is nothing to ask. Also set when the person may be needed (the emailed code, when the inbox is not yours to read). */
  readonly ask: string | null
  /** The facts behind it, as found: the listener's own error, the server's words, a note. Null when none. */
  readonly detail: string | null
}

/** The verdict in one line. */
export function formatSetupVerdict(verdict: SetupVerdict): string {
  return `Setup: ${verdict.state} — ${verdict.next}`
}

// ─── Sign-up helpers (shared with the identity commands) ───────────────────

type AccountKind = kit.AccountKind

/** What a sign-up start sends: what was typed, trimmed. */
export interface SignupInput {
  email: string
  handle?: string
  display_name?: string
  description?: string
}

/** The step that answers a pending code of each kind (`next_step` while the code is pending). */
export const VERIFY_STEP: Readonly<Record<AccountKind, string>> = { register: 'verify', recover: 'recover_verify' }

/** A flag value as a shell takes it: bare when plain, else in double quotes. */
export function shellValue(value: string): string {
  return /^[A-Za-z0-9@%+=:,./_-]+$/.test(value) ? value : JSON.stringify(value)
}

function receivedAtMs(pending: PendingSignup): number | null {
  const at = Date.parse(pending.received_at)
  return Number.isFinite(at) ? at : null
}

/** When the pending code stops working, in ms, or null when the answer did not say. */
function codeExpiresAtMs(pending: PendingSignup): number | null {
  const received = receivedAtMs(pending)
  if (pending.flow.expires_in_s !== undefined && received !== null) return received + pending.flow.expires_in_s * 1000
  if (pending.flow.expires_at !== undefined) {
    const at = Date.parse(pending.flow.expires_at)
    if (Number.isFinite(at)) return at
  }
  return null
}

/**
 * Whether the code a pending record holds may still work: until
 * `expires_in_s` from its answer, else until `expires_at`. Unknown counts as
 * yes; the server says so when the code is gone.
 */
export function codeMayWork(pending: PendingSignup, now = Date.now()): boolean {
  const at = codeExpiresAtMs(pending)
  return at === null || at > now
}

/** Seconds left of the pending answer's `resend_after_s`: until a new code may be sent to that email (0: now). */
export function resendLeftS(pending: PendingSignup | null, now = Date.now()): number {
  if (pending === null || pending.flow.resend_after_s === undefined) return 0
  const received = receivedAtMs(pending)
  if (received === null) return 0
  return Math.max(0, Math.ceil((pending.flow.resend_after_s * 1000 - (now - received)) / 1000))
}

/** "Run `cmd`", after a wait when there is one. */
export function runLine(command: string, waitS = 0): string {
  return waitS > 0 ? `Wait ${waitS} s, then run \`${command}\`` : `Run \`${command}\``
}

/** The command that starts `kind` again, sending `input`; `blank` leaves that field for the person to fill in. */
export function startCommandOf(invocation: string, kind: AccountKind, input: SignupInput, blank?: 'email' | 'handle'): string {
  const email = blank === 'email' ? '<email>' : shellValue(input.email)
  const handle = blank === 'handle' ? '<handle>' : input.handle !== undefined ? shellValue(input.handle) : null
  if (kind === 'recover') return `${invocation} recover${handle !== null ? ` --handle ${handle}` : ''} --email ${email}`
  return [
    `${invocation} register --email ${email} --handle ${handle ?? '<handle>'}`,
    ...(input.display_name !== undefined ? [`--display-name ${shellValue(input.display_name)}`] : []),
    ...(input.description !== undefined ? [`--description ${shellValue(input.description)}`] : []),
  ].join(' ')
}

/** The command that answers a pending code: with `code`, or a placeholder of the server's `code_length`. */
export function codeCommandOf(invocation: string, kind: AccountKind, flow: SignupFlow, code?: string): string {
  const value = code !== undefined ? shellValue(code) : flow.code_length !== undefined ? `<${flow.code_length} digits>` : '<code>'
  return `${invocation} ${kind} --code ${value}`
}

// ─── What the server says (GET /v1/agents/me) ──────────────────────────────

/** `reachability` as far as the verdict reads it (contract v1 §3.12). Unknown states and fields are kept as words or ignored. */
export interface ReachabilityView {
  readonly state: string
  readonly via: string | null
  readonly problemKind: string | null
  readonly problemText: string | null
  readonly text: string | null
}

const ReachabilitySchema = z
  .object({
    state: z.string(),
    via: z.string().nullable().optional(),
    problem: z.object({ kind: z.string(), text: z.string().optional() }).passthrough().nullable().optional(),
    text: z.string().optional(),
  })
  .passthrough()

/**
 * The `reachability` a `GET /v1/agents/me` answer carries, or null: absent
 * (a server before it, or one that could not read it), or not in a shape
 * this release reads. Never required.
 */
export function reachabilityOf(me: unknown): ReachabilityView | null {
  const raw = me !== null && typeof me === 'object' ? (me as { reachability?: unknown }).reachability : undefined
  if (raw === undefined || raw === null) return null
  const parsed = ReachabilitySchema.safeParse(raw)
  if (!parsed.success) return null
  const r = parsed.data
  return {
    state: r.state,
    via: r.via ?? null,
    problemKind: r.problem?.kind ?? null,
    problemText: r.problem?.text ?? null,
    text: r.text ?? null,
  }
}

/** The server's answer to `GET /v1/agents/me`, for the verdict. */
export type ServerView =
  | { readonly kind: 'ok'; readonly handle: string; readonly reachability: ReachabilityView | null }
  | { readonly kind: 'refused'; readonly detail: string }
  | { readonly kind: 'suspended'; readonly detail: string }
  | { readonly kind: 'unreachable'; readonly detail: string }

// ─── What the listener says (its own files in the identity home) ──────────

/** What the listener's daemon last said for the current credential. */
export type DaemonWord =
  /** Nothing for this credential: no status, one written before the key was saved, or one too old with no daemon alive. */
  | { readonly kind: 'none' }
  /** Installed with the integration switched off (`AGENTCHAT_INTEGRATION=off`): no socket, no run. */
  | { readonly kind: 'off' }
  | { readonly kind: 'ready'; readonly runsFailing: { readonly reason: string; readonly since: string } | null; readonly runtimeCheckFailing: boolean }
  | { readonly kind: 'standby'; readonly home: string | null; readonly pid: number | null }
  | { readonly kind: 'unservable'; readonly reason: 'key_refused' | 'runs_failing'; readonly detail: string }
  /** It could not start: the runtime is not ready, the server could not be asked, … (`last_error`). */
  | { readonly kind: 'start_failure'; readonly detail: string }
  | { readonly kind: 'blocked'; readonly detail: string | null }
  | { readonly kind: 'connecting' }

export interface ListenerReading {
  /** The person switched it off (`daemon disable`, `uninstall`). */
  readonly optedOut: boolean
  /** A service was registered for this home (`always-on.wanted`). */
  readonly wanted: boolean
  /** The release the registered service runs, or null when not recorded. */
  readonly installedVersion: string | null
  readonly daemon: DaemonWord
  /** A daemon process holds this home's lease now (renewed every 10 s). */
  readonly alive: boolean
  /** Registered or signed in within `SETUP_GRACE_MS`. */
  readonly withinGrace: boolean
  /** When the daemon last wrote its status, or null. */
  readonly lastAliveAt: string | null
}

function mtimeMs(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return null
  }
}

export interface ReadListenerOptions {
  readonly now?: number
  /**
   * The daemon process that held this home's lease before a command
   * registered the service again (`daemonPidOf`, read just before): what it
   * wrote is not the new process's word, however recent.
   */
  readonly replacedPid?: number | null
}

/** The pid of the daemon that holds this home's lease now, or null. */
export function daemonPidOf(home: string): number | null {
  return leaseHolder(path.join(home, DAEMON_LOCK_FILE))?.pid ?? null
}

/**
 * The listener as its own files say it, for `handle`: the always-on markers,
 * the daemon's status file (only when it was written for the credential the
 * home holds now and names this handle), and the home's lease (a daemon
 * process alive: its status is written once while it keeps failing to
 * start, so an old file is not proof it is gone; and a "ready" from a process
 * that is gone is not one). Pure reads; never throws.
 */
export function readListener(home: string, handle: string | null, options: ReadListenerOptions = {}): ListenerReading {
  const now = options.now ?? Date.now()
  const status = readIntegrationStatus(home)
  const alive = leaseHolder(path.join(home, DAEMON_LOCK_FILE)) !== null
  const keySavedAt = mtimeMs(credentialsPath(home))
  const writtenAt = status === null ? Number.NaN : Date.parse(status.updated_at)
  const replaced = options.replacedPid ?? null
  const forThisKey =
    status !== null &&
    handle !== null &&
    status.handle === handle &&
    (replaced === null || status.pid !== replaced) &&
    (keySavedAt === null ||
      writtenAt >= Math.floor(keySavedAt) ||
      // The same key saved again: nothing for the daemon to follow, so its last word stands.
      (alive && now - keySavedAt > KEY_FOLLOW_MS))
  const fresh = integrationStatusFresh(status, now)
  let daemon: DaemonWord = { kind: 'none' }
  if (status !== null && forThisKey && (fresh || alive)) {
    const unservable = status.unservable ?? null
    const standby = status.standby ?? null
    if (unservable !== null) daemon = { kind: 'unservable', reason: unservable.reason, detail: unservable.detail }
    else if (standby !== null) {
      if (alive) daemon = { kind: 'standby', home: standby.home, pid: standby.pid }
    } else if (status.socket === 'off') daemon = { kind: 'off' }
    else if (status.socket === 'ready') {
      // Rewritten every 30 s while ready, by a process that holds the lease: an
      // old "ready", or one whose process is gone, is a daemon that stopped.
      if (fresh && alive) {
        const failing = status.runs_failing ?? null
        daemon = { kind: 'ready', runsFailing: failing === null ? null : { reason: failing.reason, since: failing.since }, runtimeCheckFailing: runtimeCheckFailingNow(status) }
      }
    } else if (status.socket === 'blocked') daemon = { kind: 'blocked', detail: status.last_error }
    else if (status.socket === 'idle' && status.last_error !== null) daemon = { kind: 'start_failure', detail: status.last_error }
    else daemon = { kind: 'connecting' }
  }
  const withinGrace = alwaysOnState(home) === 'starting' || (keySavedAt !== null && now - keySavedAt >= 0 && now - keySavedAt <= SETUP_GRACE_MS)
  return {
    optedOut: alwaysOnOptedOut(home),
    wanted: alwaysOnWanted(home),
    installedVersion: readAlwaysOnInstalledVersion(home),
    daemon,
    alive,
    withinGrace,
    lastAliveAt: status?.updated_at ?? null,
  }
}

/**
 * Why a listener cannot start runs, in the server's words for it (contract
 * v1 §3.13 `reason_kind`): what the verdict says to the agent, and what a
 * listener report sends. Read from the runtime check's own words, which the
 * presets in this package write (`claude is not signed in …`, `codex login
 * status failed: …`, `… not found on PATH …`, `…; AgentChat requires … >= …`).
 */
export type ListenerReasonKind = 'not_signed_in' | 'runtime_missing' | 'runtime_outdated' | 'runtime_check_failed' | 'other'

export function listenerReasonKindOf(detail: string): ListenerReasonKind {
  const text = detail.toLowerCase()
  if (/not signed in|not logged in|login status failed/.test(text)) return 'not_signed_in'
  if (/not found on path|\benoent\b/.test(text)) return 'runtime_missing'
  if (/agentchat requires [^;]*>=/.test(text)) return 'runtime_outdated'
  if (/runtime check/.test(text)) return 'runtime_check_failed'
  return 'other'
}

// ─── The verdict ───────────────────────────────────────────────────────────

export interface SetupInputs {
  /** What a user types to reach this integration. */
  readonly invocation: string
  /** The runtime's name for people (`Claude Code`). */
  readonly label: string
  /** This build's version: a registered service from an older one is noted. */
  readonly version: string
  /** The identity home (named when the key is only in the environment). */
  readonly home: string
  /** The identity the home names now, or null. */
  readonly identity: { readonly handle: string | null; readonly source: 'file' | 'env' } | null
  readonly pending: PendingSignup | null
  /** The server's answer; null when it was not asked (no identity). */
  readonly server: ServerView | null
  /** The listener; null for a host that places none (the verdict then stops at the account). */
  readonly listener: ListenerReading | null
  /** What this command's `ensureListener` did, if it ran. */
  readonly ensure?: ListenerEnsure | null
  /** A placement problem that keeps runs from having the AgentChat tools. */
  readonly tools?: PlacementProblem | null
  /** Said right after a sign-in: the ready text ends with the one thing to tell the person. */
  readonly afterSignIn?: boolean
  readonly now?: number
}

const PERSON = 'the person you work with'

function verdict(state: SetupState, next: string, extra: Partial<Omit<SetupVerdict, 'state' | 'next'>> = {}): SetupVerdict {
  return { state, next, command: extra.command ?? null, needs_person: extra.needs_person ?? false, ask: extra.ask ?? null, detail: extra.detail ?? null }
}

/** `1.2.3` as numbers, or null. */
function versionOf(text: string | null): number[] | null {
  const m = text === null ? null : /^(\d+)\.(\d+)\.(\d+)/.exec(text.trim())
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])]
}

/**
 * Whether release `a` is newer than `b` (`x.y.z`, slot by slot, numerically);
 * false when either cannot be read. What the verdict calls an older listener,
 * and what a host's implicit ensure never replaces (no downgrade).
 */
export function newerRelease(a: string | null, b: string | null): boolean {
  const x = versionOf(a)
  const y = versionOf(b)
  if (x === null || y === null) return false
  for (let i = 0; i < 3; i++) if (x[i]! !== y[i]!) return x[i]! > y[i]!
  return false
}

function minutesLeft(pending: PendingSignup, now: number): number | null {
  const at = codeExpiresAtMs(pending)
  return at === null ? null : Math.max(1, Math.ceil((at - now) / 60_000))
}

function accountVerdict(i: SetupInputs, now: number): SetupVerdict {
  const inv = i.invocation
  const pending = i.pending
  if (pending === null) {
    const register = `${inv} register --email <email> --handle <handle>`
    return verdict(
      'no_account',
      `this ${i.label} agent has no AgentChat account yet. New account: run \`${register}\` (an email whose inbox you or ${PERSON} can read, and a @handle they chose or accepted). Existing account with its API key: if an AgentChat answer gave you the key, write it alone into a file with your file-editing tool; if ${PERSON} holds it, ask them to save it into a file and tell you where (never to paste it here). Then run \`${inv} login --api-key - < <that file>\` and delete the file.`,
      { command: register },
    )
  }
  const what = pending.kind === 'recover' ? `a recovery${pending.handle !== undefined ? ` for @${pending.handle}` : ` of the account on ${pending.email}`}` : `a registration of @${pending.handle ?? '?'}`
  if (pending.flow.next_step === VERIFY_STEP[pending.kind] && pending.flow.pending_id !== undefined && codeMayWork(pending, now)) {
    const command = codeCommandOf(inv, pending.kind, pending.flow)
    const code = pending.flow.code_length !== undefined ? `the ${pending.flow.code_length}-digit code` : 'the code'
    const left = minutesLeft(pending, now)
    return verdict(
      'code_pending',
      `${what} is waiting on ${code} AgentChat emailed to ${pending.email}${left !== null ? `; it expires in ${left} minute${left === 1 ? '' : 's'}` : ''}. Run \`${command}\` with it. If you cannot read that inbox, ask ${PERSON} for the code.`,
      { command, ask: `AgentChat emailed a code to ${pending.email}. What is it?` },
    )
  }
  const command = startCommandOf(inv, pending.kind, pending)
  const wait = resendLeftS(pending, now)
  return verdict(
    'code_expired',
    `the code AgentChat emailed for ${what} has expired. For a new one, ${wait > 0 ? `wait ${wait} s, then run` : 'run'} \`${command}\`.`,
    { command },
  )
}

/**
 * The setup verdict from plain inputs; null when there is nothing this host
 * can judge (no listener of its own, and the account is fine).
 */
export function setupVerdict(i: SetupInputs): SetupVerdict | null {
  const now = i.now ?? Date.now()
  const inv = i.invocation
  if (i.identity === null) return accountVerdict(i, now)

  const handle = i.server?.kind === 'ok' ? i.server.handle : i.identity.handle
  const who = handle !== null ? `@${handle}` : 'this agent'
  const server = i.server

  if (server?.kind === 'suspended') {
    return verdict(
      'suspended',
      `AgentChat has suspended ${who} (${server.detail}): nothing on this computer changes that, and recovering the account does not help. ${PERSON[0]!.toUpperCase()}${PERSON.slice(1)} emails support@agentchat.me.`,
      { needs_person: true, ask: `AgentChat has suspended ${who}. Could you email support@agentchat.me about it?`, detail: server.detail },
    )
  }
  if (server?.kind === 'refused') {
    const pending = i.pending
    if (pending !== null && pending.kind === 'recover' && pending.flow.next_step === VERIFY_STEP.recover && codeMayWork(pending, now)) {
      const command = codeCommandOf(inv, 'recover', pending.flow)
      return verdict(
        'key_refused',
        `AgentChat refuses the key stored for ${who} (${server.detail}), and a recovery code was emailed to ${pending.email}: run \`${command}\` with it. If you cannot read that inbox, ask ${PERSON} for the code.`,
        { command, ask: `AgentChat emailed a code to ${pending.email}. What is it?`, detail: server.detail },
      )
    }
    const recover = `${inv} recover --handle ${handle ?? '<handle>'} --email <email>`
    return verdict(
      'key_refused',
      `AgentChat refuses the key stored for ${who} (${server.detail}). Ask ${PERSON} whether they have its current key: if they do, they save it into a file and you run \`${inv} login --api-key - < <that file>\`; if not, \`${recover}\` emails a code and replaces the key, and anything still using the old key stops working.`,
      {
        command: recover,
        needs_person: true,
        ask: `AgentChat refuses ${who}'s key. Do you have its current API key? If not, may I recover the account by email? That replaces the key, and anything still using the old one stops working.`,
        detail: server.detail,
      },
    )
  }
  if (server?.kind === 'unreachable') {
    return verdict('unreachable', `AgentChat could not be reached from this computer (${server.detail}). Check the network, then run \`${inv} status\` again.`, {
      command: `${inv} status`,
      detail: server.detail,
    })
  }

  const reach = server?.kind === 'ok' ? server.reachability : null
  if (reach?.state === 'paused') {
    return verdict(
      'paused',
      `${reach.text ?? `the person who claimed ${who} paused it on AgentChat, so nothing reaches it until they resume it.`} Only they can resume it: ask them.`,
      { needs_person: true, ask: `${who} is paused on AgentChat, so other agents' messages do not reach it. Could you resume it?`, detail: reach.text },
    )
  }
  const tools = i.tools ?? null
  if (tools !== null) {
    return verdict('tools_missing', tools.text, {
      command: tools.command ?? (tools.needsPerson === true ? null : `${inv} doctor --fix`),
      needs_person: tools.needsPerson === true,
      ask: tools.ask ?? null,
      detail: tools.detail ?? null,
    })
  }
  const r = i.listener
  if (r === null) return null
  return listenerVerdict(i, r, who, reach)
}

function listenerVerdict(i: SetupInputs, r: ListenerReading, who: string, reach: ReachabilityView | null): SetupVerdict {
  const inv = i.invocation
  const label = i.label
  const enable = `${inv} daemon install`
  const ensure = i.ensure ?? null

  if (r.optedOut || ensure?.outcome === 'opted_out') {
    return verdict(
      'listener_off',
      `AgentChat's listener for ${label} is switched off on this computer, so a peer's message does not start a run here; messages wait on AgentChat. Only ${PERSON} turns it back on: ask them, and if they agree, run \`${enable}\`.`,
      {
        command: enable,
        needs_person: true,
        ask: `AgentChat's listener is off on this computer, so other agents' messages to ${who} wait unanswered. May I turn it back on? It starts a ${label} run here when one of them writes.`,
      },
    )
  }
  if (r.daemon.kind === 'off') {
    return verdict(
      'listener_off',
      `the listener on this computer was installed with ${INTEGRATION_ENV}=off, so it holds no connection and starts no run; messages wait on AgentChat. Ask ${PERSON}; if they agree, run \`${enable}\` from a shell where ${INTEGRATION_ENV} is not set.`,
      {
        command: enable,
        needs_person: true,
        ask: `AgentChat's listener on this computer was installed switched off (${INTEGRATION_ENV}=off), so other agents' messages to ${who} wait unanswered. May I turn it on?`,
      },
    )
  }
  if (ensure?.outcome === 'failed') {
    return verdict(
      'listener_missing',
      `the listener could not be installed (${ensure.detail ?? 'no reason given'}). Run \`${enable}\` to try again; if it fails the same way, show ${PERSON} this line (${label} may ask them to approve the command).`,
      { command: enable, detail: ensure.detail },
    )
  }
  if (!r.wanted) {
    return verdict('listener_missing', `nothing on this computer listens for ${who}, so a peer's message cannot start a run here. Run \`${inv}\` to install the listener.`, { command: inv })
  }
  if (i.identity?.source === 'env') {
    const command = `printenv AGENTCHAT_API_KEY | ${inv} login --api-key -`
    return verdict(
      'listener_failing',
      `the key is only in AGENTCHAT_API_KEY, and the listener reads only ${credentialsPath(i.home)}. Save it there: run \`${command}\`.`,
      { command },
    )
  }

  const stale = newerRelease(i.version, r.installedVersion)
  const staleNote = stale ? `the listener installed here is ${r.installedVersion}; \`${inv}\` updates it to ${i.version}` : null
  const d = r.daemon
  switch (d.kind) {
    case 'ready': {
      if (d.runsFailing !== null) {
        // The runtime's own words first (signed out, missing, too old); a failed model check only explains what they do not.
        const kind = listenerReasonKindOf(d.runsFailing.reason)
        return failing(i, who, kind === 'other' && d.runtimeCheckFailing ? 'runtime_check_failed' : kind, d.runsFailing.reason, true, d.runsFailing.since)
      }
      const server = serverSays(i, who, reach)
      if (server !== null) return server
      return verdict('ready', `${who} is listening on this computer: a peer's message starts a ${label} run here.${staleNote !== null ? ` (${staleNote}.)` : ''}${readyTail(i)}`, { detail: staleNote })
    }
    case 'standby': {
      const other = `${d.home ?? 'another identity home'}${d.pid !== null ? `, pid ${d.pid}` : ''}`
      // Ready only when that listener says it is connected (its own status), and the server does not say otherwise.
      const holder = d.home !== null ? readListener(d.home, i.server?.kind === 'ok' ? i.server.handle : (i.identity?.handle ?? null), { now: i.now ?? Date.now() }).daemon : null
      if (holder === null || holder.kind !== 'ready') {
        return starting(i, who, ` (another listener on this computer holds it, ${other}, and does not say it is connected)`, `another listener on this computer holds ${who}: ${other}`)
      }
      const server = serverSays(i, who, reach)
      if (server !== null) return server
      return verdict(
        'ready',
        `${who} is listening on this computer through another listener (${other}): a peer's message starts a run there, and this ${label} listener stands by until it stops.${readyTail(i)}`,
        { detail: [`another listener on this computer serves ${who} from ${d.home}`, ...(staleNote !== null ? [staleNote] : [])].join('; ') },
      )
    }
    case 'unservable':
      // This home gave the agent up and holds no socket: never "connected".
      return failing(i, who, d.reason === 'runs_failing' ? listenerReasonKindOf(d.detail) : 'other', d.detail, false, null)
    case 'start_failure':
      return failing(i, who, listenerReasonKindOf(d.detail), d.detail, false, null)
    case 'blocked':
      return failing(i, who, 'other', d.detail ?? 'the server refused its connection', false, null)
    case 'connecting':
      return starting(i, who, '', null)
    case 'none': {
      if (r.withinGrace || ensure?.outcome === 'installed' || r.alive) return starting(i, who, '', null)
      if (stale) {
        return verdict(
          'listener_missing',
          `the listener installed here is from an older release (${r.installedVersion}; this is ${i.version}) and is not connected. Run \`${inv}\` to update it.`,
          { command: inv, detail: staleNote },
        )
      }
      return verdict(
        'listener_down',
        `the listener for ${who} is installed but not running${r.lastAliveAt !== null ? ` (last sign of life ${r.lastAliveAt})` : ''}. Run \`${enable}\` to start it again, then \`${inv} status\`.`,
        { command: enable },
      )
    }
  }
}

/** What every ready verdict ends with: the one thing for the person, said once right after a sign-in. */
function readyTail(i: SetupInputs): string {
  return i.afterSignIn === true
    ? ` Last, tell ${PERSON}: open a new ${i.label} session to have the AgentChat tools in this chat; receiving does not need it.`
    : ` A new ${i.label} session has the AgentChat tools in its chat; receiving does not need one.`
}

/**
 * When the local listener says it is connected: what the server's
 * `reachability` adds (absent: nothing). The server counts a live socket
 * before anything else (ready via `socket`, or failing via `socket` on the
 * listener's own report), so anything else means it does not see this
 * connection yet.
 */
function serverSays(i: SetupInputs, who: string, reach: ReachabilityView | null): SetupVerdict | null {
  if (reach === null || (reach.state === 'ready' && reach.via === 'socket')) return null
  const inv = i.invocation
  if (reach.state === 'failing' && reach.via === 'socket') {
    const text = reach.problemText ?? reach.text ?? 'AgentChat says the listener cannot start runs.'
    return verdict('listener_failing', `${text} Then run \`${inv} status\`.`, {
      command: `${inv} status`,
      needs_person: true,
      ask: `AgentChat says about the listener on this computer: "${text}" Could you look at it?`,
      detail: text,
    })
  }
  return starting(i, who, ' (it says it is connected; AgentChat does not see the connection yet)', reach.text)
}

function starting(i: SetupInputs, who: string, why: string, detail: string | null): SetupVerdict {
  const inv = i.invocation
  return verdict(
    'listener_starting',
    `the listener is connecting as ${who}${why}. Wait 10 s, then run \`${inv} status\`; if it still says starting after a minute, run \`${inv} doctor\`.`,
    { command: `${inv} status`, detail },
  )
}

/** The listener cannot start runs: what only the person can do, by reason; anything else is `doctor`'s to explain. */
function failing(i: SetupInputs, who: string, kind: ListenerReasonKind, detail: string, connected: boolean, since: string | null): SetupVerdict {
  const inv = i.invocation
  const label = i.label
  const status = `${inv} status`
  switch (kind) {
    case 'not_signed_in':
      // The runtime's own check names how it is signed in (`run \`…\` once and sign in`); this engine names no runtime.
      return verdict(
        'listener_failing',
        `the listener for ${who} cannot start ${label} runs: ${label} is not signed in for it (${detail}). Only ${PERSON} can sign it in: ask them to sign ${label} in on this computer (the words in brackets say how), then run \`${status}\`.`,
        {
          command: status,
          needs_person: true,
          ask: `${label} is not signed in for AgentChat's listener on this computer, so it cannot answer other agents. Could you sign it in? Its check says: ${detail}`,
          detail,
        },
      )
    case 'runtime_missing':
      return verdict(
        'listener_failing',
        `the listener for ${who} cannot find ${label} (${detail}). Ask ${PERSON} to install ${label} where the listener finds it, then run \`${inv} daemon install\`.`,
        { command: `${inv} daemon install`, needs_person: true, ask: `AgentChat's listener cannot find ${label} on this computer. Could you install it, or tell me where it is?`, detail },
      )
    case 'runtime_outdated':
      return verdict('listener_failing', `${label} on this computer is older than AgentChat needs (${detail}). Ask ${PERSON} to update ${label}, then run \`${status}\`.`, {
        command: status,
        needs_person: true,
        ask: `AgentChat needs a newer ${label} on this computer. Could you update it?`,
        detail,
      })
    case 'runtime_check_failed':
    case 'other':
      if (connected) {
        return verdict(
          'listener_failing',
          `the listener for ${who} is connected, but ${label} runs fail (${detail}${since !== null ? `; since ${since}` : ''}), which usually means a usage limit or a provider outage. Ask ${PERSON} to check ${label}'s account and limits on this computer.`,
          { command: status, needs_person: true, ask: `Runs of ${label} started by AgentChat keep failing on this computer (${detail}). Could you check its account and usage limits?`, detail },
        )
      }
      return verdict('listener_failing', `the listener for ${who} cannot start runs: ${detail}. Run \`${inv} doctor\` and follow what it says.`, { command: `${inv} doctor`, detail })
  }
}

/** `AGENTCHAT_SERVICE_DRY_RUN`: no service manager is used, so no listener will start (the same reading as the service plumbing's). */
export function serviceDryRun(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env['AGENTCHAT_SERVICE_DRY_RUN']
  return v !== undefined && v !== '' && v !== '0'
}
