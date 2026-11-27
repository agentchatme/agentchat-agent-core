import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIdentityCommands } from '../src/identity/commands.js'
import { renderAnchorBlock } from '../src/anchor/block.js'
import { credentialsPath, pendingPath, readCredentials, readPending, writeCredentials, writePending } from '../src/identity/credentials.js'
import type { HostProfile } from '../src/identity/host-profile.js'
import {
  askParam,
  attemptsExhausted,
  codeSent,
  expired,
  fakeKey,
  recovered,
  registered,
  serverError,
  signupServer,
  tooSoon,
  wrongCode,
} from './helpers/signup-server.js'

// ─── Sign-up follows the server's answer, one step per run ──────────────────
//
// Every run prints the server's sentence as it is and, for the next step, the
// exact command under this integration's name. Which command is the SDK's
// action rule (`integration.account`), read from the server's flow object;
// nothing here knows a code, a limit or a wording of its own. The flow the
// server answered is kept in pending.json between the runs.

const INVOKE = 'npx -y @agentchatme/example'
const homes: string[] = []

function fixture(): { home: string; commands: ReturnType<typeof createIdentityCommands> } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-signup-'))
  homes.push(home)
  const profile: HostProfile = {
    label: 'Example',
    id: 'example',
    client: { runtime: 'generic', version: '0.0.0-test' },
    home: () => home,
    anchorFile: () => path.join(home, 'ANCHOR.md'),
    invocation: () => INVOKE,
    renderAnchor: renderAnchorBlock,
    isWired: () => false,
  }
  return { home, commands: createIdentityCommands(profile) }
}

interface Captured {
  out: string[]
  err: string[]
  /** stdout and stderr in the order printed. */
  all: string[]
}

function capture(): Captured {
  const captured: Captured = { out: [], err: [], all: [] }
  vi.spyOn(console, 'log').mockImplementation((value) => {
    captured.out.push(String(value))
    captured.all.push(String(value))
  })
  vi.spyOn(console, 'error').mockImplementation((value) => {
    captured.err.push(String(value))
    captured.all.push(String(value))
  })
  return captured
}

const text = (lines: string[]): string => lines.join('\n')

const SENT_REGISTER = 'We sent a 6-digit code to owner@example.com. It expires in 10 minutes.'
const SENT_RECOVER = 'If @my-agent is registered with owner@example.com, we sent a 6-digit code there. It expires in 10 minutes.'

const originalStdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
const originalStdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

beforeEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  if (originalStdinTty) Object.defineProperty(process.stdin, 'isTTY', originalStdinTty)
  if (originalStdoutTty) Object.defineProperty(process.stdout, 'isTTY', originalStdoutTty)
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

/** Minutes ago, as an ISO time: when the code's answer arrived. */
const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString()

/** A pending registration of `owner@example.com` / `new-agent`, as `register --email --handle` leaves it. */
function pendingRegistration(home: string, extra: Partial<Parameters<typeof writePending>[1]> = {}): void {
  writePending(home, {
    kind: 'register',
    flow: {
      version: 1,
      flow: 'register',
      next_step: 'verify',
      status: 'pending',
      pending_id: 'pnd_live',
      expires_in_s: 600,
      code_length: 6,
      resend_after_s: 60,
    },
    received_at: new Date().toISOString(),
    email: 'owner@example.com',
    handle: 'new-agent',
    ...extra,
  })
}

function pendingRecovery(home: string, handle: string | null = 'my-agent', receivedAgoMs = 0): void {
  writePending(home, {
    kind: 'recover',
    flow: {
      version: 1,
      flow: 'recover',
      next_step: 'recover_verify',
      status: 'pending',
      pending_id: 'pnd_recover',
      expires_in_s: 600,
      code_length: 6,
      resend_after_s: 60,
    },
    received_at: new Date(Date.now() - receivedAgoMs).toISOString(),
    email: 'owner@example.com',
    ...(handle !== null ? { handle } : {}),
  })
}

// ─── register ───────────────────────────────────────────────────────────────

