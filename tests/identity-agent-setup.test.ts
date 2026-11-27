import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentChatClient, SuspendedError } from 'agentchatme'
import { createIdentityCommands, type IdentityCommandOptions } from '../src/identity/commands.js'
import { renderAnchorBlock } from '../src/anchor/block.js'
import { readCredentials, writeCredentials, writePending } from '../src/identity/credentials.js'
import type { HostProfile, ListenerEnsure, PlacementProblem } from '../src/identity/host-profile.js'
import { markAlwaysOnInstalledVersion, markAlwaysOnOptOut, markAlwaysOnWanted } from '../src/daemon/health.js'
import { DAEMON_LOCK_FILE } from '../src/daemon/leader-lock.js'
import { writeIntegrationStatus, type IntegrationStatus } from '../src/integration/status.js'
import { mockServedTexts } from './helpers/served-texts.js'
import { fakeKey, me, recovered, registered, signupServer } from './helpers/signup-server.js'

// ─── Every account command leaves a listening agent, and says so ────────────
//
// register (code leg), recover (code leg) and login place the key, the tools
// and the identity line (`place`), then the host's listener
// (`ensureListener`), wait a bounded time for it to connect, and end with the
// setup verdict. The daemon here is simulated: `ensureListener` registers it
// the way a host's service plumbing does (the markers) and a timer writes
// what a real daemon writes once it follows the key (its status file and its
// lease). No service manager is touched.

const INVOKE = 'npx -y @agentchatme/example'
const homes: string[] = []

interface Fixture {
  home: string
  calls: string[]
  commands: ReturnType<typeof createIdentityCommands>
}

interface FixtureOptions {
  /** What the host's `ensureListener` does; absent: the host has none (a CLI-like front door). */
  ensure?: ((home: string) => ListenerEnsure) | null
  /** A placement problem `place` reports. */
  problem?: PlacementProblem | null
  /** `place` returns bare lines (an older host). */
  bareLines?: boolean
  options?: IdentityCommandOptions
}

function fixture(o: FixtureOptions = {}): Fixture {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-agent-setup-'))
  homes.push(home)
  const calls: string[] = []
  const ensure = o.ensure === undefined ? registerListener : o.ensure
  const profile: HostProfile = {
    label: 'Example',
    id: 'example',
    client: { runtime: 'generic', version: '0.8.0' },
    home: () => home,
    anchorFile: () => path.join(home, 'ANCHOR.md'),
    invocation: () => INVOKE,
    renderAnchor: renderAnchorBlock,
    place: async (handle) => {
      calls.push('place')
      const lines = [`  placed: tools and identity line for @${handle}`]
      return o.bareLines === true ? lines : { lines, problem: o.problem ?? null }
    },
    ...(ensure === null
      ? {}
      : {
          ensureListener: () => {
            calls.push('ensure')
            return ensure(home)
          },
        }),
  }
  return { home, calls, commands: createIdentityCommands(profile, { setupWaitMs: 2_000, setupPollMs: 20, serviceDryRun: false, ...o.options }) }
}

/** What a host's `ensureListener` leaves when it registers the service: the markers. */
function registerListener(home: string): ListenerEnsure {
  markAlwaysOnWanted(home)
  markAlwaysOnInstalledVersion(home, '0.8.0')
  return { outcome: 'installed', detail: 'agentchatd-example' }
}

function status(handle: string, over: Partial<IntegrationStatus> = {}): IntegrationStatus {
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
    ...over,
  }
}

/** A host's `ensureListener` whose service then starts and follows the key, as a real one does. */
const registerAndFollow =
  (handle: string, over: Partial<IntegrationStatus> = {}) =>
  (home: string): ListenerEnsure => {
    const ensured = registerListener(home)
    daemonFollows(home, handle, 30, over)
    return ensured
  }

