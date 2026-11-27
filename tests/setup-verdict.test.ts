import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  formatSetupVerdict,
  listenerReasonKindOf,
  newerRelease,
  reachabilityOf,
  readListener,
  setupVerdict,
  type ListenerReading,
  type SetupInputs,
  type SetupVerdict,
} from '../src/identity/setup.js'
import { writeCredentials, type PendingSignup } from '../src/identity/credentials.js'
import { markAlwaysOnInstalledVersion, markAlwaysOnOptOut, markAlwaysOnWanted } from '../src/daemon/health.js'
import { DAEMON_LOCK_FILE } from '../src/daemon/leader-lock.js'
import { writeIntegrationStatus, type IntegrationStatus } from '../src/integration/status.js'
import { ClaudeRunner, inspectClaudeRuntime } from '../src/presets/claude-code.js'
import { CodexRunner } from '../src/presets/codex.js'
import { installFakeClaude, installFakeCodex } from './helpers/fake-runtimes.js'

// ─── The setup verdict: one answer, from plain inputs ───────────────────────
//
// Every state the verdict can say, from the inputs that lead to it, and the
// words an agent acts on: the exact command, whether only the person can do
// the next step, and what to ask them. Then the listener's own files as
// `readListener` reads them, and the runtime's reasons in the server's words.

const INV = 'npx -y @agentchatme/example'
const NOW = Date.parse('2026-11-28T12:00:00.000Z')

/** A listener that is registered, current and connected as @demo-agent. */
const CONNECTED: ListenerReading = {
  optedOut: false,
  wanted: true,
  installedVersion: '0.8.0',
  daemon: { kind: 'ready', runsFailing: null, runtimeCheckFailing: false },
  alive: true,
  withinGrace: false,
  lastAliveAt: '2026-11-28T11:59:40.000Z',
}

function inputs(over: Partial<SetupInputs> = {}): SetupInputs {
  return {
    invocation: INV,
    label: 'Example',
    version: '0.8.0',
    home: '/home/u/.example/agentchat',
    identity: { handle: 'demo-agent', source: 'file' },
    pending: null,
    server: { kind: 'ok', handle: 'demo-agent', reachability: null },
    listener: CONNECTED,
    now: NOW,
    ...over,
  }
}

const listener = (over: Partial<ListenerReading>): ListenerReading => ({ ...CONNECTED, ...over })

/** A connected daemon's status for `handle`, written now. */
function statusFor(handle: string): IntegrationStatus {
  return {
    version: 2,
    updated_at: new Date().toISOString(),
    pid: process.pid,
    runtime: 'x',
    handle,
    profile: 'own',
    socket: 'ready',
    wakes: 0,
    wakes_absorbed: 0,
    invites: 0,
    runs_started: 0,
    runs_ok: 0,
    runs_failed: 0,
    runs_timed_out: 0,
    runs_not_started: 0,
    runs_skipped_empty: 0,
    last_run: null,
    retry_rung: 0,
    retry_due_at: null,
    last_error: null,
    texts: null,
  }
}

function judged(over: Partial<SetupInputs> = {}): SetupVerdict {
  const verdict = setupVerdict(inputs(over))
  expect(verdict).not.toBeNull()
  return verdict!
}

function pendingOf(over: Partial<PendingSignup> = {}): PendingSignup {
  return {
    kind: 'register',
    flow: { version: 1, flow: 'register', next_step: 'verify', status: 'pending', pending_id: 'pnd_1', expires_in_s: 600, code_length: 6, resend_after_s: 60 },
    received_at: new Date(NOW - 60_000).toISOString(),
    email: 'agent@example.com',
    handle: 'demo-agent',
    ...over,
  }
}