describe('register: asking for a code', () => {
  it('sends email and handle once, keeps the server’s flow, prints its sentence and the code command', async () => {
    const { home, commands } = fixture()
    const server = signupServer().on('POST /v1/register', codeSent('register', 'pnd_1', SENT_REGISTER))
    const { out, err } = capture()

    expect(await commands.runRegister({ email: 'Owner@Example.com', handle: '@New-Agent' })).toBe(0)

    expect(server.calls).toHaveLength(1)
    expect(server.calls[0]).toMatchObject({ method: 'POST', path: '/v1/register', body: { email: 'owner@example.com', handle: 'new-agent' } })
    expect(server.calls[0]?.headers['x-agentchat-client']).toBe('generic')
    // The server's sentence, then the setup verdict for this step: it names the code command.
    const lines = text(out).split('\n')
    expect(lines[0]).toBe(SENT_REGISTER)
    expect(lines[1]).toMatch(/^Setup: code_pending — a registration of @new-agent is waiting on the 6-digit code AgentChat emailed to owner@example\.com; it expires in 10 minutes\./)
    expect(lines[1]).toContain(`Run \`${INVOKE} register --code <6 digits>\` with it. If you cannot read that inbox, ask the person you work with for the code.`)
    expect(lines).toHaveLength(2)
    expect(err).toEqual([])
    const pending = readPending(home)
    expect(pending).toMatchObject({
      kind: 'register',
      email: 'owner@example.com',
      handle: 'new-agent',
      flow: { next_step: 'verify', pending_id: 'pnd_1', expires_in_s: 600, resend_after_s: 60, code_length: 6 },
    })
    expect(Date.now() - Date.parse(pending!.received_at)).toBeLessThan(5_000)
    if (process.platform !== 'win32') expect(fs.statSync(pendingPath(home)).mode & 0o777).toBe(0o600)
  })

  it('without --handle and no terminal it names the flag and calls nothing', async () => {
    const { commands } = fixture()
    const server = signupServer()
    const { err } = capture()

    expect(await commands.runRegister({ email: 'owner@example.com' })).toBe(1)

    expect(server.calls).toEqual([])
    expect(text(err)).toContain(`Missing --handle. Usage: ${INVOKE} register --email <email> --handle <handle>`)
  })

  it('a taken handle: the server’s sentence, then the same command with the handle left to fill in', async () => {
    const { home, commands } = fixture()
    signupServer().on('POST /v1/register', askParam('register', 409, 'HANDLE_TAKEN', 'The handle @new-agent is taken. Try another.', 'handle'))
    const { out, err } = capture()

    expect(await commands.runRegister({ email: 'owner@example.com', handle: 'new-agent' })).toBe(1)

    expect(out).toEqual([])
    expect(text(err)).toBe(`The handle @new-agent is taken. Try another.\nRun \`${INVOKE} register --email owner@example.com --handle <handle>\``)
    expect(readPending(home)).toBeNull()
  })

  it('a handle in the wrong form goes to the server, which says what is wrong (no local rule)', async () => {
    const { commands } = fixture()
    const server = signupServer().on(
      'POST /v1/register',
      askParam('register', 400, 'VALIDATION_ERROR', 'Enter a handle of 3 to 30 characters: lowercase letters, numbers and hyphens, starting with a letter.', 'handle', {
        fieldErrors: { handle: ['bad'] },
        formErrors: [],
      }),
    )
    const { err } = capture()

    expect(await commands.runRegister({ email: 'owner@example.com', handle: 'x' })).toBe(1)

    expect(server.calls[0]?.body).toMatchObject({ handle: 'x' })
    expect(text(err)).toContain('Enter a handle of 3 to 30 characters')
    expect(text(err)).toContain(`--handle <handle>`)
  })

  it('an email in the wrong form: re-run with the email left to fill in, the handle kept', async () => {
    const { commands } = fixture()
    signupServer().on('POST /v1/register', askParam('register', 400, 'VALIDATION_ERROR', 'Enter an email address in the correct format, like name@example.com', 'email'))
    const { err } = capture()

    expect(await commands.runRegister({ email: 'not-an-email', handle: 'new-agent' })).toBe(1)

    expect(text(err)).toBe(
      `Enter an email address in the correct format, like name@example.com\nRun \`${INVOKE} register --email <email> --handle new-agent\``,
    )
  })

  it('a cooldown (429 naming register): wait the server’s seconds, then the same command', async () => {
    const { home, commands } = fixture()
    signupServer().on('POST /v1/register', tooSoon('register', 'register', 'OTP_COOLDOWN', 'You can request a new code in 42 seconds.', 42))
    const { err } = capture()

    expect(await commands.runRegister({ email: 'owner@example.com', handle: 'new-agent', displayName: 'My Agent' })).toBe(1)

    expect(text(err)).toBe(
      `You can request a new code in 42 seconds.\nWait 42 s, then run \`${INVOKE} register --email owner@example.com --handle new-agent --display-name "My Agent"\``,
    )
    expect(readPending(home)).toBeNull()
  })

  it('a cooldown while the code already sent still works also offers that code, and keeps it', async () => {
    const { home, commands } = fixture()
    pendingRegistration(home)
    signupServer().on('POST /v1/register', tooSoon('register', 'register', 'OTP_COOLDOWN', 'You can request a new code in 42 seconds.', 42))
    const { err } = capture()

    expect(await commands.runRegister({ email: 'owner@example.com', handle: 'new-agent' })).toBe(1)

    expect(text(err)).toContain(`Wait 42 s, then run \`${INVOKE} register --email owner@example.com --handle new-agent\``)
    expect(text(err)).toContain(`Or enter the code already sent: \`${INVOKE} register --code <6 digits>\``)
    expect(readPending(home)?.flow.pending_id).toBe('pnd_live')
  })

  it('a long wait (stop) shows the sentence only, or the code already sent while it works', async () => {
    const cap = tooSoon('register', 'register', 'OTP_HOURLY_CAP', 'Too many codes have been sent. Enter the last code you received, or try again in 30 minutes.', 1800)
    {
      const { commands } = fixture()
      signupServer().on('POST /v1/register', cap)
      const { err } = capture()
      expect(await commands.runRegister({ email: 'owner@example.com', handle: 'new-agent' })).toBe(1)
      expect(text(err)).toBe('Too many codes have been sent. Enter the last code you received, or try again in 30 minutes.')
      vi.restoreAllMocks()
    }
    {
      const { home, commands } = fixture()
      pendingRegistration(home)
      signupServer().on('POST /v1/register', cap)
      const { err } = capture()
      expect(await commands.runRegister({ email: 'owner@example.com', handle: 'new-agent' })).toBe(1)
      expect(text(err)).toBe(
        `Too many codes have been sent. Enter the last code you received, or try again in 30 minutes.\nOr enter the code already sent: \`${INVOKE} register --code <6 digits>\``,
      )
    }
  })

  it('the code already sent is not offered once it has expired', async () => {
    const { home, commands } = fixture()
    pendingRegistration(home, { received_at: new Date(Date.now() - 11 * 60_000).toISOString() })
    signupServer().on('POST /v1/register', tooSoon('register', 'register', 'OTP_HOURLY_CAP', 'Too many codes have been sent.', 1800))
    const { err } = capture()

    expect(await commands.runRegister({ email: 'owner@example.com', handle: 'new-agent' })).toBe(1)

    expect(text(err)).not.toContain('code already sent')
  })

  it('a failed send (5xx) shows the sentence only', async () => {
    const { commands } = fixture()
    signupServer().on('POST /v1/register', serverError('register', 'OTP_FAILED', "We couldn't send the code. Try again in a few minutes."))
    const { err } = capture()

    expect(await commands.runRegister({ email: 'owner@example.com', handle: 'new-agent' })).toBe(1)

    expect(text(err)).toBe("We couldn't send the code. Try again in a few minutes.")
  })

  it('no answer at all: says so and gives the command to run again; nothing stored', async () => {
    const { home, commands } = fixture()
    signupServer() // nothing scripted: the request fails like a network error
    const { err } = capture()

    expect(await commands.runRegister({ email: 'owner@example.com', handle: 'new-agent' })).toBe(1)

    expect(text(err)).toMatch(/^Could not reach AgentChat: /)
    expect(text(err)).toContain(`Run \`${INVOKE} register --email owner@example.com --handle new-agent\` again.`)
    expect(readPending(home)).toBeNull()
  })

  it('refuses while this agent has an identity, and while a recovery waits for its code', async () => {
    {
      const { home, commands } = fixture()
      writeCredentials(home, { api_key: fakeKey('k'), handle: 'have-one' })
      const server = signupServer()
      const { err } = capture()
      expect(await commands.runRegister({ email: 'owner@example.com', handle: 'new-agent' })).toBe(1)
      expect(server.calls).toEqual([])
      expect(text(err)).toContain(`${INVOKE} logout`)
      vi.restoreAllMocks()
    }
    {
      const { home, commands } = fixture()
      pendingRecovery(home)
      const server = signupServer()
      const { err } = capture()
      expect(await commands.runRegister({ email: 'owner@example.com', handle: 'new-agent' })).toBe(1)
      expect(server.calls).toEqual([])
      expect(text(err)).toContain(`${INVOKE} recover --code <code>`)
    }
  })
})