/** A daemon that follows the new key after `afterMs`: it takes the home's lease and writes its status. */
function daemonFollows(home: string, handle: string, afterMs = 150, over: Partial<IntegrationStatus> = {}): void {
  setTimeout(() => {
    fs.writeFileSync(path.join(home, DAEMON_LOCK_FILE), `${process.pid}\n${JSON.stringify({ pid: process.pid, token: 't', host: os.hostname(), renewed_at: Date.now() })}\n`)
    writeIntegrationStatus(home, status(handle, over))
  }, afterMs)
}

function capture(): { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  vi.spyOn(console, 'log').mockImplementation((v) => out.push(String(v)))
  vi.spyOn(console, 'error').mockImplementation((v) => err.push(String(v)))
  return { out, err }
}

const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin')
const originalStdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
beforeEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (originalStdin) Object.defineProperty(process, 'stdin', originalStdin)
  if (originalStdinTty) Object.defineProperty(process.stdin, 'isTTY', originalStdinTty)
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

/** The key piped in on stdin, as `login --api-key - < <file>` gives it. */
function keyOnStdin(key: string): void {
  Object.defineProperty(process, 'stdin', { value: Readable.from([`${key}\n`]), configurable: true })
}

const last = (lines: string[]): string => lines[lines.length - 1] ?? ''

