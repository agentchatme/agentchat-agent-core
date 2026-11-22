import * as readline from 'node:readline'
import { AgentChatClient, integration as kit, type SignupFlow, type Texts } from 'agentchatme'
import {
  DEFAULT_API_BASE,
  credentialsPath,
  envKeyConflict,
  readCredentials,
  resolveIdentity,
  writeCredentials,
  clearCredentials,
  readPending,
  writePending,
  clearPending,
  type PendingSignup,
} from './credentials.js'
import { clearOfferDeclined } from './state.js'
import { writeAnchor, removeAnchorAt, hasAnchorAt } from '../anchor/block.js'
import { describeIdentityBlock, identityBlockState, type AnchorLoadNote, type IdentityBlockState } from '../anchor/follow.js'
import { traySummary } from '../integration/tray.js'
import { loadTexts, readCachedTexts } from '../integration/texts.js'
import { identityLineOf } from '../skill/identity-line.js'
import { anchorLabelOf, type DoctorCheck, type HostProfile, type StatusContext, type Verdict } from './host-profile.js'
import { clientIdentityOf } from '../client-identity.js'
import {
  REPEATED_FAILED_CYCLES,
  describeCouldNotProcessCounts,
  describePausedConversations,
  failedCyclesInARow,
  formatIntegrationStatus,
  integrationStatusFresh,
  integrationStatusStaleFor,
  readIntegrationStatus,
  repeatedFailedRuns,
  runtimeCheckFailingNow,
} from '../integration/status.js'

// ─── Identity commands, for exactly one agent ───────────────────────────────
//
// Dual-mode by design: a human runs these in a terminal and gets prompts; a
// coding agent runs them with flags and gets deterministic, parseable output.
//
// Sign-up (register, recover) follows the server's answer. Every answer
// carries a flow object and a sentence written to be shown to a person
// (contract v1, "Sign-up flows"); the SDK's `integration.account` reads it
// into the next action. These commands show the sentence as it is and add
// the one thing the server cannot know: the command to run next, under this
// integration's name. No code, limit, rule or wording of the server's is
// kept here. With flags, a sign-up is one step per run: the code is
// requested in one run and entered in the next, with the server's flow kept
// in `pending.json` between them, so the agent can ask its user for the
// emailed code in between. On a terminal, a command that has to ask for its
// input anyway asks to the end (`integration.account.run`), so the person
// types the code where they are.
//
// These commands are shared rather than reimplemented per host. They lived
// in each integration once, and within a week the two copies were 94%
// identical and had already drifted.
//
// Every function acts on `profile.home()` — the caller's own agent. There is no
// host argument to get wrong, and no branch that could reach another agent's
// files. Every time the key changes (register, login, recover) the profile's
// `place` runs, so the hosted tool server always carries the current key.
//
// The identity line the anchor carries is the server's (`GET /v1/texts`,
// fetched for this agent just before placing; the identity-home cache when
// the server cannot be reached). No copy of it lives here. The same fetch
// says which manual is current; `place` and `doctor --fix` bring the skill
// file to it.

/** No served texts in hand: offline and nothing cached. */
const NO_TEXTS: StatusContext = Object.freeze({ identityLine: null, identityLineTemplate: null, manual: null })

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** What a command hands its host from one texts response. */
function contextOf(texts: Texts): StatusContext {
  return { identityLine: identityLineOf(texts), identityLineTemplate: texts.identity_line_template, manual: texts.manual }
}

/**
 * Ask one question on the TTY. Null when the input ends instead (Ctrl-D, or
 * Ctrl-C at the prompt).
 *
 * Deliberately the classic `node:readline`, not `node:readline/promises`:
 * esbuild strips the `node:` prefix from builtin imports when it bundles this
 * package, and a bare `readline/promises` is not on its builtin list.
 */
async function prompt(question: string): Promise<string | null> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await new Promise<string | null>((resolve) => {
      rl.once('close', () => resolve(null))
      rl.question(question, (answer) => resolve(answer.trim()))
    })
  } finally {
    rl.close()
  }
}

/** Both streams are a terminal: a person is there to answer questions. */
function interactive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true
}

/**
 * All of stdin, trimmed — for `login --api-key -`, so a key can be piped in
 * instead of typed into argv (where `ps` and shell history keep it).
 */
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
  return Buffer.concat(chunks).toString('utf-8').trim()
}

/** An SDK error in one line: its code and the server's message. */
function describeApiError(err: unknown): string {
  const e = (err ?? {}) as { code?: unknown; message?: unknown }
  const message = typeof e.message === 'string' ? e.message : String(err)
  return typeof e.code === 'string' ? `${e.code}: ${message}` : message
}

/** The HTTP status an SDK error carries (`AgentChatError.status`), or null for a transport failure. */
function httpStatusOf(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status
  return typeof status === 'number' && Number.isFinite(status) && status > 0 ? status : null
}

function recoverUsage(invocation: string): string {
  return `${invocation} recover --handle <handle> --email <email>`
}

// ─── Sign-up: what the commands keep between runs, and what they print ─────

type AccountKind = kit.AccountKind
type StepResult = kit.AccountStepResult

/** What a start call sends: what was typed, trimmed (the server judges it). */
interface SignupInput {
  email: string
  handle?: string
  display_name?: string
  description?: string
}

function emailInput(raw: string | undefined): string | undefined {
  const email = raw?.trim().toLowerCase()
  return email ? email : undefined
}

/** A handle as typed, with a leading `@` dropped. */
function handleInput(raw: string | undefined): string | undefined {
  const handle = raw?.trim().replace(/^@/, '').toLowerCase()
  return handle ? handle : undefined
}

/** The step that answers a pending code of each kind (`next_step` while the code is pending). */
const VERIFY_STEP: Readonly<Record<AccountKind, string>> = { register: 'verify', recover: 'recover_verify' }

/** A flag value as a shell takes it: bare when plain, else in double quotes. */
function shellValue(value: string): string {
  return /^[A-Za-z0-9@%+=:,./_-]+$/.test(value) ? value : JSON.stringify(value)
}

function receivedAtMs(pending: PendingSignup): number | null {
  const at = Date.parse(pending.received_at)
  return Number.isFinite(at) ? at : null
}

/**
 * Whether the code a pending record holds may still work: until
 * `expires_in_s` from its answer, else until `expires_at`. Unknown counts as
 * yes; the server says so when the code is gone.
 */