describe('the account part of the verdict', () => {
  it('no account: the register command with placeholders, and the key-file path for an existing key', () => {
    const v = judged({ identity: null, server: null, listener: null })
    expect(v.state).toBe('no_account')
    expect(v.command).toBe(`${INV} register --email <email> --handle <handle>`)
    expect(v.needs_person).toBe(false)
    expect(v.next).toContain(`${INV} login --api-key - < <that file>`)
    expect(v.next).toContain('file-editing tool')
    expect(formatSetupVerdict(v)).toMatch(/^Setup: no_account — this Example agent has no AgentChat account yet\. /)
  })

  it('a code waiting: the code command, where it was sent, when it expires; asking the person only if the inbox is not readable', () => {
    const v = judged({ identity: null, server: null, listener: null, pending: pendingOf() })
    expect(v.state).toBe('code_pending')
    expect(v.command).toBe(`${INV} register --code <6 digits>`)
    expect(v.needs_person).toBe(false)
    expect(v.ask).toBe('AgentChat emailed a code to agent@example.com. What is it?')
    expect(v.next).toBe(
      `a registration of @demo-agent is waiting on the 6-digit code AgentChat emailed to agent@example.com; it expires in 9 minutes. Run \`${INV} register --code <6 digits>\` with it. If you cannot read that inbox, ask the person you work with for the code.`,
    )
  })

  it('an expired code: the start command again, after the resend window when one is left', () => {
    const old = pendingOf({ received_at: new Date(NOW - 11 * 60_000).toISOString() })
    const v = judged({ identity: null, server: null, listener: null, pending: old })
    expect(v.state).toBe('code_expired')
    expect(v.command).toBe(`${INV} register --email agent@example.com --handle demo-agent`)
    expect(v.next).toContain('has expired')
    // A record not waiting for a code reads the same way: only a new start goes on.
    const stale = pendingOf({ flow: { version: 1, flow: 'register', next_step: 'register', status: 'expired' } })
    expect(judged({ identity: null, server: null, listener: null, pending: stale }).state).toBe('code_expired')
  })

  it('a refused key: needs the person (recovery replaces the key), names both ways, never the email-only recovery form', () => {
    const v = judged({ server: { kind: 'refused', detail: 'UNAUTHORIZED: Invalid API key' } })
    expect(v.state).toBe('key_refused')
    expect(v.needs_person).toBe(true)
    expect(v.command).toBe(`${INV} recover --handle demo-agent --email <email>`)
    expect(v.ask).toMatch(/replaces the key/)
    expect(v.next).toContain(`${INV} login --api-key - < <that file>`)
    expect(judged({ identity: { handle: null, source: 'env' }, server: { kind: 'refused', detail: 'x' } }).command).toBe(`${INV} recover --handle <handle> --email <email>`)
  })

  it('a refused key with a recovery code waiting: the code command first', () => {
    const recovery = pendingOf({ kind: 'recover', flow: { version: 1, flow: 'recover', next_step: 'recover_verify', status: 'pending', pending_id: 'pnd_r', code_length: 6 } })
    const v = judged({ server: { kind: 'refused', detail: 'UNAUTHORIZED: Invalid API key' }, pending: recovery })
    expect(v.state).toBe('key_refused')
    expect(v.command).toBe(`${INV} recover --code <6 digits>`)
    expect(v.needs_person).toBe(false)
  })

  it('a suspended account: no recovery advice, the person emails support', () => {
    const v = judged({ server: { kind: 'suspended', detail: 'SUSPENDED: Account suspended' } })
    expect(v.state).toBe('suspended')
    expect(v.needs_person).toBe(true)
    expect(v.command).toBeNull()
    expect(v.next).toContain('support@agentchat.me')
    expect(v.next).toContain('recovering the account does not help')
    expect(v.next).not.toMatch(/recover --/)
  })

  it('an unreachable server: check the network, then status', () => {
    const v = judged({ server: { kind: 'unreachable', detail: 'fetch failed' } })
    expect(v).toMatchObject({ state: 'unreachable', command: `${INV} status`, needs_person: false })
  })

  it('paused by the person who claimed it: the server’s words, and only they can resume it', () => {
    const v = judged({ server: { kind: 'ok', handle: 'demo-agent', reachability: { state: 'paused', via: null, problemKind: null, problemText: null, text: 'The person who claimed your account paused you entirely.' } } })
    expect(v.state).toBe('paused')
    expect(v.needs_person).toBe(true)
    expect(v.next).toContain('The person who claimed your account paused you entirely.')
  })

  it('a host with no listener of its own: nothing to say once the account is fine', () => {
    expect(setupVerdict(inputs({ listener: null }))).toBeNull()
  })
})