describe('login leaves a listening agent', () => {
  it('places, then registers the listener, waits for it to connect, and ends with `Setup: ready`', async () => {
    const { home, calls, commands } = fixture({ ensure: registerAndFollow('login-agent') })
    const key = fakeKey('l')
    signupServer().on('GET /v1/agents/me', me('login-agent'), me('login-agent'))
    keyOnStdin(key)
    const { out, err } = capture()

    expect(await commands.runLogin({ apiKey: '-' })).toBe(0)

    expect(calls).toEqual(['place', 'ensure'])
    const text = out.join('\n')
    expect(text).toContain('Signed in as @login-agent for Example.')
    expect(text).toContain('  listener: registered (agentchatd-example)')
    expect(text).toContain('Waiting up to 2 s for the listener to connect as @login-agent…')
    expect(text).toMatch(/ {2}listener: connected after \d+ s/)
    expect(last(out)).toBe(
      "Setup: ready — @login-agent is listening on this computer: a peer's message starts a Example run here. Last, tell the person you work with: open a new Example session to have the AgentChat tools in this chat; receiving does not need it.",
    )
    // No false claim, and the key is never printed.
    expect(text).not.toContain('follows the credential on its own')
    expect([...out, ...err].join('\n')).not.toContain(key)
    expect(readCredentials(home)?.handle).toBe('login-agent')
  })

  it('the person switched the listener off: nothing is registered or waited for, and only they can turn it back on', async () => {
    const { home, commands } = fixture({ ensure: () => ({ outcome: 'opted_out', detail: null }) })
    markAlwaysOnOptOut(home)
    signupServer().on('GET /v1/agents/me', me('login-agent'), me('login-agent'))
    keyOnStdin(fakeKey('o'))
    const { out } = capture()

    expect(await commands.runLogin({ apiKey: '-' })).toBe(0)

    const text = out.join('\n')
    expect(text).toContain('  listener: off — switched off by the person you work with')
    expect(text).not.toContain('Waiting up to')
    expect(last(out)).toMatch(/^Setup: listener_off — .* run `npx -y @agentchatme\/example daemon install`\.$/)
  })

  it('a listener that could not be registered: still exit 0 (the key is saved), and the verdict says how to retry', async () => {
    const { commands } = fixture({ ensure: () => ({ outcome: 'failed', detail: 'service install is not supported here' }) })
    signupServer().on('GET /v1/agents/me', me('login-agent'), me('login-agent'))
    keyOnStdin(fakeKey('f'))
    const { out } = capture()

    expect(await commands.runLogin({ apiKey: '-' })).toBe(0)

    expect(out.join('\n')).toContain('  listener: FAILED — service install is not supported here')
    expect(last(out)).toMatch(/^Setup: listener_missing — the listener could not be installed \(service install is not supported here\)\. Run `npx -y @agentchatme\/example daemon install` to try again/)
  })

  it('a hosted-tools problem: the listener is not registered (its runs would have no tools), and the verdict is the host’s words', async () => {
    const problem: PlacementProblem = {
      text: 'a user-scope MCP server "agentchat" that this integration did not write stands in the way. Ask the person you work with before removing it.',
      needsPerson: true,
      ask: 'May I remove your own "agentchat" MCP entry and register AgentChat’s?',
    }
    const { calls, commands } = fixture({ problem })
    signupServer().on('GET /v1/agents/me', me('login-agent'))
    keyOnStdin(fakeKey('t'))
    const { out } = capture()

    expect(await commands.runLogin({ apiKey: '-' })).toBe(0)

    expect(calls).toEqual(['place'])
    expect(out.join('\n')).toContain('  listener: not registered until the AgentChat tools are in place (below)')
    expect(last(out)).toBe(`Setup: tools_missing — ${problem.text}`)
  })

  it('the budget runs out with nothing said: the verdict is starting, with the bounded next step', async () => {
    const { commands } = fixture({ options: { setupWaitMs: 200 } })
    signupServer().on('GET /v1/agents/me', me('login-agent'), me('login-agent'))
    keyOnStdin(fakeKey('w'))
    const { out } = capture()

    expect(await commands.runLogin({ apiKey: '-' })).toBe(0)

    expect(out.join('\n')).toContain('  listener: not connected after 0 s')
    expect(last(out)).toMatch(/^Setup: listener_starting — the listener is connecting as @login-agent\. Wait 10 s, then run `npx -y @agentchatme\/example status`/)
  })

  it('the daemon stops at its runtime check: the wait ends at once, and the verdict says what only the person can do', async () => {
    const { commands } = fixture({ ensure: registerAndFollow('login-agent', { socket: 'idle', last_error: 'runtime (x) not ready: x is not signed in (run `x` once and sign in)' }) })
    signupServer().on('GET /v1/agents/me', me('login-agent'), me('login-agent'))
    keyOnStdin(fakeKey('s'))
    const { out } = capture()
    const started = Date.now()

    expect(await commands.runLogin({ apiKey: '-' })).toBe(0)

    expect(Date.now() - started).toBeLessThan(1_900)
    expect(out.join('\n')).toMatch(/ {2}listener: not connected \(after \d+ s\)/)
    expect(last(out)).toMatch(/^Setup: listener_failing — the listener for @login-agent cannot start Example runs: Example is not signed in for it/)
  })

  it('the engine itself keeps the person’s opt-out: a host’s ensure is not even called', async () => {
    const { home, calls, commands } = fixture()
    markAlwaysOnOptOut(home)
    signupServer().on('GET /v1/agents/me', me('login-agent'), me('login-agent'))
    keyOnStdin(fakeKey('g'))
    const { out } = capture()

    expect(await commands.runLogin({ apiKey: '-' })).toBe(0)

    expect(calls).toEqual(['place'])
    expect(last(out)).toMatch(/^Setup: listener_off — /)
  })

  it('a start failure the daemon retries on its own (the network) does not end the wait: it connects on the next try', async () => {
    const ensure = (home: string): ListenerEnsure => {
      const ensured = registerListener(home)
      daemonFollows(home, 'login-agent', 30, { socket: 'idle', last_error: 'not connecting yet: fetch failed' })
      daemonFollows(home, 'login-agent', 400)
      return ensured
    }
    const { commands } = fixture({ ensure })
    signupServer().on('GET /v1/agents/me', me('login-agent'), me('login-agent'))
    keyOnStdin(fakeKey('n'))
    const { out } = capture()

    expect(await commands.runLogin({ apiKey: '-' })).toBe(0)

    expect(out.join('\n')).toMatch(/ {2}listener: connected after \d+ s/)
    expect(last(out)).toMatch(/^Setup: ready — /)
  })

  it('registered again just now: what the process it replaced wrote is not the new one’s word', async () => {
    // A daemon (this process's pid, as the old one) is running and says "ready" for the new key; registering
    // the service again replaces it, and the new process says nothing within the budget.
    const ensure = (home: string): ListenerEnsure => {
      writeIntegrationStatus(home, status('login-agent'))
      return registerListener(home)
    }
    const { home, commands } = fixture({ ensure, options: { setupWaitMs: 300 } })
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, DAEMON_LOCK_FILE), `${process.pid}\n${JSON.stringify({ pid: process.pid, token: 't', host: os.hostname(), renewed_at: Date.now() })}\n`)
    signupServer().on('GET /v1/agents/me', me('login-agent'), me('login-agent'))
    keyOnStdin(fakeKey('q'))
    const { out } = capture()

    expect(await commands.runLogin({ apiKey: '-' })).toBe(0)

    expect(last(out)).toMatch(/^Setup: listener_starting — /)
  })

  it('under a dry run (no service manager), nothing is waited for', async () => {
    const { commands } = fixture({ options: { serviceDryRun: true } })
    signupServer().on('GET /v1/agents/me', me('login-agent'), me('login-agent'))
    keyOnStdin(fakeKey('d'))
    const { out } = capture()

    expect(await commands.runLogin({ apiKey: '-' })).toBe(0)

    expect(out.join('\n')).not.toContain('Waiting up to')
    expect(last(out)).toMatch(/^Setup: listener_starting — /)
  })

  it('AgentChat sees the connection only after a moment: it is asked again before the verdict', async () => {
    const { commands } = fixture({ ensure: registerAndFollow('login-agent') })
    const notYet = { status: 200, body: { handle: 'login-agent', status: 'active', reachability: { version: 1, state: 'none', via: null, last_alive_at: null, problem: null, wake_link_pending_until: null, text: 'none' } } }
    const ready = { status: 200, body: { handle: 'login-agent', status: 'active', reachability: { version: 1, state: 'ready', via: 'socket', last_alive_at: null, problem: null, wake_link_pending_until: null, text: 'ready' } } }
    signupServer().on('GET /v1/agents/me', me('login-agent'), notYet, ready)
    keyOnStdin(fakeKey('r'))
    const { out } = capture()

    expect(await commands.runLogin({ apiKey: '-' })).toBe(0)

    expect(last(out)).toMatch(/^Setup: ready — /)
  })
})