function codeMayWork(pending: PendingSignup, now = Date.now()): boolean {
  const received = receivedAtMs(pending)
  if (pending.flow.expires_in_s !== undefined && received !== null) return received + pending.flow.expires_in_s * 1000 > now
  if (pending.flow.expires_at !== undefined) {
    const at = Date.parse(pending.flow.expires_at)
    if (Number.isFinite(at)) return at > now
  }
  return true
}

/** Seconds left of the pending answer's `resend_after_s`: until a new code may be sent to that email (0: now). */
function resendLeftS(pending: PendingSignup | null, now = Date.now()): number {
  if (pending === null || pending.flow.resend_after_s === undefined) return 0
  const received = receivedAtMs(pending)
  if (received === null) return 0
  return Math.max(0, Math.ceil((pending.flow.resend_after_s * 1000 - (now - received)) / 1000))
}

/** "Run `cmd`", after a wait when there is one. */
function runLine(command: string, waitS = 0): string {
  return waitS > 0 ? `Wait ${waitS} s, then run \`${command}\`` : `Run \`${command}\``
}

/**
 * One question of `integration.account.run`, asked on the terminal. Its
 * labels are the SDK's; the choices around them ("new", y/N) are ours.
 */
async function askOnTerminal(question: kit.AccountQuestion): Promise<kit.AccountAnswer> {
  if (question.field === 'new_code') {
    const answer = await prompt('Send a new code? [y/N] ')
    return answer !== null && /^y(es)?$/i.test(answer) ? { answer: 'new_code' } : { answer: 'cancel' }
  }
  const choices =
    question.handles !== undefined && question.handles.length > 0 ? ` (${question.handles.map((h) => `@${h}`).join(', ')})` : ''
  const hint = question.field === 'code' ? ' (or "new" for a new code)' : ''
  const answer = await prompt(`${question.label ?? question.field}${choices}${hint}: `)
  if (answer === null) return { answer: 'cancel' }
  if (question.field === 'code') return answer.toLowerCase() === 'new' ? { answer: 'new_code' } : { answer: 'value', value: answer }
  return { answer: 'value', value: (question.field === 'handle' ? handleInput(answer) : emailInput(answer)) ?? '' }
}

const NEXT_HINT =
  'Open a new session for the hosted AgentChat tools to pick up the key; the integration daemon follows the credential on its own.'

export interface RegisterOpts {
  email?: string
  handle?: string
  displayName?: string
  description?: string
  /** The code from the verification email — the completion leg. */
  code?: string
  apiBase?: string
}

export interface RecoverOpts {
  /** The email the agent registered with. */
  email?: string
  /**
   * Which agent on that email to re-key. When omitted it defaults to this
   * agent's stored handle, then to a prompt on a TTY; without one the
   * server is asked by email alone, and names the handles to choose from
   * when the email backs several agents.
   */
  handle?: string
  /** The code from the recovery email — the completion leg. */
  code?: string
  apiBase?: string
}

export interface DoctorOpts {
  fix?: boolean
}

export interface IdentityCommands {
  runRegister(opts: RegisterOpts): Promise<number>
  runLogin(opts: { apiKey?: string; apiBase?: string }): Promise<number>
  runRecover(opts: RecoverOpts): Promise<number>
  runStatus(opts: { json?: boolean }): Promise<number>
  runLogout(): number
  runDoctor(opts?: DoctorOpts): Promise<number>
}

