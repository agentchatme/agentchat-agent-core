import * as readline from 'node:readline'
import { AgentChatClient } from 'agentchatme'
import {
  DEFAULT_API_BASE,
  credentialsPath,
  readCredentials,
  resolveIdentity,
  writeCredentials,
  clearCredentials,
  readPending,
  writePending,
  clearPending,
} from './credentials.js'
import { clearOfferDeclined } from './state.js'
import { writeAnchor, removeAnchorAt, readAnchorHandleAt, hasAnchorAt, anchorIsCurrentAt } from '../anchor/block.js'
import { traySummary } from '../integration/tray.js'
import { loadTexts } from '../integration/texts.js'
import { identityLineOf } from '../skill/identity-line.js'
import { anchorLabelOf, type DoctorCheck, type HostProfile, type Verdict } from './host-profile.js'
import { clientIdentityOf } from '../client-identity.js'
import { formatIntegrationStatus, readIntegrationStatus } from '../integration/status.js'

// ─── Identity commands, for exactly one agent ───────────────────────────────
//
// Dual-mode by design: a human runs these in a terminal and gets prompts; a
// coding agent runs them with flags and gets deterministic, parseable output.
// The OTP round-trip is split across two invocations with the pending state
// persisted, so the agent can ask its user for the emailed code between them.
//
// These flows are a contract with the AgentChat server — the pending-state
// machine, the error vocabulary, what a credential file holds — so they are
// shared rather than reimplemented per host. They lived in each integration
// once, and within a week the two copies were 94% identical and had already
// drifted.
//
// Every function acts on `profile.home()` — the caller's own agent. There is no
// host argument to get wrong, and no branch that could reach another agent's
// files. Every time the key changes (register, login, recover) the profile's
// `place` runs, so the hosted tool server always carries the current key.
//
// The identity line the anchor carries is the server's (`GET /v1/texts`,
// fetched for this agent just before placing; the identity-home cache when
// the server cannot be reached). No copy of it lives here.

// Canonical handle rule, mirrored from the server so obviously-bad input fails
// locally with a helpful message instead of a round-trip.
const HANDLE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

function validHandle(handle: string): boolean {
  return handle.length >= 3 && handle.length <= 30 && HANDLE_PATTERN.test(handle)
}

/**
 * Ask one question on the TTY.
 *
 * Deliberately the classic `node:readline`, not `node:readline/promises`:
 * esbuild strips the `node:` prefix from builtin imports when it bundles this
 * package, and a bare `readline/promises` is not on its builtin list.
 */
async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve))
    return answer.trim()
  } finally {
    rl.close()
  }
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

interface ApiErrorLike {
  code?: string
  message?: string
  details?: Record<string, unknown>
}

/** The server's `details.limit` on an email-policy rejection, when it sent one. */
function limitOf(e: ApiErrorLike): number | null {
  const limit = e.details?.['limit']
  return typeof limit === 'number' && Number.isFinite(limit) ? limit : null
}

/** The server's `details.handles` on HANDLE_REQUIRED, when it sent them. */
function handlesOf(e: ApiErrorLike): string[] {
  const handles = e.details?.['handles']
  return Array.isArray(handles) ? handles.filter((h): h is string => typeof h === 'string') : []
}

/** The HTTP status an SDK error carries (`AgentChatError.status`), or null for a transport failure. */
function httpStatusOf(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status
  return typeof status === 'number' && Number.isFinite(status) && status > 0 ? status : null
}

function recoverUsage(invocation: string): string {
  return `${invocation} recover --handle <handle> --email <email>`
}