describe('register --code: answering it', () => {
  it('a wrong code, then the right one in a later run: the same pending id both times, the server’s handle saved', async () => {
    const { home, commands } = fixture()
    pendingRegistration(home)
    const key = fakeKey('r')
    const server = signupServer()
      .on('POST /v1/register/verify', wrongCode('register', 'pnd_live', 1))
      .on('POST /v1/register/verify', registered('server-agent', key))

    const first = capture()
    expect(await commands.runRegister({ code: '000000' })).toBe(1)
    expect(text(first.err)).toBe(`That code didn't work. Check the code and try again.\nRun \`${INVOKE} register --code <6 digits>\``)
    expect(readCredentials(home)).toBeNull()
    expect(readPending(home)?.flow).toMatchObject({ pending_id: 'pnd_live', attempts: 1, expires_in_s: 580 })
    vi.restoreAllMocks()

    const second = capture()
    expect(await commands.runRegister({ code: ' 123456 ' })).toBe(0)
    expect(server.calls.map((c) => c.body)).toEqual([
      { pending_id: 'pnd_live', code: '000000' },
      { pending_id: 'pnd_live', code: '123456' },
    ])
    // The handle typed was new-agent; the server's answer is what is saved.
    expect(readCredentials(home)).toMatchObject({ api_key: key, handle: 'server-agent' })
    expect(readPending(home)).toBeNull()
    const rendered = text(second.out)
    expect(rendered.split('\n')[0]).toBe('Email verified. Logged in as @server-agent.')
    expect(rendered).toContain(`API key for @server-agent stored at ${credentialsPath(home)} (never commit this file).`)
    expect(rendered).toContain('Other agents can DM you at @server-agent.')
    expect(rendered).not.toContain('new-agent')
    expect(second.err).toEqual([])
  })

  it('an expired code: the command for a new code with what was sent before; the dead flow dropped', async () => {
    const { home, commands } = fixture()
    pendingRegistration(home, { display_name: 'My Agent', received_at: minutesAgo(11) })
    signupServer().on('POST /v1/register/verify', expired('register'))
    const { err } = capture()

    expect(await commands.runRegister({ code: '123456' })).toBe(1)

    expect(text(err)).toBe(
      `That code has expired. Request a new code.\nFor a new code: Run \`${INVOKE} register --email owner@example.com --handle new-agent --display-name "My Agent"\``,
    )
    expect(readPending(home)).toBeNull()
  })

  it('the resend window this answer states wins over the one the held code’s answer stated', async () => {
    const { home, commands } = fixture()
    pendingRegistration(home) // its answer said 60 s, just now
    signupServer().on('POST /v1/register/verify', attemptsExhausted('register', 0))
    const { err } = capture()

    expect(await commands.runRegister({ code: '999999' })).toBe(1)

    expect(text(err)).toContain(`For a new code: Run \`${INVOKE} register --email owner@example.com --handle new-agent\``)
  })

  it('too many wrong codes: a new code only after the server’s resend window', async () => {
    const { home, commands } = fixture()
    pendingRegistration(home, { received_at: new Date(Date.now() - 10 * 60_000 + 30_000).toISOString() })
    signupServer().on('POST /v1/register/verify', attemptsExhausted('register', 30))
    const { err } = capture()

    expect(await commands.runRegister({ code: '999999' })).toBe(1)

    expect(text(err)).toBe(
      `You entered the wrong code too many times. Request a new code.\nFor a new code: Wait 30 s, then run \`${INVOKE} register --email owner@example.com --handle new-agent\``,
    )
    expect(readPending(home)).toBeNull()
  })

  it('a 429 that keeps the verify step: wait, then the same command with the same code; the flow kept', async () => {
    const { home, commands } = fixture()
    pendingRegistration(home)
    const before = fs.readFileSync(pendingPath(home), 'utf-8')
    signupServer().on('POST /v1/register/verify', tooSoon('register', 'verify', 'RATE_LIMITED', 'Too many attempts. Try again in 35 seconds.', 35))
    const { err } = capture()

    expect(await commands.runRegister({ code: '123456' })).toBe(1)

    expect(text(err)).toBe(`Too many attempts. Try again in 35 seconds.\nWait 35 s, then run \`${INVOKE} register --code 123456\``)
    expect(fs.readFileSync(pendingPath(home), 'utf-8')).toBe(before)
  })

  it('a 429 past the code’s life names the start step: an offer of a new code after the wait, never a retry', async () => {
    const { home, commands } = fixture()
    pendingRegistration(home, { received_at: minutesAgo(9.5) })
    signupServer().on('POST /v1/register/verify', tooSoon('register', 'register', 'RATE_LIMITED', 'Too many attempts. Try again in 35 seconds.', 35))
    const { err } = capture()

    expect(await commands.runRegister({ code: '123456' })).toBe(1)

    expect(text(err)).toBe(
      `Too many attempts. Try again in 35 seconds.\nFor a new code: Wait 35 s, then run \`${INVOKE} register --email owner@example.com --handle new-agent\``,
    )
    expect(readPending(home)).toBeNull()
  })

  it('the handle taken after the code (a race): register again with another handle; the used-up flow dropped', async () => {
    const { home, commands } = fixture()
    pendingRegistration(home, { received_at: minutesAgo(2) })
    signupServer().on('POST /v1/register/verify', askParam('register', 409, 'HANDLE_TAKEN', 'The handle @new-agent is taken. Try another.', 'handle'))
    const { err } = capture()

    expect(await commands.runRegister({ code: '123456' })).toBe(1)

    expect(text(err)).toContain(`Run \`${INVOKE} register --email owner@example.com --handle <handle>\``)
    expect(readPending(home)).toBeNull()
  })

  it('a 5xx after the code: the sentence only, and the flow kept (the account may exist; no second registration)', async () => {
    const { home, commands } = fixture()
    pendingRegistration(home)
    signupServer().on('POST /v1/register/verify', serverError('register', 'INTERNAL_ERROR', 'Something went wrong.'))
    const { err } = capture()

    expect(await commands.runRegister({ code: '123456' })).toBe(1)

    expect(text(err)).toBe('Something went wrong.')
    expect(readPending(home)?.flow.pending_id).toBe('pnd_live')
  })

  it('a code in the wrong form is the server’s to judge: asked again, the flow kept', async () => {
    const { home, commands } = fixture()
    pendingRegistration(home)
    const server = signupServer().on('POST /v1/register/verify', {
      status: 400,
      body: {
        code: 'VALIDATION_ERROR',
        message: 'Enter the code using only 6 digits.',
        details: { version: 1, flow: 'register', next_step: 'verify', param: 'code', code_length: 6, fieldErrors: { code: ['x'] } },
      },
    })
    const { err } = capture()

    expect(await commands.runRegister({ code: '12 34' })).toBe(1)

    expect(server.calls[0]?.body).toEqual({ pending_id: 'pnd_live', code: '12 34' })
    expect(text(err)).toBe(`Enter the code using only 6 digits.\nRun \`${INVOKE} register --code <6 digits>\``)
    expect(readPending(home)?.flow.pending_id).toBe('pnd_live')
  })

  it('nothing pending: says how to start, calls nothing', async () => {
    const { commands } = fixture()
    const server = signupServer()
    const { err } = capture()

    expect(await commands.runRegister({ code: '123456' })).toBe(1)

    expect(server.calls).toEqual([])
    expect(text(err)).toContain(`No registration in progress. Start with: ${INVOKE} register --email <email> --handle <handle>`)
  })

  it('a code requested by the previous release (its pending record) still completes', async () => {
    const { home, commands } = fixture()
    fs.writeFileSync(
      pendingPath(home),
      JSON.stringify({ kind: 'register', pending_id: 'pnd_old', email: 'owner@example.com', handle: 'new-agent', created_at: new Date().toISOString() }),
    )
    const server = signupServer().on('POST /v1/register/verify', registered('new-agent', fakeKey('o')))
    capture()

    expect(await commands.runRegister({ code: '123456' })).toBe(0)

    expect(server.calls[0]?.body).toEqual({ pending_id: 'pnd_old', code: '123456' })
    expect(readCredentials(home)?.handle).toBe('new-agent')
  })

  it('a custom API base: the code goes where the request went, and the credential remembers it', async () => {
    const { home, commands } = fixture()
    signupServer()
      .on('POST /v1/register', codeSent('register', 'pnd_base', SENT_REGISTER))
      .on('POST /v1/register/verify', registered('new-agent', fakeKey('b')))
    capture()

    expect(await commands.runRegister({ email: 'owner@example.com', handle: 'new-agent', apiBase: 'https://api.agentchat.test' })).toBe(0)
    expect(readPending(home)?.api_base).toBe('https://api.agentchat.test')
    expect(await commands.runRegister({ code: '123456' })).toBe(0)
    expect(readCredentials(home)?.api_base).toBe('https://api.agentchat.test')
  })
})

