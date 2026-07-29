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
import { writeAnchor, removeAnchorAt, readAnchorHandleAt, hasAnchorAt } from '../anchor/block.js'
import { syncPeek } from '../wire/index.js'
import { anchorLabelOf, type DoctorCheck, type HostProfile, type Verdict } from './host-profile.js'
import { CODING_AGENTS_CLIENT_IDENTITY } from '../client-identity.js'

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
// drifted: the Claude Code copy reported `"host": "codex"` in `status --json`,
// because that is what copy-paste does to code nobody diffs.
//
// Every function acts on `profile.home()` — the caller's own agent. There is no
// host argument to get wrong, and no branch that could reach another agent's
// files.

// Canonical handle rule, mirrored from the server so obviously-bad input fails
// locally with a helpful message instead of a round-trip.
const HANDLE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

function validHandle(handle: string): boolean {
  return handle.length >= 3 && handle.length <= 30 && HANDLE_PATTERN.test(handle)
}

/**
 * Ask one question on the TTY.
 *
 * Deliberately the classic `node:readline`, not `node:readline/promises`.
 * esbuild strips the `node:` prefix from builtin imports when it bundles this
 * package, and a bare `readline/promises` is not on its builtin list — so the
 * subpath version resolves fine here but fails every integration's build the
 * moment they inline the engine. A callback wrapped in a Promise costs four
 * lines and cannot break a downstream bundle.
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

interface ApiErrorLike {
  code?: string
  message?: string
}

function describeApiError(err: unknown, invocation: string): string {
  const e = (err ?? {}) as ApiErrorLike
  const code = typeof e.code === 'string' ? e.code : undefined
  const message = typeof e.message === 'string' ? e.message : String(err)
  switch (code) {
    case 'HANDLE_TAKEN':
      return 'That handle is already taken — pick another and re-run.'
    case 'EMAIL_TAKEN':
      return `This email already has an active agent. Use \`${invocation} login\` with its key, or \`${invocation} recover --email <email>\` to re-key it.`
    case 'EMAIL_EXHAUSTED':
      return 'This email has used its lifetime maximum of 3 registrations.'
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

const RESTART_HINT =
  'Your messaging tools pick this up immediately — no restart needed. (If a send still says NOT_REGISTERED, you’re on an older MCP; start a fresh session once to refresh it.)'

export interface RegisterOpts {
  email?: string
  handle?: string
  displayName?: string
  description?: string
  code?: string
  apiBase?: string
}

export interface DoctorOpts {
  fix?: boolean
}

export interface IdentityCommands {
  runRegister(opts: RegisterOpts): Promise<number>
  runLogin(opts: { apiKey?: string; apiBase?: string }): Promise<number>
  runRecover(opts: { email?: string; code?: string; apiBase?: string }): Promise<number>
  runStatus(opts: { json?: boolean }): Promise<number>
  runLogout(): number
  runDoctor(opts?: DoctorOpts): Promise<number>
}

/** Build the identity command set for one coding agent. */
export function createIdentityCommands(profile: HostProfile): IdentityCommands {
  const invocation = (): string => profile.invocation()
  const apiErr = (err: unknown): string => describeApiError(err, invocation())
  const LABEL = profile.label

  /** Write THIS agent's anchor. Only ever touches `profile.anchorFile()`. */
  function writeOurAnchor(handle: string): string[] {
    const file = profile.anchorFile()
    const label = anchorLabelOf(profile)
    // A host that wires itself separately must not be handed an identity block
    // before that wiring exists — it would announce a handle with nothing
    // listening. Once an anchor is already there, keep it current regardless.
    if (profile.isWired !== undefined && !profile.isWired() && !hasAnchorAt(file)) return []
    try {
      writeAnchor(file, profile.renderAnchor(handle), handle)
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
          clientIdentity: CODING_AGENTS_CLIENT_IDENTITY,
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
            ...writeOurAnchor(pendingHandle),
            '',
            `This handle belongs to your ${LABEL} agent. Another coding agent on this machine is a separate peer with its own handle — you can DM each other.`,
            `Other agents can DM you at @${pendingHandle}. Check \`${invocation()} status\` any time.`,
            RESTART_HINT,
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
        clientIdentity: CODING_AGENTS_CLIENT_IDENTITY,
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

    if (!apiKey) {
      if (process.stdin.isTTY !== true) {
        console.error(`Missing --api-key. Usage: ${invocation()} login --api-key ac_live_…`)
        return 1
      }
      apiKey = await prompt('AgentChat API key (ac_…): ')
    }
    if (apiKey.length < 20) {
      console.error('That does not look like an AgentChat API key (too short).')
      return 1
    }

    try {
      const client = new AgentChatClient({
        apiKey,
        baseUrl: apiBase,
        clientIdentity: CODING_AGENTS_CLIENT_IDENTITY,
      })
      const me = await client.getMe()
      writeCredentials(home, {
        api_key: apiKey,
        handle: me.handle,
        ...(apiBase !== DEFAULT_API_BASE ? { api_base: apiBase } : {}),
        created_at: new Date().toISOString(),
      })
      clearOfferDeclined(home)
      console.log([`Signed in as @${me.handle} for ${LABEL}.`, ...writeOurAnchor(me.handle), RESTART_HINT].join('\n'))
      return 0
    } catch (err) {
      console.error(`Login failed. ${apiErr(err)}`)
      return 1
    }
  }

  async function runRecover(opts: { email?: string; code?: string; apiBase?: string }): Promise<number> {
    const home = profile.home()
    const apiBase = opts.apiBase ?? process.env['AGENTCHAT_API_BASE'] ?? DEFAULT_API_BASE

    if (opts.code !== undefined) {
      const code = opts.code.trim()
      if (!/^\d{6}$/.test(code)) {
        console.error('The code is the 6-digit number from the recovery email.')
        return 1
      }
      const pending = readPending(home)
      if (pending === null || pending.kind !== 'recover') {
        console.error(`No recovery in progress. Start with: ${invocation()} recover --email <email>`)
        return 1
      }
      try {
        const result = await AgentChatClient.recoverVerify(pending.pending_id, code, {
          baseUrl: pending.api_base ?? apiBase,
          clientIdentity: CODING_AGENTS_CLIENT_IDENTITY,
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
            `Recovered: @${result.handle} for ${LABEL} — a fresh API key is stored (the old key is now revoked).`,
            ...writeOurAnchor(result.handle),
            RESTART_HINT,
          ].join('\n'),
        )
        return 0
      } catch (err) {
        console.error(`Recovery failed. ${apiErr(err)}`)
        return 1
      }
    }

    let email = opts.email?.trim().toLowerCase()
    if (!email) {
      if (process.stdin.isTTY !== true) {
        console.error(`Missing --email. Usage: ${invocation()} recover --email <email>`)
        return 1
      }
      email = (await prompt('Email the agent was registered with: ')).toLowerCase()
    }
    if (!email.includes('@')) {
      console.error(`"${email}" does not look like an email address.`)
      return 1
    }

    try {
      const result = await AgentChatClient.recover(email, {
        baseUrl: apiBase,
        clientIdentity: CODING_AGENTS_CLIENT_IDENTITY,
      })
      if (!result.pending_id) {
        console.log('If an agent is registered with that email, a recovery code was sent to it.')
        return 0
      }
      writePending(home, {
        kind: 'recover',
        pending_id: result.pending_id,
        email,
        ...(apiBase !== DEFAULT_API_BASE ? { api_base: apiBase } : {}),
        created_at: new Date().toISOString(),
      })
      console.log(
        [
          'Recovery code sent (valid ~10 minutes).',
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

    if (identity === null) {
      if (opts.json) {
        console.log(
          JSON.stringify({ configured: false, pending: pending !== null, pending_kind: pending?.kind ?? null }),
        )
      } else if (pending?.kind === 'recover') {
        console.log(
          `No identity yet, but an account recovery is waiting on its emailed code — finish with: ${invocation()} recover --code <code>`,
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

    try {
      const client = new AgentChatClient({
        apiKey: identity.apiKey,
        baseUrl: identity.apiBase,
        clientIdentity: CODING_AGENTS_CLIENT_IDENTITY,
      })
      const me = await client.getMe()
      const rows = await syncPeek({ apiKey: identity.apiKey, apiBase: identity.apiBase }, { limit: 100 })
      const unread = rows.length === 100 ? '100+' : String(rows.length)

      if (opts.json) {
        console.log(
          JSON.stringify({
            configured: true,
            // Was hard-coded, and the Claude Code copy said 'codex'.
            host: profile.id,
            handle: me.handle,
            status: me.status ?? 'unknown',
            unread: rows.length,
            unread_capped: rows.length === 100,
            key_source: identity.source,
            api_base: identity.apiBase,
            home,
            anchor: hasAnchorAt(anchorFile),
          }),
        )
      } else {
        console.log(
          [
            `@${me.handle} — ${me.status ?? 'active'}  (${LABEL})`,
            `Unread: ${unread} message(s) queued`,
            `Key source: ${identity.source} (${identity.source === 'file' ? credentialsPath(home) : 'AGENTCHAT_API_KEY'})`,
            `API: ${identity.apiBase}`,
            `Anchor: ${hasAnchorAt(anchorFile) ? 'yes' : 'no'} (${anchorFile})`,
          ].join('\n'),
        )
      }
      return 0
    } catch (err) {
      console.error(`Could not reach AgentChat: ${apiErr(err)}`)
      return 1
    }
  }

  /**
   * Sign out THIS agent. Authentication and integration installation are
   * separate lifecycles: logout must never silently remove hooks, MCP wiring,
   * or a resident service. There is no `--all`, because a profile has no way
   * to reach another agent — that is the point.
   */
  function runLogout(): number {
    const home = profile.home()
    const anchorFile = profile.anchorFile()
    const reports: string[] = []
    let any = false

    if (clearCredentials(home)) {
      any = true
      reports.push('  credentials deleted')
    }
    if (removeAnchorAt(anchorFile) === 'removed') {
      any = true
      reports.push(`  ${anchorLabelOf(profile)} anchor removed`)
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
          const client = new AgentChatClient({
            apiKey: identity.apiKey,
            baseUrl: identity.apiBase,
            clientIdentity: CODING_AGENTS_CLIENT_IDENTITY,
          })
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

      // The anchor must name THIS agent. Releases of the old shared CLI wrote
      // the anchor for every host on the machine whenever any one registered,
      // so a two-agent box could end up with an instruction file announcing the
      // OTHER agent's handle — telling peers to DM an address that reaches
      // someone else.
      const claimed = readAnchorHandleAt(anchorFile)
      if (claimed === creds.handle) {
        checks.push({ name: 'anchor', verdict: 'PASS', detail: `@${claimed} in ${anchorFile}` })
      } else {
        const why =
          claimed === null
            ? `no identity block in ${anchorFile}`
            : `${anchorFile} says @${claimed} but this agent is @${creds.handle}`
        if (opts.fix === true) {
          const report = writeOurAnchor(creds.handle)
          const failed = report.some((l) => l.includes('FAILED'))
          checks.push({
            name: 'anchor',
            verdict: failed ? 'FAIL' : 'PASS',
            detail: failed ? `could not repair: ${report.join('; ')}` : `repaired → @${creds.handle}`,
          })
        } else {
          checks.push({
            name: 'anchor',
            verdict: 'WARN',
            detail: `${why} — repair with \`${invocation()} doctor --fix\``,
          })
        }
      }
    }

    if (profile.extraDoctorChecks !== undefined) checks.push(...profile.extraDoctorChecks(opts))

    console.log(checks.map((c) => `${c.verdict.padEnd(4)} ${c.name}: ${c.detail}`).join('\n'))
    return checks.some((c) => c.verdict === 'FAIL') ? 1 : 0
  }

  return { runRegister, runLogin, runRecover, runStatus, runLogout, runDoctor }
}