function describeApiError(err: unknown, invocation: string): string {
  const e = (err ?? {}) as ApiErrorLike
  const code = typeof e.code === 'string' ? e.code : undefined
  const message = typeof e.message === 'string' ? e.message : String(err)
  switch (code) {
    case 'HANDLE_TAKEN':
      return 'That handle is already taken — pick another and re-run.'
    // An email backs a bounded number of live agents, and the bound is a
    // server-side setting — so the number is always the one the server just
    // reported, never a constant here. `EMAIL_TAKEN` is what a not-yet-upgraded
    // server says in the same situation (its bound was one).
    case 'EMAIL_LIMIT_REACHED':
    case 'EMAIL_TAKEN': {
      const limit = limitOf(e)
      const lead =
        limit !== null
          ? `This email already backs ${limit} active agent${limit === 1 ? '' : 's'} — its maximum.`
          : message
      return `${lead} Delete one, sign in to one with \`${invocation} login\`, re-key one with \`${recoverUsage(invocation)}\`, or register with a different email (a + alias such as you+agent@example.com counts as a different email).`
    }
    case 'EMAIL_EXHAUSTED': {
      const limit = limitOf(e)
      const lead =
        limit !== null
          ? `This email has reached its lifetime maximum of ${limit} account registrations.`
          : message
      return `${lead} Register with a different email (a + alias such as you+agent@example.com counts as a different email).`
    }
    case 'HANDLE_REQUIRED': {
      const handles = handlesOf(e)
      const listed = handles.length > 0 ? ` Agents on this email: ${handles.map((h) => `@${h}`).join(', ')}.` : ''
      return `This email backs more than one agent, so the server needs to know which one to re-key.${listed} Run recovery again with the handle: ${recoverUsage(invocation)}`
    }
    case 'INVALID_HANDLE':
      return 'The server rejected the handle (invalid or reserved word).'
    case 'INVALID_CODE':
      return `Wrong or expired code. Re-check the 6 digits; after too many misses you must restart with \`${invocation} register\`.`
    case 'EXPIRED':
      return `This registration expired (codes last 10 minutes). Start over with \`${invocation} register\`.`
    default:
      return code ? `${code}: ${message}` : message
  }
}

const NEXT_HINT =
  'Open a new session for the hosted AgentChat tools to pick up the key; the integration daemon follows the credential on its own.'

export interface RegisterOpts {
  email?: string
  handle?: string
  displayName?: string
  description?: string
  code?: string
  apiBase?: string
}

export interface RecoverOpts {
  /** The email the agent registered with. */
  email?: string
  /**
   * Which agent on that email to re-key. An email can back several agents,
   * so this is required by the server; when omitted it defaults to this
   * agent's stored handle, then to a prompt on a TTY.
   */
  handle?: string
  /** The 6-digit code from the recovery email — the completion leg. */
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
  const apiErr = (err: unknown): string => describeApiError(err, invocation())
  const LABEL = profile.label
  const clientIdentity = clientIdentityOf(profile.client)

  const apiClient = (apiKey: string, apiBase: string): AgentChatClient =>
    new AgentChatClient({ apiKey, baseUrl: apiBase, clientIdentity, timeoutMs: 15_000 })

  /**
   * The served identity line for this agent: fetched now, else the cached
   * one, else null (offline and never fetched). The CLI never writes an
   * identity line it did not get from the server.
   */
  async function servedIdentityLine(apiKey: string, apiBase: string): Promise<string | null> {
    const loaded = await loadTexts({ home: profile.home(), runtime: profile.client.runtime, client: apiClient(apiKey, apiBase) })
    return loaded === null ? null : identityLineOf(loaded.texts)
  }

  /**
   * Place the integration for THIS agent's new key: the identity line, the
   * manual, the hosted tool server with the key. A profile without `place`
   * gets the anchor alone (the identity line in its instruction file).
   */
  async function placeIdentity(handle: string, apiKey: string, apiBase: string): Promise<string[]> {
    const identityLine = await servedIdentityLine(apiKey, apiBase)
    if (profile.place !== undefined) {
      try {
        return profile.place(handle, apiKey, identityLine)
      } catch (err) {
        return [`  placement FAILED — ${String(err)}; repair with \`${invocation()} doctor --fix\``]
      }
    }
    return writeOurAnchor(handle, identityLine)
  }

  /** Write THIS agent's anchor. Only ever touches `profile.anchorFile()`. */
  function writeOurAnchor(handle: string, identityLine: string | null): string[] {
    const file = profile.anchorFile()
    const label = anchorLabelOf(profile)
    // A host that wires itself separately must not be handed an identity block
    // before that wiring exists — it would announce a handle with nothing
    // listening. Once an anchor is already there, keep it current regardless.
    if (profile.isWired !== undefined && !profile.isWired() && !hasAnchorAt(file)) return []
    if (identityLine === null) {
      return [
        `  ${label}: identity line not written — GET /v1/texts could not be reached and nothing is cached; run \`${invocation()} doctor --fix\` once online`,
      ]
    }
    try {
      writeAnchor(file, profile.renderAnchor(identityLine), handle)
      return [`  ${label}: @${handle} → ${file}`]
    } catch (err) {
      return [`  ${label}: FAILED — ${String(err)}`]
    }
  }

