import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIdentityCommands } from '../src/identity/commands.js'
import { renderAnchorBlock } from '../src/anchor/block.js'
import { readCredentials, readPending, writeCredentials, writePending } from '../src/identity/credentials.js'
import type { HostProfile } from '../src/identity/host-profile.js'
import { askParam, codeSent, fakeKey, signupServer, wrongCode } from './helpers/signup-server.js'

// ─── Recovery names an agent by handle AND email, when it can ───────────────
//
// One email can back several agents. The engine sends the handle whenever it
// knows it (given, or this agent's own stored handle); without one it asks by
// email alone, and the server's HANDLE_REQUIRED (after the code) names the
// handles to choose from. Every judgement of the input is the server's.

const homes: string[] = []
const INVOKE = 'npx -y @agentchatme/example'
const SENT = 'If @my-agent is registered with owner@example.com, we sent a 6-digit code there. It expires in 10 minutes.'

function fixture(): { home: string; commands: ReturnType<typeof createIdentityCommands> } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-recover-'))
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

/** Make both streams deterministically non-interactive for a test. */
function nonInteractive(): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
}

interface Captured {
  out: string[]
  err: string[]
}

function capture(): Captured {
  const out: string[] = []
  const err: string[] = []
  vi.spyOn(console, 'log').mockImplementation((value) => out.push(String(value)))
  vi.spyOn(console, 'error').mockImplementation((value) => err.push(String(value)))
  return { out, err }
}

/** The server sends a code for any recover request. */
function serverAccepts(pendingId = 'pnd_abc') {
  return signupServer().on('POST /v1/agents/recover', codeSent('recover', pendingId, SENT))
}

/** A recovery waiting for its code, as `recover --handle --email` leaves it (sent two minutes ago). */
function pendingRecovery(home: string, pendingId: string, handle?: string): void {
  writePending(home, {
    kind: 'recover',
    flow: { version: 1, flow: 'recover', next_step: 'recover_verify', status: 'pending', pending_id: pendingId, expires_in_s: 600, code_length: 6, resend_after_s: 60 },
    received_at: new Date(Date.now() - 120_000).toISOString(),
    email: 'owner@example.com',
    ...(handle !== undefined ? { handle } : {}),
  })
}

const originalStdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
const originalStdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