/** Build the identity command set for one coding agent. */
export function createIdentityCommands(profile: HostProfile): IdentityCommands {
  const invocation = (): string => profile.invocation()
  const LABEL = profile.label
  const clientIdentity = clientIdentityOf(profile.client)

  /**
   * The refusal when an exported `AGENTCHAT_API_KEY` is not the key this
   * home holds, with what to do; null when there is no such split. Nothing
   * that acts as this agent adopts the exported key: it would quietly make
   * every command, and every placement `doctor --fix` writes, another agent
   * (found in testing). The listener of `@agentchatme/cli` refuses the
   * same split.
   */
  function envKeyRefusal(): string | null {
    const conflict = envKeyConflict(profile.home())
    if (conflict === null) return null
    return `${conflict}. Unset AGENTCHAT_API_KEY, or, to sign this home in with that key on purpose: printenv AGENTCHAT_API_KEY | ${invocation()} login --api-key -`
  }

  /**
   * One attempt, 5 s — for `status`, `doctor` and the texts fetch, which must
   * answer in seconds on a black-holed network (the SDK's default ramp is 4
   * attempts of up to 15 s).
   */
  const apiClient = (apiKey: string, apiBase: string): AgentChatClient =>
    new AgentChatClient({ apiKey, baseUrl: apiBase, clientIdentity, timeoutMs: 5_000, retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } })

  /** How the sign-up calls reach the server (never retried: a second call could send a second code). */
  const accountOptions = (apiBase: string): kit.AccountCallOptions => ({ clientIdentity, apiBase, timeoutMs: 15_000 })

  /**
   * The served texts for this agent: fetched now (one attempt, 5 s), else the
   * cached ones, else null (offline and never fetched). Fetched ONCE per
   * command: the identity line and the announced manual are handed to the
   * host's `place`, `extraStatus` and `extraDoctorChecks`, which must not
   * fetch again. The CLI never writes an identity line it did not get from
   * the server.
   */
  async function served(apiKey: string, apiBase: string): Promise<StatusContext> {
    const loaded = await loadTexts({ home: profile.home(), runtime: profile.client.runtime, client: apiClient(apiKey, apiBase), timeoutMs: 5_000 })
    return loaded === null ? NO_TEXTS : contextOf(loaded.texts)
  }

  /** The host's extra `status` lines, with the texts already fetched. */
  async function printExtraStatus(context: StatusContext): Promise<void> {
    if (profile.extraStatus === undefined) return
    try {
      for (const line of await profile.extraStatus(context)) console.log(line)
    } catch (err) {
      console.log(`  (host status failed: ${err instanceof Error ? err.message : String(err)})`)
    }
  }

  /**
   * Place the integration for THIS agent's new key: the identity line, the
   * manual, the hosted tool server with the key. A profile without `place`
   * gets the anchor alone (the identity line in its instruction file).
   */
  async function placeIdentity(handle: string, apiKey: string, apiBase: string): Promise<string[]> {
    const { identityLine, manual } = await served(apiKey, apiBase)
    if (profile.place !== undefined) {
      try {
        return await profile.place(handle, apiKey, identityLine, manual)
      } catch (err) {
        return [`  placement FAILED — ${String(err)}; repair with \`${invocation()} doctor --fix\``]
      }
    }
    return writeOurAnchor(handle, identityLine)
  }

  /** Write THIS agent's anchor. Only ever touches `profile.anchorFile()`. */
  function writeOurAnchor(handle: string, identityLine: string | null): string[] {
    if (profile.anchorFile === undefined) return []
    const file = profile.anchorFile()
    const label = anchorLabelOf(profile)
    // A host that wires itself separately must not be handed an identity block
    // before that wiring exists — it would announce a handle with nothing
    // listening. Once an anchor is already there, keep it current regardless.
    try {
      if (profile.isWired !== undefined && !profile.isWired() && !hasAnchorAt(file)) return []
      if (identityLine === null) {
        return [
          `  ${label}: identity line not written — GET /v1/texts could not be reached and nothing is cached; run \`${invocation()} doctor --fix\` once online`,
        ]
      }
      writeAnchor(file, profile.renderAnchor(identityLine, handle), handle)
      return [`  ${label}: @${handle} → ${file}`]
    } catch (err) {
      return [`  ${label}: FAILED — ${String(err)}`]
    }
  }

  // ─── Sign-up ──────────────────────────────────────────────────────────────

  /** The command that starts `kind` again, sending `input`; `blank` leaves that field for the person to fill in. */
  function startCommand(kind: AccountKind, input: SignupInput, blank?: 'email' | 'handle'): string {
    const email = blank === 'email' ? '<email>' : shellValue(input.email)
    const handle = blank === 'handle' ? '<handle>' : input.handle !== undefined ? shellValue(input.handle) : null
    if (kind === 'recover') return `${invocation()} recover${handle !== null ? ` --handle ${handle}` : ''} --email ${email}`
    return [
      `${invocation()} register --email ${email} --handle ${handle ?? '<handle>'}`,
      ...(input.display_name !== undefined ? [`--display-name ${shellValue(input.display_name)}`] : []),
      ...(input.description !== undefined ? [`--description ${shellValue(input.description)}`] : []),
    ].join(' ')
  }

  /** The command that answers a pending code: with `code`, or a placeholder of the server's `code_length`. */
  function codeCommand(kind: AccountKind, flow: SignupFlow, code?: string): string {
    const value = code !== undefined ? shellValue(code) : flow.code_length !== undefined ? `<${flow.code_length} digits>` : '<code>'
    return `${invocation()} ${kind} --code ${value}`
  }

  /**
   * What to run next, from the action the SDK read from the server's answer
   * (`actionOf` with the step called). The server's sentence says what
   * happened; this is the one thing it cannot say: the command, under this
   * integration's name. `held` is the pending code this agent holds for the
   * same email, if any.
   */
  function nextSteps(
    kind: AccountKind,
    result: StepResult,
    called: 'start' | 'verify',
    input: SignupInput,
    code: string | undefined,
    held: PendingSignup | null,
  ): string[] {
    // A new code is sent only once the server's wait and the email's resend
    // window are over: the window as this answer states it, else what is
    // left of the one the held code's answer stated.
    const beforeNewCode = Math.max(result.flow.retry_after_s ?? 0, result.flow.resend_after_s ?? resendLeftS(held))
    // A start turned away (429) while the code already sent still works: go
    // back to that code (contract v1, "Sign-up flows").
    const heldCode =
      called === 'start' && result.httpStatus === 429 && held !== null && held.handle === input.handle && codeMayWork(held)
        ? [`Or enter the code already sent: \`${codeCommand(kind, held.flow)}\``]
        : []
    switch (result.action) {
      case 'done':
        return []
      case 'ask_code':
        return [runLine(codeCommand(kind, result.flow))]
      case 'ask_param': {
        const param = result.flow.param
        const field = param === 'email' ? 'email' : param === 'handle' ? 'handle' : null
        if (field === null) return []
        const handles = field === 'handle' ? (result.handles ?? []) : []
        const choices = handles.length > 0 ? `, with one of: ${handles.map((h) => `@${h}`).join(', ')}` : ''
        return [`${runLine(startCommand(kind, input, field), beforeNewCode)}${choices}`]
      }
      case 'offer_new_code':
        return [`For a new code: ${runLine(startCommand(kind, input), beforeNewCode)}`]
      case 'wait_then_retry': {
        const again = called === 'verify' ? codeCommand(kind, result.flow, code) : startCommand(kind, input)
        return [runLine(again, result.flow.retry_after_s ?? 0), ...heldCode]
      }
      case 'stop':
        return heldCode
    }
  }

  /**
   * The server's sentence (its code when it sent none), then the next
   * command: on stdout when the step did what it was asked, else on stderr.
   */
  function report(result: StepResult, lines: string[], ok: boolean): number {
    const said = result.message.length > 0 ? result.message : (result.code ?? `HTTP ${result.httpStatus}`)
    const text = [said, ...lines].join('\n')
    if (ok) console.log(text)
    else console.error(text)
    return ok ? 0 : 1
  }

  /**
   * The key is the server's: save it with the handle the server returned
   * (never the one typed), place the integration for it, say where it is.
   * `message` is the server's sentence, or null when it has been shown.
   */
  async function finishSignup(kind: AccountKind, apiKey: string, handle: string, apiBase: string, message: string | null): Promise<number> {
    const home = profile.home()
    writeCredentials(home, {
      api_key: apiKey,
      handle,
      ...(apiBase !== DEFAULT_API_BASE ? { api_base: apiBase } : {}),
      created_at: new Date().toISOString(),
    })
    clearPending(home)
    // They have an identity now, so a previous "not now" is spent. If they
    // ever sign out, the setup offer should be free to appear again.
    clearOfferDeclined(home)
    const placed = await placeIdentity(handle, apiKey, apiBase)
    const lines =
      kind === 'register'
        ? [
            `API key for @${handle} stored at ${credentialsPath(home)} (never commit this file).`,
            ...placed,
            '',
            `This handle belongs to your ${LABEL} agent. Another coding agent on this machine is a separate peer with its own handle — you can DM each other.`,
            `Other agents can DM you at @${handle}. Check \`${invocation()} status\` any time.`,
            NEXT_HINT,
          ]
        : [`New API key for @${handle} stored at ${credentialsPath(home)} (never commit this file).`, ...placed, NEXT_HINT]
    console.log([...(message !== null && message.length > 0 ? [message] : []), ...lines].join('\n'))
    return 0
  }

  /** Ask for a code: one start call. The flow is kept only when the server sent a code. */
  async function startSignup(kind: AccountKind, input: SignupInput, apiBase: string): Promise<number> {
    const home = profile.home()
    const before = readPending(home)
    const held = before !== null && before.kind === kind && before.email === input.email ? before : null
    let result: StepResult
    try {
      result =
        kind === 'register'
          ? await kit.account.start(
              'register',
              {
                email: input.email,
                handle: input.handle ?? '',
                ...(input.display_name !== undefined ? { display_name: input.display_name } : {}),
                ...(input.description !== undefined ? { description: input.description } : {}),
              },
              accountOptions(apiBase),
            )
          : await kit.account.start(
              'recover',
              { email: input.email, ...(input.handle !== undefined ? { handle: input.handle } : {}) },
              accountOptions(apiBase),
            )
    } catch (err) {
      console.error(`Could not reach AgentChat: ${errorText(err)}\n${runLine(startCommand(kind, input))} again.`)
      return 1
    }
    if (result.action === 'ask_code') {
      writePending(home, {
        kind,
        flow: result.flow,
        received_at: new Date().toISOString(),
        ...input,
        ...(apiBase !== DEFAULT_API_BASE ? { api_base: apiBase } : {}),
      })
    }
    return report(result, nextSteps(kind, result, 'start', input, undefined, held), result.action === 'ask_code')
  }

  /** Answer the pending code: one verify call, then keep, refresh or drop the flow as the answer says. */
  async function submitPendingCode(kind: AccountKind, rawCode: string, apiBase: string): Promise<number> {
    const home = profile.home()
    const code = rawCode.trim()
    const pending = readPending(home)
    const noun = kind === 'register' ? 'registration' : 'recovery'
    if (pending === null) {
      console.error(
        `No ${noun} in progress. Start with: ${kind === 'register' ? `${invocation()} register --email <email> --handle <handle>` : recoverUsage(invocation())}`,
      )
      return 1
    }
    if (pending.kind !== kind) {
      console.error(
        pending.kind === 'recover'
          ? `The pending code belongs to an account RECOVERY — complete it with: ${invocation()} recover --code ${shellValue(code)}`
          : `The pending code belongs to a REGISTRATION — complete it with: ${invocation()} register --code ${shellValue(code)}`,
      )
      return 1
    }
    if (pending.flow.next_step !== VERIFY_STEP[kind] || pending.flow.pending_id === undefined) {
      clearPending(home)
      console.error(`The saved ${noun} is not waiting for a code. Start again with: ${startCommand(kind, pending)}`)
      return 1
    }
    const base = pending.api_base ?? apiBase
    let result: StepResult
    try {
      result = await kit.account.submitCode(pending.flow, code, accountOptions(base))
    } catch (err) {
      console.error(`Could not reach AgentChat: ${errorText(err)}\n${runLine(codeCommand(kind, pending.flow, code))} again.`)
      return 1
    }
    switch (result.action) {
      case 'done':
        return finishSignup(kind, result.apiKey!, result.handle!, base, result.message)
      case 'ask_code':
        // A wrong code, or one in the wrong form: the same pending id, asked again.
        writePending(home, { ...pending, flow: result.flow, received_at: new Date().toISOString() })
        break
      case 'offer_new_code':
      case 'ask_param':
        // The code is gone (expired, too many wrong tries, used up): only a new start can go on.
        clearPending(home)
        break
      default:
        // wait_then_retry: the code was not checked, and stays. stop: it stays
        // too, until an answer says it is gone (a 5xx after the code may have
        // created the account: never steer to a second start).
        break
    }
    return report(result, nextSteps(kind, result, 'verify', pending, code, pending), false)
  }

  /**
   * The whole sign-up on a terminal, for a person who left out what the
   * command needs: `integration.account.run` asks for each field the server
   * names, the code, and whether to send a new one; shows every server
   * sentence; and sits out the server's short waits. Nothing is kept between
   * runs: an interrupted conversation starts again.
   */
  async function converse(kind: AccountKind, input: Partial<SignupInput>, apiBase: string): Promise<number> {
    let outcome: kit.AccountRunResult
    try {
      outcome = await kit.account.run({
        kind,
        input,
        ...accountOptions(apiBase),
        show: (message) => console.log(message),
        ask: askOnTerminal,
      })
    } catch (err) {
      console.error(`Could not reach AgentChat: ${errorText(err)}`)
      return 1
    }
    if (outcome.outcome === 'done') return finishSignup(kind, outcome.apiKey, outcome.handle, apiBase, null)
    if (outcome.outcome === 'cancelled') console.error('Cancelled.')
    return 1
  }

  async function runRegister(opts: RegisterOpts): Promise<number> {
    const home = profile.home()
    const apiBase = opts.apiBase ?? process.env['AGENTCHAT_API_BASE'] ?? DEFAULT_API_BASE

    if (opts.code !== undefined) return submitPendingCode('register', opts.code, apiBase)

    // The gate is about THIS agent only — another coding agent having an
    // identity is irrelevant and must never block this one.
    if (resolveIdentity(home) !== null) {
      console.error(
        `${LABEL} already has an AgentChat identity (see \`${invocation()} status\`). Run \`${invocation()} logout\` first to replace it.`,
      )
      return 1
    }
    if (readPending(home)?.kind === 'recover') {
      console.error(
        `An account recovery is in progress — finish it with \`${invocation()} recover --code <code>\`, or discard it with \`${invocation()} logout\` before registering.`,
      )
      return 1
    }

    const email = emailInput(opts.email)
    const handle = handleInput(opts.handle)
    const extras = {
      ...(opts.displayName ? { display_name: opts.displayName } : {}),
      ...(opts.description ? { description: opts.description } : {}),
    }
    if (email === undefined || handle === undefined) {
      if (interactive()) {
        return converse('register', { ...(email !== undefined ? { email } : {}), ...(handle !== undefined ? { handle } : {}), ...extras }, apiBase)
      }
      console.error(`Missing --${email === undefined ? 'email' : 'handle'}. Usage: ${invocation()} register --email <email> --handle <handle>`)
      return 1
    }
    return startSignup('register', { email, handle, ...extras }, apiBase)
  }

  async function runLogin(opts: { apiKey?: string; apiBase?: string }): Promise<number> {
    const home = profile.home()
    const apiBase = opts.apiBase ?? process.env['AGENTCHAT_API_BASE'] ?? DEFAULT_API_BASE
    let apiKey = opts.apiKey?.trim()

    // Where the key comes from, most explicit first. A key is never asked for
    // as an argument: argv is visible in `ps` to every user of the machine and
    // kept in shell history. It is piped in (`--api-key -`), typed at the
    // prompt, or taken from AGENTCHAT_API_KEY when this home holds no other
    // key. `--api-key <key>` keeps working for scripts that pass one, and the
    // output says where the key was seen.
    const onArgv = apiKey !== undefined && apiKey.length > 0 && apiKey !== '-'
    if (apiKey === '-') {
      apiKey = await readAllStdin()
    } else if (!apiKey) {
      const fromEnv = process.env['AGENTCHAT_API_KEY']?.trim()
      const refusal = fromEnv ? envKeyRefusal() : null
      if (refusal !== null) {
        console.error(`${refusal}\nlogin does not adopt an exported key in place of the one this home holds; nothing was saved.`)
        return 1
      }
      if (fromEnv) {
        apiKey = fromEnv
        console.log('Using the key from AGENTCHAT_API_KEY.')
      } else if (process.stdin.isTTY !== true) {
        console.error(
          `Missing API key. Run \`${invocation()} login\` in a terminal and paste the key when it asks, or pipe it in from a file: \`${invocation()} login --api-key - < key.txt\`. Never put the key itself on a command line: \`ps\` and shell history can see it there.`,
        )
        return 1
      } else {
        apiKey = (await prompt('AgentChat API key (ac_…): ')) ?? ''
      }
    }
    if (!apiKey) {
      console.error('No API key given; nothing was saved.')
      return 1
    }

    // The server judges the key; a key it does not accept is never saved.
    let check: kit.CheckKeyResult
    try {
      check = await kit.account.checkKey(apiKey, accountOptions(apiBase))
    } catch (err) {
      console.error(`Login failed: ${errorText(err)}\nThe key was not saved.`)
      return 1
    }
    if (!check.ok) {
      console.error(`Login failed. ${check.code}: ${check.message}\nThe key was not saved.`)
      return 1
    }
    writeCredentials(home, {
      api_key: apiKey,
      handle: check.handle,
      ...(apiBase !== DEFAULT_API_BASE ? { api_base: apiBase } : {}),
      created_at: new Date().toISOString(),
    })
    clearOfferDeclined(home)
    console.log(
      [
        `Signed in as @${check.handle} for ${LABEL}.`,
        `API key stored at ${credentialsPath(home)} (never commit this file).`,
        ...(await placeIdentity(check.handle, apiKey, apiBase)),
        NEXT_HINT,
        ...(onArgv
          ? [
              `Note: the key was on this command line, where \`ps\` and shell history can see it. Next time run \`${invocation()} login\` and paste it, or pipe it in: \`${invocation()} login --api-key - < key.txt\`.`,
            ]
          : []),
      ].join('\n'),
    )
    return 0
  }

  // Recovery re-keys ONE agent. One email can back several agents, so the
  // handle rides along whenever it is known (this agent's stored one by
  // default); asked by email alone, the server answers an email that backs
  // several agents after the code, with the handles to choose from.
  async function runRecover(opts: RecoverOpts): Promise<number> {
    const home = profile.home()
    const apiBase = opts.apiBase ?? process.env['AGENTCHAT_API_BASE'] ?? DEFAULT_API_BASE

    if (opts.code !== undefined) return submitPendingCode('recover', opts.code, apiBase)

    let handle = handleInput(opts.handle)
    if (handle === undefined) {
      const stored = readCredentials(home)?.handle
      if (stored !== undefined) {
        handle = stored
        console.log(`Recovering @${stored} — this agent's stored handle (pass --handle to recover a different agent).`)
      }
    }
    const email = emailInput(opts.email)
    if (email === undefined) {
      if (!interactive()) {
        console.error(`Missing --email. Usage: ${recoverUsage(invocation())}`)
        return 1
      }
      if (handle === undefined) handle = handleInput((await prompt('Handle of the agent to recover: ')) ?? undefined)
      return converse('recover', handle !== undefined ? { handle } : {}, apiBase)
    }
    return startSignup('recover', { email, ...(handle !== undefined ? { handle } : {}) }, apiBase)
  }

  /** The host's note on the file its runtime loads instead of the instruction file (`anchorLoadNote`), judged against the texts in hand, or null; a host check that throws reads as none. */
  function loadNoteFor(handle: string, texts: StatusContext): AnchorLoadNote | null {
    try {
      return profile.anchorLoadNote?.(handle, { identityLine: texts.identityLine, template: texts.identityLineTemplate }) ?? null
    } catch {
      return null
    }
  }

  /**
   * The instruction file's block, read the way the daemon reads it
   * (`identityBlockState`): one verdict for `status`, `doctor` and the
   * daemon's follow. A file that exists but cannot be read (permissions, a
   * symlink loop, not UTF-8) is said as such — it is neither "missing" nor a
   * reason for status to print nothing.
   */
  function anchorView(
    file: string | null,
    texts: StatusContext,
    handle: string | null,
  ): { present: boolean | null; current: boolean | null; error: string | null; state: IdentityBlockState | null } {
    if (file === null) return { present: null, current: null, error: null, state: null }
    if (handle === null) {
      try {
        return { present: hasAnchorAt(file), current: null, error: null, state: null }
      } catch (err) {
        return { present: null, current: null, error: errorText(err), state: null }
      }
    }
    const state = identityBlockState(file, { handle, identityLine: texts.identityLine, template: texts.identityLineTemplate, loadNote: loadNoteFor(handle, texts) })
    if (state.state === 'unreadable') return { present: null, current: null, error: state.what.replace(/^cannot read [^:]*: /, ''), state }
    return {
      present: state.state !== 'missing',
      current: texts.identityLine === null ? null : state.state === 'current',
      error: null,
      state,
    }
  }

  /** The status header's words for the block: `current` when it is the served one (with the note on the file the runtime loads, if any), else the reading's one sentence. */
  function anchorWords(file: string, view: ReturnType<typeof anchorView>): string {
    if (view.error !== null) return `unreadable — ${view.error} (${file})`
    const state = view.state
    if (state === null) return `${view.present ? 'present' : 'missing'} (${file})`
    if (state.verdict === 'PASS') return `current (${file})${state.loadNote !== null ? `; ${state.loadNote.note}` : ''}`
    return describeIdentityBlock(state, `${invocation()} doctor --fix`)
  }

  async function runStatus(opts: { json?: boolean }): Promise<number> {
    const home = profile.home()
    const anchorFile = profile.anchorFile?.() ?? null
    // A split identity is said before anything else, and nothing is asked of
    // the server with either key: status names one agent or none.
    const refusal = envKeyRefusal()
    if (refusal !== null) {
      if (opts.json) console.log(JSON.stringify({ configured: true, host: profile.id, error: { kind: 'env_key_conflict', detail: refusal }, home }))
      else console.error(refusal)
      return 1
    }
    const identity = resolveIdentity(home)
    const pending = readPending(home)
    const integration = readIntegrationStatus(home)

    if (identity === null) {
      if (opts.json) {
        console.log(
          JSON.stringify({
            configured: false,
            host: profile.id,
            pending: pending !== null,
            pending_kind: pending?.kind ?? null,
            integration,
          }),
        )
      } else if (pending !== null) {
        const what =
          pending.kind === 'recover'
            ? `an account recovery${pending.handle !== undefined ? ` for @${pending.handle}` : ''}`
            : `a registration for @${pending.handle ?? '?'}`
        console.log(
          codeMayWork(pending)
            ? `No identity yet, but ${what} is waiting on its emailed code — finish with: ${codeCommand(pending.kind, pending.flow)}`
            : `No identity yet; the code for ${what} has expired — for a new one, run: ${startCommand(pending.kind, pending)}`,
        )
      } else {
        console.log(`No AgentChat identity for this ${LABEL} agent. Set one up with: ${invocation()} register`)
      }
      return 0
    }

    let me: Awaited<ReturnType<AgentChatClient['getMe']>>
    const client = apiClient(identity.apiKey, identity.apiBase)
    try {
      me = await client.getMe()
    } catch (err) {
      // A refused key is not an unreachable server, and neither hides the
      // integration: its socket state and last error (`blocked`, `auth
      // rejected (close 1008 …)`) are exactly what explains the failure.
      const status = httpStatusOf(err)
      const refused = status === 401 || status === 403
      const detail = describeApiError(err)
      if (opts.json) {
        const offline = anchorView(anchorFile, NO_TEXTS, null)
        console.log(
          JSON.stringify({
            configured: true,
            host: profile.id,
            handle: identity.handle,
            error: { kind: refused ? 'key_refused' : 'unreachable', status, detail },
            key_source: identity.source,
            api_base: identity.apiBase,
            home,
            anchor: offline.present,
            anchor_error: offline.error,
            integration,
          }),
        )
      } else {
        console.error(
          refused
            ? `AgentChat refused this agent's key (${detail}). Sign in with a current key: \`${invocation()} login\`; lost it? \`${recoverUsage(invocation())}\`.`
            : `Could not reach AgentChat: ${detail}`,
        )
        // The server did not answer, so no texts fetch either: the block and the
        // host's checks are read against the identity-home cache (what a fetch
        // would have fallen back to), or without texts when nothing is cached.
        const cached = readCachedTexts(home, profile.client.runtime)
        const context = cached === null ? NO_TEXTS : contextOf(cached.texts)
        console.log(
          [
            `${identity.handle !== null ? `@${identity.handle}` : 'This agent'} — ${refused ? `key refused (HTTP ${status})` : 'AgentChat unreachable'}  (${LABEL})`,
            `Key source: ${identity.source} (${identity.source === 'file' ? credentialsPath(home) : 'AGENTCHAT_API_KEY'})`,
            `API: ${identity.apiBase}`,
            ...(anchorFile === null ? [] : [`Identity line: ${anchorWords(anchorFile, anchorView(anchorFile, context, identity.handle))}`]),
            ...formatIntegrationStatus(integration),
          ].join('\n'),
        )
        await printExtraStatus(context)
      }
      return 1
    }

    const tray = await traySummary(client).catch(() => null)
    const texts = await served(identity.apiKey, identity.apiBase)
    const anchor = anchorView(anchorFile, texts, me.handle)

    if (opts.json) {
      console.log(
        JSON.stringify({
          configured: true,
          host: profile.id,
          handle: me.handle,
          status: me.status ?? 'unknown',
          tray,
          key_source: identity.source,
          api_base: identity.apiBase,
          home,
          anchor: anchor.present,
          /** null: the served texts were unavailable (or there is no instruction file, or it cannot be read), so currency could not be checked. */
          anchor_current: anchor.current,
          /** Why the instruction file could not be read, or null. */
          anchor_error: anchor.error,
          /** The block as the daemon reads it (`identityBlockState`: current, stale, missing, setup_offer, hand_edited, other_agent, several_blocks, unreadable), or null. */
          anchor_state: anchor.state?.state ?? null,
          /** Why the runtime does not load the instruction file now, or null. */
          anchor_not_loaded: anchor.state?.notLoaded ?? null,
          integration,
        }),
      )
    } else {
      const trayLine =
        tray === null
          ? 'Tray: could not be read'
          : `Tray: ${tray.waiting}${tray.truncated ? '+' : ''} conversation(s) waiting${tray.deferred > 0 ? `, ${tray.deferred} deferred` : ''}`
      console.log(
        [
          `@${me.handle} — ${me.status ?? 'active'}  (${LABEL})`,
          trayLine,
          `Key source: ${identity.source} (${identity.source === 'file' ? credentialsPath(home) : 'AGENTCHAT_API_KEY'})`,
          `API: ${identity.apiBase}`,
          ...(anchorFile === null
            ? []
            : [
                `Identity line: ${anchorWords(anchorFile, anchor)}`,
              ]),
          ...formatIntegrationStatus(integration),
        ].join('\n'),
      )
      await printExtraStatus(texts)
    }
    return 0
  }

  /**
   * Sign out THIS agent. Authentication and integration installation are
   * separate lifecycles: logout must never silently remove the service or the
   * manual. It removes what authenticates as the old identity: the credential,
   * the identity line, and the key the hosted tool server was registered with.
   */
  function runLogout(): number {
    const home = profile.home()
    const anchorFile = profile.anchorFile?.() ?? null
    const reports: string[] = []
    let any = false

    // Read BEFORE clearing: `unplace` recognises the host's own registration
    // by the key and the API base that were placed, and both are gone from
    // disk once the credential is deleted.
    const identity = resolveIdentity(home)

    if (clearCredentials(home)) {
      any = true
      reports.push('  credentials deleted')
    }
    if (anchorFile !== null) {
      // A file that cannot be rewritten must not stop the sign-out half-way:
      // `unplace` below still has to take the old key out of the host.
      try {
        // Only what AgentChat placed for this agent goes: its own block (by the
        // kit's strict reading, with the kept texts when there are any) or the
        // setup offer. A block edited by hand, or another agent's, is left.
        const cached = readCachedTexts(home, profile.client.runtime)
        const removed = removeAnchorAt(anchorFile, {
          handle: identity?.handle ?? null,
          identityLine: cached?.texts.identity_line ?? null,
          template: cached?.texts.identity_line_template ?? null,
        })
        if (removed.action === 'removed') {
          any = true
          reports.push(`  ${anchorLabelOf(profile)} identity line removed`)
        } else if (removed.action === 'kept') {
          any = true
          reports.push(`  ${removed.detail}`)
        }
      } catch (err) {
        any = true
        reports.push(`  could not remove the identity line from ${anchorFile}: ${errorText(err)} — remove the agentchat block by hand`)
      }
    }
    if (profile.unplace !== undefined) {
      try {
        const lines = profile.unplace(identity)
        if (lines.length > 0) any = true
        reports.push(...lines)
      } catch (err) {
        reports.push(`  could not undo placement: ${String(err)}`)
      }
    }

    console.log(
      [
        any ? `Signed out of ${LABEL}.` : 'Nothing to sign out of.',
        ...reports,
        ...(any
          ? [
              'Any other coding agent on this machine is untouched — it is a separate AgentChat agent with its own handle.',
              ...(profile.logoutHints?.() ?? []),
            ]
          : []),
      ].join('\n'),
    )
    return 0
  }

  /** The block as the daemon reads it (`identityBlockState`), for this agent. */
  function readIdentityLine(anchorFile: string, handle: string, texts: StatusContext): IdentityBlockState {
    return identityBlockState(anchorFile, { handle, identityLine: texts.identityLine, template: texts.identityLineTemplate, loadNote: loadNoteFor(handle, texts) })
  }

  /**
   * The doctor's identity-line check (and its `--fix`), for a host that has
   * an instruction file: the same reading `status` and the daemon use, so the
   * three say one thing. `--fix` places the served block over whatever block
   * is there (the user asked for it), but never writes a file the runtime
   * reads in the instruction file's place: a block it does not load stays a
   * WARN, with what to do.
   */
  async function identityLineCheck(
    anchorFile: string,
    creds: { handle: string; api_key: string },
    apiBase: string,
    texts: StatusContext,
    fix: boolean,
  ): Promise<DoctorCheck> {
    const fixCommand = `${invocation()} doctor --fix`
    const before = readIdentityLine(anchorFile, creds.handle, texts)
    if (before.state === 'unreadable') return { name: 'identity-line', verdict: 'FAIL', detail: before.what }
    // The served block in place: nothing to repair here (a runtime that does not load the file is said, not written around).
    const inPlace = before.state === 'current'
    if (fix && !inPlace) {
      const report = await placeIdentity(creds.handle, creds.api_key, apiBase)
      const failed = report.some((l) => l.includes('FAILED') || l.includes('not written'))
      if (failed) return { name: 'identity-line', verdict: 'FAIL', detail: `could not repair: ${report.join('; ')}` }
      // Said repaired only when the file now reads as repaired.
      const after = readIdentityLine(anchorFile, creds.handle, texts)
      if (after.state === 'current') {
        return { name: 'identity-line', verdict: after.verdict, detail: after.loadNote === null ? `repaired → @${creds.handle}` : `repaired → @${creds.handle} in ${anchorFile}; ${after.loadNote.note}` }
      }
      if (after.state === 'unreadable') return { name: 'identity-line', verdict: 'FAIL', detail: `${after.what} (after the repair)` }
      return { name: 'identity-line', verdict: 'FAIL', detail: `repair did not take: ${after.what}${report.length > 0 ? ` (${report.join('; ').trim()})` : ''}` }
    }
    return { name: 'identity-line', verdict: before.verdict, detail: describeIdentityBlock(before, fixCommand) }
  }

  async function runDoctor(opts: DoctorOpts = {}): Promise<number> {
    const home = profile.home()
    const anchorFile = profile.anchorFile?.() ?? null
    const checks: DoctorCheck[] = []
    let texts: StatusContext = NO_TEXTS

    checks.push({ name: 'node', verdict: 'PASS', detail: process.version })
    checks.push({ name: 'home', verdict: 'PASS', detail: home })
    // Every check below, and every repair `--fix` makes, uses the home's key.
    const refusal = envKeyRefusal()
    if (refusal !== null) checks.push({ name: 'env-key', verdict: 'FAIL', detail: refusal })

    const creds = readCredentials(home)
    if (creds === null) {
      checks.push({
        name: 'credentials',
        verdict: 'FAIL',
        detail: `no identity at ${credentialsPath(home)} — run \`${invocation()} register\``,
      })
    } else {
      checks.push({ name: 'credentials', verdict: 'PASS', detail: `@${creds.handle}` })
      const identity = resolveIdentity(home)
      if (identity !== null) {
        try {
          const client = apiClient(identity.apiKey, identity.apiBase)
          const started = Date.now()
          const me = await client.getMe()
          const verdict: Verdict = (me.status ?? 'active') === 'active' ? 'PASS' : 'WARN'
          checks.push({
            name: 'api-auth',
            verdict,
            detail: `@${me.handle} status=${me.status ?? 'active'} (${Date.now() - started}ms)`,
          })
          if (me.handle !== creds.handle) {
            checks.push({
              name: 'handle-drift',
              verdict: 'WARN',
              detail: `credentials say @${creds.handle} but the key authenticates as @${me.handle} — re-run \`${invocation()} login\``,
            })
          }
        } catch (err) {
          checks.push({ name: 'api-auth', verdict: 'FAIL', detail: `getMe failed: ${String(err)}` })
        }
      }

      // The identity line must name THIS agent, in the text the server serves
      // today. Releases of the old shared CLI wrote the anchor for every host
      // on the machine whenever any one registered, so a two-agent box could
      // end up with an instruction file announcing the OTHER agent's handle.
      const apiBase = identity?.apiBase ?? creds.api_base ?? DEFAULT_API_BASE
      texts = await served(creds.api_key, apiBase)
      checks.push(
        texts.identityLine === null
          ? { name: 'texts', verdict: 'WARN', detail: 'GET /v1/texts could not be reached and nothing is cached — the identity line cannot be checked or placed until it can' }
          : { name: 'texts', verdict: 'PASS', detail: 'served texts in hand' },
      )
      if (anchorFile !== null) checks.push(await identityLineCheck(anchorFile, creds, apiBase, texts, opts.fix === true))
    }

    // The receive loop's own record: repeated cycles that did not get done
    // (a runtime that fails, texts that never arrive, a cycle abandoned by
    // its watchdog) are a pattern to fix, even while the socket looks fine.
    const integration = readIntegrationStatus(home)
    // Runs failing for a runtime reason, as the daemon's own recheck found
    // (signed out, the binary gone, a flag an upgrade dropped).
    const runsFailing = integration?.runs_failing ?? null
    const gaveUp = integration?.unservable ?? null
    if (gaveUp !== null) {
      checks.push({
        name: 'runs',
        verdict: 'FAIL',
        detail:
          gaveUp.reason === 'key_refused'
            ? `this home gave the agent up: the server refuses its key (${gaveUp.detail}); it looks again at ${gaveUp.retry_at} (every 5 min) and takes the agent back whenever no other listener holds it, but only a key the server accepts can serve — sign in again here (login/recover; that clears this at once), or log out if another home serves the agent`
            : `this home gave the agent up: ${gaveUp.detail} (since ${gaveUp.since}); its runtime is checked again at ${gaveUp.retry_at} (every 60 s) and a check that passes clears this; it takes the agent back whenever no other listener holds it`,
      })
    } else if (runsFailing !== null) {
      checks.push({
        name: 'runs',
        verdict: 'FAIL',
        detail: `runs failing: ${runsFailing.reason} — since ${runsFailing.since}, ${runsFailing.runs_missed} run(s) missed (checked ${runsFailing.checked_at}); fix that, and the next run that succeeds clears this`,
      })
    }
    // Another daemon serves this agent from another identity home.
    const standby = integration?.standby ?? null
    if (standby !== null) {
      checks.push({
        name: 'single-listener',
        verdict: 'WARN',
        detail: `another listener serves this agent: ${standby.home ?? 'another identity home'}${standby.pid !== null ? ` (pid ${standby.pid})` : ''}; this one stands by (no socket, no run) so no message is answered twice`,
      })
    }
    const cycles = integration?.recent_cycles ?? []
    if (cycles.length > 0) {
      const failing = failedCyclesInARow(integration)
      const last = cycles[cycles.length - 1]!
      checks.push(
        failing !== null && failing.count >= REPEATED_FAILED_CYCLES
          ? {
              name: 'wake-cycles',
              verdict: 'WARN',
              detail: `the last ${failing.count} wake cycles did not get done (latest: ${failing.latest.outcome}${failing.latest.failure ? ` — ${failing.latest.failure}` : ''}); the cards stay on the tray`,
            }
          : { name: 'wake-cycles', verdict: 'PASS', detail: `last cycle ${last.outcome} at ${last.at} (${cycles.length} recent)` },
      )
    }
    // With conversation runs a cycle only starts runs: runs that keep failing
    // with no runtime reason found are said here.
    const failedRuns = repeatedFailedRuns(integration)
    if (failedRuns !== null) {
      const lastRun = integration?.last_run ?? null
      checks.push({
        name: 'runs',
        verdict: 'WARN',
        detail: `the last ${failedRuns} runs did not get done${lastRun !== null ? ` (latest: ${lastRun.state}${lastRun.detail ? ` — ${lastRun.detail}` : ''})` : ''}; the cards stay on the tray`,
      })
    }
    // Could not process: the conversations paused for this agent (a pause is
    // the server's, with its own end, whether or not the daemon runs), and a
    // runtime check that fails (then no failure is reported as a
    // conversation's: a broken runtime is not its fault) — said only while
    // the status file is fresh: a check from before the daemon went quiet
    // says nothing about now.
    const cnp = integration?.could_not_process ?? null
    if (cnp !== null) {
      const paused = describePausedConversations(cnp.paused_conversations)
      const lastCheck = cnp.last_runtime_check
      const counts = describeCouldNotProcessCounts(cnp)
      if (paused !== null) {
        checks.push({ name: 'could-not-process', verdict: 'WARN', detail: paused.replace(/^could not process: /, '') })
      } else if (lastCheck !== null && runtimeCheckFailingNow(integration)) {
        checks.push(
          integrationStatusFresh(integration)
            ? {
                name: 'could-not-process',
                verdict: 'WARN',
                detail: `the runtime check failed (${lastCheck.detail ?? 'no detail'}; ${lastCheck.at}): while it fails, a conversation whose run fails is not reported, its card stays on the tray and the server wakes the agent again`,
              }
            : {
                name: 'could-not-process',
                verdict: 'WARN',
                detail: `the daemon has not written its status for ${integrationStatusStaleFor(integration)} — it may be down (a running daemon rewrites it every 30 s); the runtime check that failed at ${lastCheck.at} says nothing about now`,
              },
        )
      } else if (counts !== null) {
        checks.push({ name: 'could-not-process', verdict: 'PASS', detail: counts.replace(/^could not process: /, '') })
      }
    }

    if (profile.extraDoctorChecks !== undefined) {
      try {
        checks.push(...(await profile.extraDoctorChecks({ ...opts, ...texts })))
      } catch (err) {
        checks.push({ name: 'host', verdict: 'FAIL', detail: `the ${LABEL} checks failed: ${errorText(err)}` })
      }
    }

    console.log(checks.map((c) => `${c.verdict.padEnd(4)} ${c.name}: ${c.detail}`).join('\n'))
    return checks.some((c) => c.verdict === 'FAIL') ? 1 : 0
  }

  return {
    runRegister,
    runLogin,
    runRecover,
    runStatus,
    runLogout,
    runDoctor,
  }
}