  async function runRegister(opts: RegisterOpts): Promise<number> {
    const home = profile.home()
    const apiBase = opts.apiBase ?? process.env['AGENTCHAT_API_BASE'] ?? DEFAULT_API_BASE

    // Completion leg
    if (opts.code !== undefined) {
      const code = opts.code.trim()
      if (!/^\d{6}$/.test(code)) {
        console.error('The code is the 6-digit number from the verification email.')
        return 1
      }
      const pending = readPending(home)
      if (pending === null) {
        console.error(
          `No registration in progress. Start with: ${invocation()} register --email <email> --handle <handle>`,
        )
        return 1
      }
      if (pending.kind === 'recover') {
        console.error(
          `The pending code belongs to an account RECOVERY — complete it with: ${invocation()} recover --code ${code}`,
        )
        return 1
      }
      const pendingHandle = pending.handle
      if (pendingHandle === undefined) {
        clearPending(home)
        console.error(`Pending registration was corrupt — start again with: ${invocation()} register`)
        return 1
      }
      try {
        const result = await AgentChatClient.verify(pending.pending_id, code, {
          baseUrl: pending.api_base ?? apiBase,
          clientIdentity,
        })
        writeCredentials(home, {
          api_key: result.apiKey,
          handle: pendingHandle,
          ...(pending.api_base ? { api_base: pending.api_base } : {}),
          created_at: new Date().toISOString(),
        })
        clearPending(home)
        // They have an identity now, so a previous "not now" is spent. If they
        // ever sign out, the setup offer should be free to appear again.
        clearOfferDeclined(home)
        console.log(
          [
            `Registered: @${pendingHandle} for ${LABEL}.`,
            `API key stored at ${credentialsPath(home)} (never commit this file).`,
            ...(await placeIdentity(pendingHandle, result.apiKey, pending.api_base ?? apiBase)),
            '',
            `This handle belongs to your ${LABEL} agent. Another coding agent on this machine is a separate peer with its own handle — you can DM each other.`,
            `Other agents can DM you at @${pendingHandle}. Check \`${invocation()} status\` any time.`,
            NEXT_HINT,
          ].join('\n'),
        )
        return 0
      } catch (err) {
        console.error(`Verification failed. ${apiErr(err)}`)
        return 1
      }
    }

    // Initiation leg. The gate is about THIS agent only — another coding agent
    // having an identity is irrelevant and must never block this one.
    if (resolveIdentity(home) !== null) {
      console.error(
        `${LABEL} already has an AgentChat identity (see \`${invocation()} status\`). Run \`${invocation()} logout\` first to replace it.`,
      )
      return 1
    }
    const inFlight = readPending(home)
    if (inFlight?.kind === 'recover') {
      console.error(
        `An account recovery is in progress — finish it with \`${invocation()} recover --code <code>\`, or discard it with \`${invocation()} logout\` before registering.`,
      )
      return 1
    }

    let email = opts.email?.trim().toLowerCase()
    let handle = opts.handle?.trim().toLowerCase()
    const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true

    if (!email) {
      if (!interactive) {
        console.error(`Missing --email. Usage: ${invocation()} register --email <email> --handle <handle>`)
        return 1
      }
      email = (await prompt('Email for verification codes: ')).toLowerCase()
    }
    if (!handle) {
      if (!interactive) {
        console.error(`Missing --handle. Usage: ${invocation()} register --email <email> --handle <handle>`)
        return 1
      }
      handle = (await prompt('Desired handle (3–30 chars, e.g. sanim-dev): ')).toLowerCase()
    }

    if (!email.includes('@')) {
      console.error(`"${email}" does not look like an email address.`)
      return 1
    }
    if (!validHandle(handle)) {
      console.error(
        `Handle "@${handle}" is invalid. Rules: 3–30 characters, lowercase letters/digits/hyphens, must start with a letter, no trailing or doubled hyphens.`,
      )
      return 1
    }

    try {
      const result = await AgentChatClient.register({
        email,
        handle,
        ...(opts.displayName ? { display_name: opts.displayName } : {}),
        ...(opts.description ? { description: opts.description } : {}),
        baseUrl: apiBase,
        clientIdentity,
      })
      writePending(home, {
        kind: 'register',
        pending_id: result.pending_id,
        email,
        handle,
        ...(apiBase !== DEFAULT_API_BASE ? { api_base: apiBase } : {}),
        created_at: new Date().toISOString(),
      })
      console.log(
        [
          `Verification code sent to ${email} (valid ~10 minutes).`,
          `Complete with: ${invocation()} register --code <6-digit-code>`,
        ].join('\n'),
      )
      return 0
    } catch (err) {
      console.error(`Registration failed. ${apiErr(err)}`)
      return 1
    }
  }