// ─── recover ────────────────────────────────────────────────────────────────

describe('recover', () => {
  it('asks with handle and email, keeps the flow, and prints the recover code command', async () => {
    const { home, commands } = fixture()
    const server = signupServer().on('POST /v1/agents/recover', codeSent('recover', 'pnd_r', SENT_RECOVER))
    const { out } = capture()

    expect(await commands.runRecover({ email: 'owner@example.com', handle: 'my-agent' })).toBe(0)

    expect(server.calls[0]).toMatchObject({ path: '/v1/agents/recover', body: { email: 'owner@example.com', handle: 'my-agent' } })
    const lines = text(out).split('\n')
    expect(lines[0]).toBe(SENT_RECOVER)
    expect(lines[1]).toMatch(/^Setup: code_pending — a recovery for @my-agent is waiting on the 6-digit code AgentChat emailed to owner@example\.com/)
    expect(lines[1]).toContain(`Run \`${INVOKE} recover --code <6 digits>\` with it.`)
    expect(readPending(home)).toMatchObject({ kind: 'recover', handle: 'my-agent', flow: { next_step: 'recover_verify', pending_id: 'pnd_r' } })
  })

  it('without a handle anywhere it asks by email alone; HANDLE_REQUIRED after the code says to re-run with one of the handles', async () => {
    const { home, commands } = fixture()
    const server = signupServer()
      .on('POST /v1/agents/recover', codeSent('recover', 'pnd_amb', 'If an agent is registered with owner@example.com, we sent a 6-digit code there. It expires in 10 minutes.'))
      .on(
        'POST /v1/agents/recover/verify',
        askParam('recover', 409, 'HANDLE_REQUIRED', 'More than one agent uses this email address. Choose the handle to recover.', 'handle', {
          handles: ['first-agent', 'second-agent'],
        }),
      )
      .on('POST /v1/agents/recover', codeSent('recover', 'pnd_two', SENT_RECOVER))

    capture()
    expect(await commands.runRecover({ email: 'owner@example.com' })).toBe(0)
    expect(server.calls[0]?.body).toEqual({ email: 'owner@example.com' })
    vi.restoreAllMocks()
    // The person reads the email: two minutes pass before the code is entered.
    writePending(home, { ...readPending(home)!, received_at: minutesAgo(2) })

    const verify = capture()
    expect(await commands.runRecover({ code: '123456' })).toBe(1)
    expect(text(verify.err)).toBe(
      'More than one agent uses this email address. Choose the handle to recover.\n' +
        `Run \`${INVOKE} recover --handle <handle> --email owner@example.com\`, with one of: @first-agent, @second-agent`,
    )
    expect(readPending(home)).toBeNull()
    expect(readCredentials(home)).toBeNull()
    vi.restoreAllMocks()

    capture()
    expect(await commands.runRecover({ handle: 'second-agent', email: 'owner@example.com' })).toBe(0)
    expect(server.calls[2]?.body).toEqual({ email: 'owner@example.com', handle: 'second-agent' })
    expect(readPending(home)?.flow.pending_id).toBe('pnd_two')
  })

  it('HANDLE_REQUIRED inside the resend window says to wait first', async () => {
    const { home, commands } = fixture()
    pendingRecovery(home, null)
    signupServer().on(
      'POST /v1/agents/recover/verify',
      askParam('recover', 409, 'HANDLE_REQUIRED', 'More than one agent uses this email address. Choose the handle to recover.', 'handle', { handles: ['a-agent'] }),
    )
    const { err } = capture()

    expect(await commands.runRecover({ code: '123456' })).toBe(1)

    expect(text(err)).toMatch(new RegExp(`Wait (59|60) s, then run \`${INVOKE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} recover --handle <handle> --email owner@example.com\``))
  })

  it('every recover answer points at recover, never register', async () => {
    const answers = [
      wrongCode('recover', 'pnd_recover'),
      expired('recover'),
      attemptsExhausted('recover', 0),
      tooSoon('recover', 'recover_verify', 'RATE_LIMITED', 'Too many attempts. Try again in 20 seconds.', 20),
    ]
    const expected = [
      `Run \`${INVOKE} recover --code <6 digits>\``,
      `For a new code: Run \`${INVOKE} recover --handle my-agent --email owner@example.com\``,
      `For a new code: Run \`${INVOKE} recover --handle my-agent --email owner@example.com\``,
      `Wait 20 s, then run \`${INVOKE} recover --code 123456\``,
    ]
    for (const [i, answer] of answers.entries()) {
      const { home, commands } = fixture()
      pendingRecovery(home, 'my-agent', 3 * 60_000)
      signupServer().on('POST /v1/agents/recover/verify', answer)
      const { err } = capture()
      expect(await commands.runRecover({ code: '123456' })).toBe(1)
      const rendered = text(err)
      expect(rendered).toContain(expected[i]!)
      expect(rendered).not.toMatch(/register/i)
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    }
  })

  it('done: the new key and the server’s handle saved, the server’s sentence first', async () => {
    const { home, commands } = fixture()
    pendingRecovery(home, 'typed-agent')
    const key = fakeKey('n')
    signupServer().on('POST /v1/agents/recover/verify', recovered('my-agent', key))
    const { out } = capture()

    expect(await commands.runRecover({ code: '123456' })).toBe(0)

    expect(readCredentials(home)).toMatchObject({ api_key: key, handle: 'my-agent' })
    expect(readPending(home)).toBeNull()
    const rendered = text(out)
    expect(rendered.split('\n')[0]).toBe('Email verified. Logged in as @my-agent. Your old API key no longer works.')
    expect(rendered).toContain(`New API key for @my-agent stored at ${credentialsPath(home)}`)
  })

  it('a registration code is not completed by recover --code', async () => {
    const { home, commands } = fixture()
    pendingRegistration(home)
    const server = signupServer()
    const { err } = capture()

    expect(await commands.runRecover({ code: '123456' })).toBe(1)

    expect(server.calls).toEqual([])
    expect(text(err)).toContain(`${INVOKE} register --code 123456`)
  })
})

// ─── the source carries no rulebook ─────────────────────────────────────────

describe('the sign-up commands keep no rulebook of the server’s', () => {
  it('no sign-up error code, limit or minute count appears in the commands', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'identity', 'commands.ts'), 'utf-8')
    for (const code of ['INVALID_CODE', 'EXPIRED', 'HANDLE_TAKEN', 'HANDLE_REQUIRED', 'INVALID_HANDLE', 'EMAIL_LIMIT_REACHED', 'EMAIL_TAKEN', 'EMAIL_EXHAUSTED', 'OTP_']) {
      expect(source, code).not.toContain(code)
    }
    expect(source).not.toMatch(/\b10 minutes\b|~10|codes last/)
    expect(source).not.toMatch(/HANDLE_PATTERN|validHandle/)
  })
})