describe('the tools', () => {
  it('a placement problem the host names is `tools_missing`, in its words; `doctor --fix` unless only the person can resolve it', () => {
    const failed = judged({ tools: { text: 'the hosted tools could not be registered (exit 1). Run `x doctor --fix`.' } })
    expect(failed).toMatchObject({ state: 'tools_missing', command: `${INV} doctor --fix`, needs_person: false })
    const theirs = judged({ tools: { text: 'their own entry stands in the way: ask before removing it.', needsPerson: true, ask: 'May I remove it?' } })
    expect(theirs).toMatchObject({ state: 'tools_missing', command: null, needs_person: true, ask: 'May I remove it?' })
    // Said before anything about the listener: a listener whose runs have no tools would only fail.
    expect(judged({ tools: { text: 'x' }, listener: listener({ optedOut: true }) }).state).toBe('tools_missing')
  })
})

describe('the listener part of the verdict', () => {
  it('ready: connected, and the server agrees or says nothing; right after a sign-in it ends with the one thing to tell the person', () => {
    expect(judged().state).toBe('ready')
    const after = judged({ afterSignIn: true })
    expect(after.next).toBe(
      "@demo-agent is listening on this computer: a peer's message starts a Example run here. Last, tell the person you work with: open a new Example session to have the AgentChat tools in this chat; receiving does not need it.",
    )
    expect(after).toMatchObject({ command: null, needs_person: false, ask: null })
    const agrees = { state: 'ready', via: 'socket', problemKind: null, problemText: null, text: 'ok' }
    expect(judged({ server: { kind: 'ok', handle: 'demo-agent', reachability: agrees } }).state).toBe('ready')
  })

  it('an older registered release that is connected is ready, with a note; a newer one is never stale', () => {
    const older = judged({ listener: listener({ installedVersion: '0.7.3' }) })
    expect(older.state).toBe('ready')
    expect(older.detail).toBe(`the listener installed here is 0.7.3; \`${INV}\` updates it to 0.8.0`)
    expect(judged({ listener: listener({ installedVersion: '0.9.0' }) }).detail).toBeNull()
  })

  it('standing by for another listener on this computer: ready, naming the other home, only when that listener says it is connected', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-other-'))
    try {
      const standby = listener({ daemon: { kind: 'standby', home: other, pid: 4242 } })
      // The other home has said nothing: not ready.
      expect(judged({ listener: standby, now: Date.now() }).state).toBe('listener_starting')
      writeCredentials(other, { api_key: `ac_${'o'.repeat(32)}`, handle: 'demo-agent' })
      writeIntegrationStatus(other, statusFor('demo-agent'))
      fs.writeFileSync(path.join(other, DAEMON_LOCK_FILE), `${process.pid}\n${JSON.stringify({ pid: process.pid, token: 't', host: os.hostname(), renewed_at: Date.now() })}\n`)
      const v = judged({ listener: standby, now: Date.now() })
      expect(v.state).toBe('ready')
      expect(v.next).toContain(`${other}, pid 4242`)
      expect(v.detail).toBe(`another listener on this computer serves @demo-agent from ${other}`)
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })

  it('switched off by the person: only they turn it back on (`daemon install`), whether it says so now or this command found it', () => {
    for (const v of [judged({ listener: listener({ optedOut: true }) }), judged({ ensure: { outcome: 'opted_out', detail: null } })]) {
      expect(v).toMatchObject({ state: 'listener_off', command: `${INV} daemon install`, needs_person: true })
      expect(v.ask).toMatch(/May I turn it back on\?/)
    }
    const env = judged({ listener: listener({ daemon: { kind: 'off' } }) })
    expect(env.state).toBe('listener_off')
    expect(env.next).toContain('AGENTCHAT_INTEGRATION=off')
  })

  it('missing: never registered (install it), could not be registered (retry), or an older release not connected (update it)', () => {
    expect(judged({ listener: listener({ wanted: false, daemon: { kind: 'none' } }) })).toMatchObject({ state: 'listener_missing', command: INV })
    const failed = judged({ ensure: { outcome: 'failed', detail: 'launchctl bootstrap failed: 5' } })
    expect(failed).toMatchObject({ state: 'listener_missing', command: `${INV} daemon install`, detail: 'launchctl bootstrap failed: 5' })
    const stale = judged({ listener: listener({ installedVersion: '0.7.3', daemon: { kind: 'none' }, alive: false }) })
    expect(stale).toMatchObject({ state: 'listener_missing', command: INV })
  })

  it('down: registered, nothing alive, past the start-up grace — `daemon install` starts it again', () => {
    const v = judged({ listener: listener({ daemon: { kind: 'none' }, alive: false, withinGrace: false }) })
    expect(v).toMatchObject({ state: 'listener_down', command: `${INV} daemon install`, needs_person: false })
    expect(v.next).toContain('last sign of life 2026-11-28T11:59:40.000Z')
  })

  it('starting: within the grace, a daemon alive with nothing said yet, connecting, or registered by this command', () => {
    const none = { daemon: { kind: 'none' } as const, alive: false }
    for (const over of [{ ...none, withinGrace: true }, { daemon: { kind: 'none' } as const, alive: true }, { daemon: { kind: 'connecting' } as const }]) {
      expect(judged({ listener: listener(over) }).state).toBe('listener_starting')
    }
    expect(judged({ listener: listener(none), ensure: { outcome: 'installed', detail: 'svc' } }).state).toBe('listener_starting')
    const v = judged({ listener: listener({ daemon: { kind: 'connecting' } }) })
    expect(v.command).toBe(`${INV} status`)
    expect(v.next).toContain(`if it still says starting after a minute, run \`${INV} doctor\``)
  })

  it('connected, but AgentChat does not see the connection: starting, not ready', () => {
    const none = { state: 'none', via: null, problemKind: null, problemText: null, text: 'AgentChat cannot start your runs yet' }
    const v = judged({ server: { kind: 'ok', handle: 'demo-agent', reachability: none } })
    expect(v.state).toBe('listener_starting')
    expect(v.next).toContain('AgentChat does not see the connection yet')
  })

  it('failing, by reason: the runtime signed out (the person signs it in, as its check says)', () => {
    const detail = 'runtime (claude) not ready: claude is not signed in (run `claude` once and sign in)'
    const v = judged({ listener: listener({ daemon: { kind: 'start_failure', detail } }) })
    expect(v).toMatchObject({ state: 'listener_failing', needs_person: true, command: `${INV} status`, detail })
    expect(v.next).toContain('Example is not signed in for it')
    expect(v.ask).toContain('Could you sign it in?')
  })

  it('failing: runtime missing or too old (the person installs or updates it), runs failing while connected, the server’s own words, anything else (`doctor`)', () => {
    expect(judged({ listener: listener({ daemon: { kind: 'start_failure', detail: 'runtime (x) not ready: x CLI not found on PATH (spawn x ENOENT)' } }) })).toMatchObject({
      state: 'listener_failing',
      needs_person: true,
      command: `${INV} daemon install`,
    })
    expect(judged({ listener: listener({ daemon: { kind: 'start_failure', detail: '1.0.0; AgentChat requires X >= 2.0.0' } }) }).ask).toMatch(/newer Example/)
    const runs = judged({ listener: listener({ daemon: { kind: 'ready', runsFailing: { reason: 'x checks out now, but runs still fail', since: '2026-11-28T11:00:00.000Z' }, runtimeCheckFailing: true } }) })
    expect(runs).toMatchObject({ state: 'listener_failing', needs_person: true })
    expect(runs.next).toContain('usage limit or a provider outage')
    const server = { state: 'failing', via: 'socket', problemKind: 'listener_runs_failing', problemText: 'Your Example listener is connected, but your runs fail.', text: 't' }
    const said = judged({ server: { kind: 'ok', handle: 'demo-agent', reachability: server } })
    expect(said).toMatchObject({ state: 'listener_failing', next: `Your Example listener is connected, but your runs fail. Then run \`${INV} status\`.`, needs_person: true, command: `${INV} status` })
    expect(said.ask).toContain('Your Example listener is connected, but your runs fail.')
    expect(judged({ listener: listener({ daemon: { kind: 'start_failure', detail: 'not connecting yet: fetch failed' } }) })).toMatchObject({ state: 'listener_failing', command: `${INV} doctor`, needs_person: false })
    expect(judged({ listener: listener({ daemon: { kind: 'unservable', reason: 'runs_failing', detail: 'runs failing: x: x is not signed in' } }) }).needs_person).toBe(true)
  })

  it('the runtime’s own words come first: signed out stays signed out even when the model check failed too', () => {
    const v = judged({ listener: listener({ daemon: { kind: 'ready', runsFailing: { reason: 'x: x is not signed in (run `x` once and sign in)', since: 's' }, runtimeCheckFailing: true } }) })
    expect(v.next).toContain('is not signed in for it')
    expect(v.next).not.toContain('usage limit')
  })

  it('a home that gave the agent up holds no socket: never said to be connected', () => {
    const v = judged({ listener: listener({ daemon: { kind: 'unservable', reason: 'runs_failing', detail: 'runs failing: x checks out now, but runs still fail' } }) })
    expect(v.state).toBe('listener_failing')
    expect(v.next).not.toContain('is connected')
    expect(v.command).toBe(`${INV} doctor`)
  })

  it('a key only in the environment: the listener cannot see it — save it in the home', () => {
    const v = judged({ identity: { handle: null, source: 'env' }, server: { kind: 'ok', handle: 'demo-agent', reachability: null } })
    expect(v.state).toBe('listener_failing')
    expect(v.command).toBe(`printenv AGENTCHAT_API_KEY | ${INV} login --api-key -`)
  })
})