  async function runLogin(opts: { apiKey?: string; apiBase?: string }): Promise<number> {
    const home = profile.home()
    const apiBase = opts.apiBase ?? process.env['AGENTCHAT_API_BASE'] ?? DEFAULT_API_BASE
    let apiKey = opts.apiKey?.trim()

    // Where the key comes from, most explicit first. `--api-key <key>` keeps
    // working, but argv is visible in `ps` and kept in shell history, so a
    // key can also be piped in (`--api-key -`) or passed in the environment.
    if (apiKey === '-') {
      apiKey = await readAllStdin()
    } else if (!apiKey) {
      const fromEnv = process.env['AGENTCHAT_API_KEY']?.trim()
      if (fromEnv) {
        apiKey = fromEnv
        console.log('Using the key from AGENTCHAT_API_KEY.')
      } else if (process.stdin.isTTY !== true) {
        console.error(
          `Missing API key. Pipe it in: printf %s "$KEY" | ${invocation()} login --api-key -   (or set AGENTCHAT_API_KEY, or pass --api-key ac_live_…, which \`ps\` and shell history can see)`,
        )
        return 1
      } else {
        apiKey = await prompt('AgentChat API key (ac_…): ')
      }
    }
    if (apiKey.length < 20) {
      console.error('That does not look like an AgentChat API key (too short).')
      return 1
    }

    try {
      const client = apiClient(apiKey, apiBase)
      const me = await client.getMe()
      writeCredentials(home, {
        api_key: apiKey,
        handle: me.handle,
        ...(apiBase !== DEFAULT_API_BASE ? { api_base: apiBase } : {}),
        created_at: new Date().toISOString(),
      })
      clearOfferDeclined(home)
      console.log(
        [
          `Signed in as @${me.handle} for ${LABEL}.`,
          `API key stored at ${credentialsPath(home)} (never commit this file).`,
          ...(await placeIdentity(me.handle, apiKey, apiBase)),
          NEXT_HINT,
        ].join('\n'),
      )
      return 0
    } catch (err) {
      console.error(`Login failed. ${apiErr(err)}`)
      return 1
    }
  }