beforeEach(() => {
  nonInteractive()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (originalStdinTty) Object.defineProperty(process.stdin, 'isTTY', originalStdinTty)
  if (originalStdoutTty) Object.defineProperty(process.stdout, 'isTTY', originalStdoutTty)
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

describe('starting recovery', () => {
  it('sends handle and email together to POST /v1/agents/recover and remembers the server’s flow', async () => {
    const { home, commands } = fixture()
    const server = serverAccepts('pnd_123')
    const { out } = capture()

    expect(await commands.runRecover({ email: 'Owner@Example.com', handle: 'my-agent' })).toBe(0)

    expect(server.calls).toHaveLength(1)
    expect(server.calls[0]).toMatchObject({ method: 'POST', path: '/v1/agents/recover', body: { email: 'owner@example.com', handle: 'my-agent' } })
    expect(readPending(home)).toMatchObject({
      kind: 'recover',
      email: 'owner@example.com',
      handle: 'my-agent',
      flow: { next_step: 'recover_verify', pending_id: 'pnd_123' },
    })
    // The server's sentence (which never confirms that an account exists), then the next command.
    expect(out.join('\n')).toBe(`${SENT}\nRun \`${INVOKE} recover --code <6 digits>\``)
  })

  it('accepts the handle with a leading @ and in any case', async () => {
    const { commands } = fixture()
    const server = serverAccepts()
    capture()

    expect(await commands.runRecover({ email: 'owner@example.com', handle: '@My-Agent' })).toBe(0)

    expect(server.calls[0]?.body).toMatchObject({ handle: 'my-agent' })
  })

  it('defaults to this agent’s stored handle when --handle is omitted', async () => {
    const { home, commands } = fixture()
    writeCredentials(home, { api_key: fakeKey('k'), handle: 'stored-agent' })
    const server = serverAccepts()
    const { out } = capture()

    expect(await commands.runRecover({ email: 'owner@example.com' })).toBe(0)

    expect(server.calls[0]?.body).toEqual({ email: 'owner@example.com', handle: 'stored-agent' })
    expect(out.join('\n')).toContain('Recovering @stored-agent')
    expect(out.join('\n')).toContain('--handle')
  })

  it('an explicit --handle beats the stored one', async () => {
    const { home, commands } = fixture()
    writeCredentials(home, { api_key: fakeKey('k'), handle: 'stored-agent' })
    const server = serverAccepts()
    const { out } = capture()

    expect(await commands.runRecover({ email: 'owner@example.com', handle: 'other-agent' })).toBe(0)

    expect(server.calls[0]?.body).toMatchObject({ handle: 'other-agent' })
    expect(out.join('\n')).not.toContain('Recovering @stored-agent')
  })

  it('with no handle anywhere and no TTY it asks by email alone', async () => {
    const { home, commands } = fixture()
    const server = serverAccepts('pnd_email_only')
    capture()

    expect(await commands.runRecover({ email: 'owner@example.com' })).toBe(0)

    expect(server.calls[0]?.body).toEqual({ email: 'owner@example.com' })
    expect(readPending(home)?.flow.pending_id).toBe('pnd_email_only')
    expect(readPending(home)?.handle).toBeUndefined()
  })

  it('with no email and no TTY it fails naming --email, without touching the network', async () => {
    const { commands } = fixture()
    const server = serverAccepts()
    const { err } = capture()

    expect(await commands.runRecover({ handle: 'my-agent' })).toBe(1)

    expect(server.calls).toEqual([])
    expect(err.join('\n')).toContain('Missing --email')
    expect(err.join('\n')).toContain(`${INVOKE} recover --handle <handle> --email <email>`)
  })

  it('a handle the server rejects: its sentence, then the command with the handle to fill in', async () => {
    const { home, commands } = fixture()
    signupServer().on(
      'POST /v1/agents/recover',
      askParam('recover', 400, 'VALIDATION_ERROR', 'Enter a handle of 3 to 30 characters: lowercase letters, numbers and hyphens, starting with a letter.', 'handle'),
    )
    const { err } = capture()

    expect(await commands.runRecover({ email: 'owner@example.com', handle: 'x' })).toBe(1)

    expect(err.join('\n')).toBe(
      'Enter a handle of 3 to 30 characters: lowercase letters, numbers and hyphens, starting with a letter.\n' +
        `Run \`${INVOKE} recover --handle <handle> --email owner@example.com\``,
    )
    expect(readPending(home)).toBeNull()
  })

  it('an email the server rejects: the command with the email to fill in, the handle kept', async () => {
    const { commands } = fixture()
    signupServer().on('POST /v1/agents/recover', askParam('recover', 400, 'VALIDATION_ERROR', 'Enter an email address in the correct format, like name@example.com', 'email'))
    const { err } = capture()

    expect(await commands.runRecover({ email: 'not-an-email', handle: 'my-agent' })).toBe(1)

    expect(err.join('\n')).toContain(`Run \`${INVOKE} recover --handle my-agent --email <email>\``)
  })

  it('an older server’s answer without a pending id: its sentence, nothing stored', async () => {
    const { home, commands } = fixture()
    signupServer().on('POST /v1/agents/recover', { status: 200, body: { message: 'If an agent is registered with that email, a recovery code was sent to it.' } })
    const { err } = capture()

    expect(await commands.runRecover({ email: 'owner@example.com', handle: 'my-agent' })).toBe(1)

    expect(readPending(home)).toBeNull()
    expect(err.join('\n')).toBe('If an agent is registered with that email, a recovery code was sent to it.')
  })

  it('an older server’s rejection without a flow: its sentence, nothing stored', async () => {
    const { home, commands } = fixture()
    signupServer().on('POST /v1/agents/recover', { status: 400, body: { code: 'VALIDATION_ERROR', message: 'email: invalid' } })
    const { err } = capture()

    expect(await commands.runRecover({ email: 'owner@example.com', handle: 'my-agent' })).toBe(1)

    expect(readPending(home)).toBeNull()
    expect(err.join('\n')).toContain('email: invalid')
  })
})

describe('completing recovery', () => {
  it('the completion hint names both flags when nothing is pending', async () => {
    const { commands } = fixture()
    const { err } = capture()

    expect(await commands.runRecover({ code: '123456' })).toBe(1)

    expect(err.join('\n')).toContain(`${INVOKE} recover --handle <handle> --email <email>`)
  })

  it('HANDLE_REQUIRED lists the handles, says to re-run with one, and drops the spent flow', async () => {
    const { home, commands } = fixture()
    pendingRecovery(home, 'pnd_ambiguous')
    signupServer().on(
      'POST /v1/agents/recover/verify',
      askParam('recover', 409, 'HANDLE_REQUIRED', 'More than one agent uses this email address. Choose the handle to recover.', 'handle', {
        handles: ['first-agent', 'second-agent'],
      }),
    )
    const { err } = capture()

    expect(await commands.runRecover({ code: '123456' })).toBe(1)

    const rendered = err.join('\n')
    expect(rendered).toContain('More than one agent uses this email address. Choose the handle to recover.')
    expect(rendered).toContain(`${INVOKE} recover --handle <handle> --email owner@example.com`)
    expect(rendered).toContain('@first-agent, @second-agent')
    expect(readPending(home)).toBeNull()
    expect(readCredentials(home)).toBeNull()
  })

  it('HANDLE_REQUIRED without a handle list still says what to run', async () => {
    const { home, commands } = fixture()
    pendingRecovery(home, 'pnd_ambiguous')
    signupServer().on('POST /v1/agents/recover/verify', askParam('recover', 409, 'HANDLE_REQUIRED', 'Choose the handle to recover.', 'handle'))
    const { err } = capture()

    expect(await commands.runRecover({ code: '123456' })).toBe(1)

    expect(err.join('\n')).toContain(`Run \`${INVOKE} recover --handle <handle> --email owner@example.com\``)
    expect(err.join('\n')).not.toContain('one of')
  })

  it('a wrong code keeps the flow so the code can be entered again', async () => {
    const { home, commands } = fixture()
    pendingRecovery(home, 'pnd_live', 'my-agent')
    signupServer().on('POST /v1/agents/recover/verify', wrongCode('recover', 'pnd_live', 2))
    const { err } = capture()

    expect(await commands.runRecover({ code: '000000' })).toBe(1)

    expect(readPending(home)?.flow).toMatchObject({ pending_id: 'pnd_live', attempts: 2 })
    expect(err.join('\n')).toContain(`Run \`${INVOKE} recover --code <6 digits>\``)
  })

  it('status names the handle a pending recovery is for', async () => {
    const { home, commands } = fixture()
    pendingRecovery(home, 'pnd_live', 'my-agent')
    const { out } = capture()

    expect(await commands.runStatus({})).toBe(0)

    expect(out.join('\n')).toContain('recovery for @my-agent is waiting')
    expect(out.join('\n')).toContain(`${INVOKE} recover --code <6 digits>`)
  })

  it('status says when the pending code has expired, and how to get a new one', async () => {
    const { home, commands } = fixture()
    writePending(home, {
      kind: 'recover',
      flow: { version: 1, flow: 'recover', next_step: 'recover_verify', status: 'pending', pending_id: 'pnd_old', expires_in_s: 600 },
      received_at: new Date(Date.now() - 11 * 60_000).toISOString(),
      email: 'owner@example.com',
      handle: 'my-agent',
    })
    const { out } = capture()

    expect(await commands.runStatus({})).toBe(0)

    expect(out.join('\n')).toContain('has expired')
    expect(out.join('\n')).toContain(`${INVOKE} recover --handle my-agent --email owner@example.com`)
  })
})