describe('register and recover, on their code leg, end the same way', () => {
  it('register --code: the key saved, placed, the listener registered and connected, `Setup: ready` last', async () => {
    const { home, calls, commands } = fixture({ ensure: registerAndFollow('new-agent') })
    writePending(home, {
      kind: 'register',
      flow: { version: 1, flow: 'register', next_step: 'verify', status: 'pending', pending_id: 'pnd_1', code_length: 6 },
      received_at: new Date().toISOString(),
      email: 'owner@example.com',
      handle: 'new-agent',
    })
    signupServer().on('POST /v1/register/verify', registered('new-agent', fakeKey('n'))).on('GET /v1/agents/me', me('new-agent'))
    const { out } = capture()

    expect(await commands.runRegister({ code: '123456' })).toBe(0)

    expect(calls).toEqual(['place', 'ensure'])
    expect(out.join('\n')).toContain('This handle belongs to your Example agent.')
    expect(last(out)).toMatch(/^Setup: ready — @new-agent is listening on this computer/)
  })

  it('recover --code: the same, for the new key', async () => {
    const { home, calls, commands } = fixture({ ensure: registerAndFollow('my-agent') })
    writePending(home, {
      kind: 'recover',
      flow: { version: 1, flow: 'recover', next_step: 'recover_verify', status: 'pending', pending_id: 'pnd_r', code_length: 6 },
      received_at: new Date().toISOString(),
      email: 'owner@example.com',
      handle: 'my-agent',
    })
    signupServer().on('POST /v1/agents/recover/verify', recovered('my-agent', fakeKey('v'))).on('GET /v1/agents/me', me('my-agent'))
    const { out } = capture()

    expect(await commands.runRecover({ code: '123456' })).toBe(0)

    expect(calls).toEqual(['place', 'ensure'])
    expect(out.join('\n')).toContain('Your old API key no longer works.')
    expect(last(out)).toMatch(/^Setup: ready — @my-agent is listening on this computer/)
  })
})