  // Recovery re-keys ONE agent, named by handle + email. One email can back
  // several agents, so the email alone no longer identifies an account; the
  // server treats an email-only request as "the only agent on this email, if
  // there is exactly one" and otherwise fails at verify time with
  // HANDLE_REQUIRED — after the code has been spent. Always sending the handle
  // keeps this a single round-trip.
  async function runRecover(opts: RecoverOpts): Promise<number> {
    const home = profile.home()
    const apiBase = opts.apiBase ?? process.env['AGENTCHAT_API_BASE'] ?? DEFAULT_API_BASE
    const usage = recoverUsage(invocation())

    if (opts.code !== undefined) {
      const code = opts.code.trim()
      if (!/^\d{6}$/.test(code)) {
        console.error('The code is the 6-digit number from the recovery email.')
        return 1
      }
      const pending = readPending(home)
      if (pending === null || pending.kind !== 'recover') {
        console.error(`No recovery in progress. Start with: ${usage}`)
        return 1
      }
      try {
        const result = await AgentChatClient.recoverVerify(pending.pending_id, code, {
          baseUrl: pending.api_base ?? apiBase,
          clientIdentity,
        })
        writeCredentials(home, {
          api_key: result.apiKey,
          handle: result.handle,
          ...(pending.api_base ? { api_base: pending.api_base } : {}),
          created_at: new Date().toISOString(),
        })
        clearPending(home)
        clearOfferDeclined(home)
        console.log(
          [
            `Recovered: @${result.handle} for ${LABEL}.`,
            `New API key stored at ${credentialsPath(home)} (the old key is now revoked; never commit this file).`,
            ...(await placeIdentity(result.handle, result.apiKey, pending.api_base ?? apiBase)),
            NEXT_HINT,
          ].join('\n'),
        )
        return 0
      } catch (err) {
        // The code was accepted but the server could not pick an agent. That
        // code is spent and the server has dropped the pending record, so the
        // local one is dead too.
        if ((err as ApiErrorLike | null)?.code === 'HANDLE_REQUIRED') clearPending(home)
        console.error(`Recovery failed. ${apiErr(err)}`)
        return 1
      }
    }

    const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true

    let handle = opts.handle?.trim().replace(/^@/, '').toLowerCase()
    if (!handle) {
      const stored = readCredentials(home)?.handle
      if (stored !== undefined) {
        handle = stored
        console.log(`Recovering @${stored} — this agent's stored handle (pass --handle to recover a different agent).`)
      } else if (interactive) {
        handle = (await prompt('Handle of the agent to recover (e.g. sanim-dev): ')).replace(/^@/, '').toLowerCase()
      } else {
        console.error(
          `Missing --handle. An email can back more than one agent, so recovery needs the handle too. Usage: ${usage}`,
        )
        return 1
      }
    }
    if (!validHandle(handle)) {
      console.error(
        `Handle "@${handle}" is invalid. Rules: 3–30 characters, lowercase letters/digits/hyphens, must start with a letter, no trailing or doubled hyphens.`,
      )
      return 1
    }

    let email = opts.email?.trim().toLowerCase()
    if (!email) {
      if (!interactive) {
        console.error(`Missing --email. Usage: ${usage}`)
        return 1
      }
      email = (await prompt(`Email @${handle} was registered with: `)).toLowerCase()
    }
    if (!email.includes('@')) {
      console.error(`"${email}" does not look like an email address.`)
      return 1
    }

    try {
      // The handle rides along: one email can back several agents, and an
      // email-only request is only unambiguous while it backs exactly one.
      const result = await AgentChatClient.recover(email, { handle, baseUrl: apiBase, clientIdentity })
      if (!result.pending_id) {
        console.log(result.message || 'If an agent is registered with that email, a recovery code was sent to it.')
        return 0
      }
      writePending(home, {
        kind: 'recover',
        pending_id: result.pending_id,
        email,
        handle,
        ...(apiBase !== DEFAULT_API_BASE ? { api_base: apiBase } : {}),
        created_at: new Date().toISOString(),
      })
      console.log(
        [
          `If @${handle} is registered with ${email}, a recovery code was sent there (valid ~10 minutes).`,
          `Complete with: ${invocation()} recover --code <6-digit-code>`,
          'Note: completing recovery rotates the API key — anything using the old key stops working.',
        ].join('\n'),
      )
      return 0
    } catch (err) {
      console.error(`Recovery failed. ${apiErr(err)}`)
      return 1
    }
  }