describe('newerRelease', () => {
  it('compares slot by slot, numerically; unreadable is never newer', () => {
    expect(newerRelease('0.10.0', '0.9.9')).toBe(true)
    expect(newerRelease('0.7.8211111', '0.7.9')).toBe(true)
    expect(newerRelease('0.8.0', '0.8.0')).toBe(false)
    expect(newerRelease('0.7.3', '0.8.0')).toBe(false)
    expect(newerRelease(null, '0.8.0')).toBe(false)
    expect(newerRelease('x', '0.8.0')).toBe(false)
  })
})

describe('reachability, read loosely', () => {
  it('reads the fields it uses and ignores the rest; absent or another shape is none', () => {
    expect(reachabilityOf({ handle: 'a', reachability: { version: 1, state: 'ready', via: 'socket', last_alive_at: null, problem: null, wake_link_pending_until: null, text: 't', future: 1 } })).toEqual({
      state: 'ready',
      via: 'socket',
      problemKind: null,
      problemText: null,
      text: 't',
    })
    expect(reachabilityOf({ handle: 'a' })).toBeNull()
    expect(reachabilityOf({ handle: 'a', reachability: 'ready' })).toBeNull()
    expect(reachabilityOf({ handle: 'a', reachability: { via: 'socket' } })).toBeNull()
    expect(reachabilityOf(null)).toBeNull()
  })
})