describe('a host with no listener of its own (the CLI front door)', () => {
  it('login says the one session hint, no listener line, no wait, no verdict once the key works', async () => {
    const { calls, commands } = fixture({ ensure: null, bareLines: true })
    const server = signupServer().on('GET /v1/agents/me', me('cli-agent'))
    keyOnStdin(fakeKey('c'))
    const { out } = capture()

    expect(await commands.runLogin({ apiKey: '-' })).toBe(0)

    expect(calls).toEqual(['place'])
    expect(server.calls).toHaveLength(1)
    const text = out.join('\n')
    expect(text.split('\n').pop()).toBe('Open a new session for the hosted AgentChat tools to pick up the key.')
    expect(text).not.toMatch(/listener|Setup:|follows the credential/)
  })
})

describe('doctor --fix places the listener; doctor alone never does', () => {
  it('registers it once with --fix (said when it did something), not at all without', async () => {
    const { home, calls, commands } = fixture()
    writeCredentials(home, { api_key: fakeKey('d'), handle: 'probe' })
    mockServedTexts('probe')
    vi.spyOn(AgentChatClient.prototype, 'getMe').mockResolvedValue({ handle: 'probe', status: 'active' } as never)
    const { out } = capture()

    await commands.runDoctor()
    expect(calls).not.toContain('ensure')

    await commands.runDoctor({ fix: true })
    expect(calls.filter((c) => c === 'ensure')).toHaveLength(1)
    expect(out.join('\n')).toContain('PASS listener: registered (agentchatd-example)')
  })

  it('a listener that cannot be registered fails doctor --fix, with the retry', async () => {
    const { home, commands } = fixture({ ensure: () => ({ outcome: 'failed', detail: 'nope' }) })
    writeCredentials(home, { api_key: fakeKey('e'), handle: 'probe' })
    mockServedTexts('probe')
    vi.spyOn(AgentChatClient.prototype, 'getMe').mockResolvedValue({ handle: 'probe', status: 'active' } as never)
    const { out } = capture()

    expect(await commands.runDoctor({ fix: true })).toBe(1)
    expect(out.join('\n')).toContain('FAIL listener: could not be registered: nope — `npx -y @agentchatme/example daemon install` tries again')
  })
})