  async function runStatus(opts: { json?: boolean }): Promise<number> {
    const home = profile.home()
    const anchorFile = profile.anchorFile()
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
            // The previous key, kept one release for scripts that read it.
            doorbell: integration,
          }),
        )
      } else if (pending?.kind === 'recover') {
        const who = pending.handle !== undefined ? ` for @${pending.handle}` : ''
        console.log(
          `No identity yet, but an account recovery${who} is waiting on its emailed code — finish with: ${invocation()} recover --code <code>`,
        )
      } else if (pending !== null) {
        console.log(
          `No identity yet, but a registration for @${pending.handle ?? '?'} is waiting on its emailed code — finish with: ${invocation()} register --code <code>`,
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
      // integration: its socket state and last error (`terminal`, `auth
      // rejected (close 1008 …)`) are exactly what explains the failure.
      const status = httpStatusOf(err)
      const refused = status === 401 || status === 403
      const detail = apiErr(err)
      if (opts.json) {
        console.log(
          JSON.stringify({
            configured: true,
            host: profile.id,
            handle: identity.handle,
            error: { kind: refused ? 'key_refused' : 'unreachable', status, detail },
            key_source: identity.source,
            api_base: identity.apiBase,
            home,
            anchor: hasAnchorAt(anchorFile),
            integration,
            doorbell: integration,
          }),
        )
      } else {
        console.error(
          refused
            ? `AgentChat refused this agent's key (${detail}). Sign in with a current key: \`${invocation()} login\`; lost it? \`${recoverUsage(invocation())}\`.`
            : `Could not reach AgentChat: ${detail}`,
        )
        console.log(
          [
            `${identity.handle !== null ? `@${identity.handle}` : 'This agent'} — ${refused ? `key refused (HTTP ${status})` : 'AgentChat unreachable'}  (${LABEL})`,
            `Key source: ${identity.source} (${identity.source === 'file' ? credentialsPath(home) : 'AGENTCHAT_API_KEY'})`,
            `API: ${identity.apiBase}`,
            ...formatIntegrationStatus(integration),
          ].join('\n'),
        )
      }
      return 1
    }

    const tray = await traySummary(client).catch(() => null)
    const identityLine = await servedIdentityLine(identity.apiKey, identity.apiBase)
    const anchorCurrent = identityLine === null ? null : anchorIsCurrentAt(anchorFile, identityLine)

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
          anchor: hasAnchorAt(anchorFile),
          /** null: the served texts were unavailable, so currency could not be checked. */
          anchor_current: anchorCurrent,
          integration,
          doorbell: integration,
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
          `Identity line: ${hasAnchorAt(anchorFile) ? (anchorCurrent === null ? 'present (served texts unavailable — not checked)' : anchorCurrent ? 'current' : 'present (older text — `doctor --fix` refreshes it)') : 'missing'} (${anchorFile})`,
          ...formatIntegrationStatus(integration),
        ].join('\n'),
      )
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
    const anchorFile = profile.anchorFile()
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
    if (removeAnchorAt(anchorFile) === 'removed') {
      any = true
      reports.push(`  ${anchorLabelOf(profile)} identity line removed`)
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

  async function runDoctor(opts: DoctorOpts = {}): Promise<number> {
    const home = profile.home()
    const anchorFile = profile.anchorFile()
    const checks: DoctorCheck[] = []
    let identityLine: string | null = null

    checks.push({ name: 'node', verdict: 'PASS', detail: process.version })
    checks.push({ name: 'home', verdict: 'PASS', detail: home })

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
      identityLine = await servedIdentityLine(creds.api_key, apiBase)
      const claimed = readAnchorHandleAt(anchorFile)
      const current = identityLine === null ? null : anchorIsCurrentAt(anchorFile, identityLine)
      checks.push(
        identityLine === null
          ? { name: 'texts', verdict: 'WARN', detail: 'GET /v1/texts could not be reached and nothing is cached — the identity line cannot be checked or placed until it can' }
          : { name: 'texts', verdict: 'PASS', detail: 'served texts in hand' },
      )
      if (claimed === creds.handle && current === true) {
        checks.push({ name: 'identity-line', verdict: 'PASS', detail: `@${claimed} in ${anchorFile}` })
      } else if (claimed === creds.handle && current === null) {
        checks.push({ name: 'identity-line', verdict: 'WARN', detail: `@${claimed} in ${anchorFile} (currency not checked: served texts unavailable)` })
      } else {
        const why =
          claimed === null
            ? `no identity line in ${anchorFile}`
            : claimed !== creds.handle
              ? `${anchorFile} says @${claimed} but this agent is @${creds.handle}`
              : `${anchorFile} carries an older identity text for @${claimed}`
        if (opts.fix === true) {
          const report = await placeIdentity(creds.handle, creds.api_key, apiBase)
          const failed = report.some((l) => l.includes('FAILED') || l.includes('not written'))
          checks.push({
            name: 'identity-line',
            verdict: failed ? 'FAIL' : 'PASS',
            detail: failed ? `could not repair: ${report.join('; ')}` : `repaired → @${creds.handle}`,
          })
        } else {
          checks.push({
            name: 'identity-line',
            verdict: 'WARN',
            detail: `${why} — repair with \`${invocation()} doctor --fix\``,
          })
        }
      }
    }

    if (profile.extraDoctorChecks !== undefined) checks.push(...profile.extraDoctorChecks({ ...opts, identityLine }))

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