// ─── The listener's own files ───────────────────────────────────────────────

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-setup-'))
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

function status(over: Partial<IntegrationStatus> = {}): IntegrationStatus {
  return {
    version: 2,
    updated_at: new Date().toISOString(),
    pid: process.pid,
    runtime: 'x',
    handle: 'demo-agent',
    profile: 'own',
    socket: 'ready',
    wakes: 0,
    wakes_absorbed: 0,
    invites: 0,
    runs_started: 0,
    runs_ok: 0,
    runs_failed: 0,
    runs_timed_out: 0,
    runs_not_started: 0,
    runs_skipped_empty: 0,
    last_run: null,
    retry_rung: 0,
    retry_due_at: null,
    last_error: null,
    texts: null,
    ...over,
  }
}

/** The home's lease as a live daemon holds it: this process's pid, renewed now. */
function liveLease(): void {
  fs.writeFileSync(path.join(home, DAEMON_LOCK_FILE), `${process.pid}\n${JSON.stringify({ pid: process.pid, token: 't', host: os.hostname(), renewed_at: Date.now() })}\n`)
}

function signedIn(): void {
  writeCredentials(home, { api_key: `ac_${'k'.repeat(32)}`, handle: 'demo-agent' })
}

/** Set a file's mtime this many ms in the past. */
function aged(file: string, ms: number): void {
  const t = new Date(Date.now() - ms)
  fs.utimesSync(file, t, t)
}