describe('status says the verdict first, and as `.setup`', () => {
  it('signed in and connected: `Setup: ready` is the first line; `--json` carries the same verdict', async () => {
    const { home, commands } = fixture()
    writeCredentials(home, { api_key: fakeKey('a'), handle: 'probe' })
    registerListener(home)
    daemonFollows(home, 'probe', 0)
    mockServedTexts('probe')
    vi.spyOn(AgentChatClient.prototype, 'getMe').mockResolvedValue({ handle: 'probe', status: 'active' } as never)
    await new Promise((r) => setTimeout(r, 30))
    const { out } = capture()

    expect(await commands.runStatus({})).toBe(0)
    expect(out.join('\n').split('\n')[0]).toBe(
      "Setup: ready — @probe is listening on this computer: a peer's message starts a Example run here. A new Example session has the AgentChat tools in its chat; receiving does not need one.",
    )

    expect(await commands.runStatus({ json: true })).toBe(0)
    const parsed = JSON.parse(last(out)) as { setup: Record<string, unknown> }
    expect(parsed.setup).toEqual({
      state: 'ready',
      next: "@probe is listening on this computer: a peer's message starts a Example run here. A new Example session has the AgentChat tools in its chat; receiving does not need one.",
      command: null,
      needs_person: false,
      ask: null,
      detail: null,
    })
  })

  it('signed in, nothing listening (the deaf path before this release): listener_missing, with the install command', async () => {
    const { home, commands } = fixture()
    writeCredentials(home, { api_key: fakeKey('b'), handle: 'probe' })
    mockServedTexts('probe')
    vi.spyOn(AgentChatClient.prototype, 'getMe').mockResolvedValue({ handle: 'probe', status: 'active' } as never)
    const { out } = capture()

    expect(await commands.runStatus({})).toBe(0)
    expect(out.join('\n').split('\n')[0]).toBe(
      'Setup: listener_missing — nothing on this computer listens for @probe, so a peer\'s message cannot start a run here. Run `npx -y @agentchatme/example` to install the listener.',
    )
  })

  it('no account: the register command, with flags, not a bare `register`', async () => {
    const { commands } = fixture()
    const { out } = capture()
    expect(await commands.runStatus({})).toBe(0)
    expect(out[0]).toMatch(/^Setup: no_account — .*`npx -y @agentchatme\/example register --email <email> --handle <handle>`/)
    expect(out[0]).not.toMatch(/register`$|register$/)
    expect(await commands.runStatus({ json: true })).toBe(0)
    expect((JSON.parse(last(out)) as { setup: { state: string } }).setup.state).toBe('no_account')
  })

  it('a suspended account (403 SUSPENDED): no recovery advice, support@agentchat.me', async () => {
    const { home, commands } = fixture()
    writeCredentials(home, { api_key: fakeKey('u'), handle: 'probe' })
    vi.spyOn(AgentChatClient.prototype, 'getMe').mockRejectedValue(new SuspendedError({ code: 'SUSPENDED', message: 'Account suspended' }, 403))
    const { out } = capture()

    expect(await commands.runStatus({})).toBe(1)
    expect(out[0]).toMatch(/^Setup: suspended — AgentChat has suspended @probe \(SUSPENDED: Account suspended\)/)
    expect(out[0]).toContain('support@agentchat.me')
    expect(out[0]).not.toMatch(/recover --/)
  })

  it('a host whose status checks name a tools problem: `tools_missing` in its words, first', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-agent-setup-'))
    homes.push(home)
    writeCredentials(home, { api_key: fakeKey('m'), handle: 'probe' })
    const profile: HostProfile = {
      label: 'Example',
      id: 'example',
      client: { runtime: 'generic', version: '0.8.0' },
      home: () => home,
      invocation: () => INVOKE,
      renderAnchor: renderAnchorBlock,
      ensureListener: () => registerListener(home),
      extraStatus: () => ({ lines: ['Placement:', '  ✗ mcp: not ours'], problem: { text: 'the tools are not registered. Run `x doctor --fix`.' } }),
    }
    mockServedTexts('probe')
    vi.spyOn(AgentChatClient.prototype, 'getMe').mockResolvedValue({ handle: 'probe', status: 'active' } as never)
    const { out } = capture()

    expect(await createIdentityCommands(profile).runStatus({})).toBe(0)
    const lines = out.join('\n').split('\n')
    expect(lines[0]).toBe('Setup: tools_missing — the tools are not registered. Run `x doctor --fix`.')
    expect(lines).toContain('  ✗ mcp: not ours')
  })
})

describe('install’s last line (confirmSetup)', () => {
  it('without an account: the no_account verdict, nothing waited for', async () => {
    const { commands } = fixture()
    const { out } = capture()
    const verdict = await commands.confirmSetup({ ensure: { outcome: 'installed', detail: 'svc' } })
    expect(verdict?.state).toBe('no_account')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatch(/^Setup: no_account — /)
  })

  it('with an account and the listener registered: waits, then says ready', async () => {
    const { home, commands } = fixture()
    writeCredentials(home, { api_key: fakeKey('i'), handle: 'probe' })
    registerListener(home)
    vi.spyOn(AgentChatClient.prototype, 'getMe').mockResolvedValue({ handle: 'probe', status: 'active' } as never)
    setTimeout(() => daemonFollows(home, 'probe', 0), 50)
    const { out } = capture()

    const verdict = await commands.confirmSetup({ ensure: { outcome: 'installed', detail: 'svc' } })
    expect(verdict?.state).toBe('ready')
    expect(last(out)).toMatch(/^Setup: ready — @probe is listening on this computer: a peer's message starts a Example run here\. A new Example session/)
  })
})