describe('readListener', () => {
  it('nothing registered: not wanted, nothing said, no daemon', () => {
    signedIn()
    expect(readListener(home, 'demo-agent')).toMatchObject({ optedOut: false, wanted: false, installedVersion: null, daemon: { kind: 'none' }, alive: false })
  })

  it('connected: a fresh status for this key and handle, the markers, the version', () => {
    signedIn()
    markAlwaysOnWanted(home)
    markAlwaysOnInstalledVersion(home, '0.8.0')
    writeIntegrationStatus(home, status())
    liveLease()
    expect(readListener(home, 'demo-agent')).toMatchObject({ wanted: true, installedVersion: '0.8.0', daemon: { kind: 'ready', runsFailing: null }, alive: true })
  })

  it('a status for another handle, or one written before the key was saved, is not this key’s word', () => {
    writeIntegrationStatus(home, status({ handle: 'other-agent' }))
    signedIn()
    expect(readListener(home, 'demo-agent').daemon).toEqual({ kind: 'none' })
    writeIntegrationStatus(home, status({ updated_at: new Date(Date.now() - 5_000).toISOString() }))
    expect(readListener(home, 'demo-agent').daemon).toEqual({ kind: 'none' })
  })

  it('a start failure written once and gone stale still counts while the daemon holds its lease (it retries, it is not down)', () => {
    signedIn()
    aged(path.join(home, 'credentials'), 20 * 60_000)
    const failure = 'runtime (x) not ready: x is not signed in (run `x` once and sign in)'
    writeIntegrationStatus(home, status({ socket: 'idle', last_error: failure, updated_at: new Date(Date.now() - 10 * 60_000).toISOString() }))
    expect(readListener(home, 'demo-agent').daemon).toEqual({ kind: 'none' })
    liveLease()
    expect(readListener(home, 'demo-agent').daemon).toEqual({ kind: 'start_failure', detail: failure })
  })

  it('a "ready" from a process that is gone (no lease) is nothing said; so is one written before the service was registered again', () => {
    signedIn()
    writeIntegrationStatus(home, status())
    expect(readListener(home, 'demo-agent').daemon).toEqual({ kind: 'none' })
    liveLease()
    expect(readListener(home, 'demo-agent').daemon.kind).toBe('ready')
    expect(readListener(home, 'demo-agent', { replacedPid: process.pid }).daemon).toEqual({ kind: 'none' })
    expect(readListener(home, 'demo-agent', { replacedPid: process.pid + 1 }).daemon.kind).toBe('ready')
  })

  it('the same key saved again: the daemon had nothing to follow, so its last word (from before the save) stands once it had time to', () => {
    writeCredentials(home, { api_key: `ac_${'k'.repeat(32)}`, handle: 'demo-agent' })
    const failure = 'runtime (x) not ready: x is not signed in (run `x` once and sign in)'
    writeIntegrationStatus(home, status({ socket: 'idle', last_error: failure, updated_at: new Date(Date.now() - 60_000).toISOString() }))
    liveLease()
    aged(path.join(home, 'credentials'), 20_000)
    expect(readListener(home, 'demo-agent').daemon).toEqual({ kind: 'start_failure', detail: failure })
    // Right after the save, it may still follow a change: not yet its word.
    aged(path.join(home, 'credentials'), 1_000)
    expect(readListener(home, 'demo-agent').daemon).toEqual({ kind: 'none' })
  })

  it('an old "ready" is a daemon that stopped writing: nothing said', () => {
    signedIn()
    aged(path.join(home, 'credentials'), 20 * 60_000)
    writeIntegrationStatus(home, status({ updated_at: new Date(Date.now() - 10 * 60_000).toISOString() }))
    liveLease()
    expect(readListener(home, 'demo-agent').daemon).toEqual({ kind: 'none' })
  })

  it('standby, unservable, off, blocked and connecting, as the daemon wrote them', () => {
    signedIn()
    const cases: Array<[Partial<IntegrationStatus>, string]> = [
      [{ socket: 'idle', standby: { home: '/h', pid: 7, since: null } }, 'none'],
      [{ socket: 'idle', unservable: { reason: 'runs_failing', detail: 'd', since: 's', retry_at: 'r' } }, 'unservable'],
      [{ socket: 'off' }, 'off'],
      [{ socket: 'blocked', last_error: 'auth rejected' }, 'blocked'],
      [{ socket: 'reconnecting' }, 'connecting'],
      [{ socket: 'idle' }, 'connecting'],
    ]
    for (const [over, kind] of cases) {
      writeIntegrationStatus(home, status(over))
      expect(readListener(home, 'demo-agent').daemon.kind, kind).toBe(kind)
    }
    // A standby is a daemon that is running: with its lease, it is said.
    liveLease()
    writeIntegrationStatus(home, status({ socket: 'idle', standby: { home: '/h', pid: 7, since: null } }))
    expect(readListener(home, 'demo-agent').daemon.kind).toBe('standby')
  })

  it('the start-up grace: a key saved or a service registered moments ago', () => {
    signedIn()
    expect(readListener(home, 'demo-agent').withinGrace).toBe(true)
    aged(path.join(home, 'credentials'), 10 * 60_000)
    expect(readListener(home, 'demo-agent').withinGrace).toBe(false)
    markAlwaysOnWanted(home)
    expect(readListener(home, 'demo-agent').withinGrace).toBe(true)
  })

  it('the person’s opt-out', () => {
    markAlwaysOnOptOut(home)
    expect(readListener(home, null).optedOut).toBe(true)
  })
})

// ─── The runtime's reasons, in the server's words ───────────────────────────

describe('listenerReasonKindOf reads the presets’ own words', () => {
  const originalPath = process.env['PATH']
  const originalLoggedOut = process.env['FAKE_RUNTIME_LOGGED_OUT']
  afterEach(() => {
    process.env['PATH'] = originalPath
    if (originalLoggedOut === undefined) delete process.env['FAKE_RUNTIME_LOGGED_OUT']
    else process.env['FAKE_RUNTIME_LOGGED_OUT'] = originalLoggedOut
  })

  function onPath(binDir: string): void {
    process.env['PATH'] = `${binDir}${path.delimiter}${originalPath ?? ''}`
  }

  it('a runtime that is signed out (Claude Code, Codex) is not_signed_in; the Codex check now names `codex login`', async () => {
    const claude = installFakeClaude(path.join(home, 'c'))
    onPath(claude.binDir)
    process.env['FAKE_RUNTIME_LOGGED_OUT'] = '1'
    const claudePre = await new ClaudeRunner({ configDir: path.join(home, '.claude'), workdir: path.join(home, 'w'), profile: 'own', denyReadPaths: [home] }).preflight()
    expect(claudePre.ok).toBe(false)
    expect(listenerReasonKindOf(claudePre.detail ?? '')).toBe('not_signed_in')

    const codex = installFakeCodex(path.join(home, 'x'))
    onPath(codex.binDir)
    const codexPre = await new CodexRunner({ codexHome: path.join(home, '.codex'), workdir: path.join(home, 'w2'), profile: 'own', apiKey: () => null, keyEnv: 'AGENTCHAT_TEST_KEY' }).preflight()
    expect(codexPre.ok).toBe(false)
    expect(codexPre.detail).toMatch(/login status failed/)
    expect(codexPre.detail).toContain('`codex login`')
    expect(listenerReasonKindOf(codexPre.detail ?? '')).toBe('not_signed_in')
  }, 30_000)

  it('a runtime that is not there is runtime_missing; one too old is runtime_outdated', async () => {
    const missing = await inspectClaudeRuntime(path.join(home, '.claude'), 'agentchat-no-such-runtime')
    expect(missing.ok).toBe(false)
    expect(listenerReasonKindOf(missing.detail)).toBe('runtime_missing')
    // A `claude` that answers an old version.
    const bin = path.join(home, 'old-bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'claude'), "#!/usr/bin/env node\nconsole.log('2.0.0 (Claude Code)')\n", { mode: 0o755 })
    fs.writeFileSync(path.join(bin, 'claude.cmd'), '@echo off\r\nnode "%~dp0claude" %*\r\n')
    onPath(bin)
    const old = await inspectClaudeRuntime(path.join(home, '.claude'))
    expect(old.ok).toBe(false)
    expect(listenerReasonKindOf(old.detail)).toBe('runtime_outdated')
  }, 30_000)

  it('a failed runtime check is runtime_check_failed; anything else is other — the words are exactly the server’s enum', () => {
    expect(listenerReasonKindOf('claude runtime check failed: exit 1: API Error')).toBe('runtime_check_failed')
    expect(listenerReasonKindOf('not connecting yet: fetch failed')).toBe('other')
    expect(listenerReasonKindOf('')).toBe('other')
  })
})
