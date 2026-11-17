import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIdentityCommands } from '../src/identity/commands.js'
import { renderAnchorBlock } from '../src/anchor/block.js'
import { readCredentials, readPending } from '../src/identity/credentials.js'
import type { HostProfile } from '../src/identity/host-profile.js'
import { askParam, codeSent, expired, fakeKey, recovered, registered, signupServer, wrongCode } from './helpers/signup-server.js'

// ─── On a terminal, a sign-up that has to ask asks to the end ───────────────
//
// A person at a terminal who left out what the command needs is asked for it,
// one question each, and then for the code, in the same run: the SDK's
// `integration.account.run` drives the conversation from the server's
// answers (re-asking only the field the server names, offering a new code
// only when the person says so). The TTY is simulated, and `node:readline` is
// replaced with a scripted answerer; an empty script is the input ending
// (Ctrl-D), which `prompt()` hears as the interface closing.

const answers: string[] = []
const questions: string[] = []

vi.mock('node:readline', () => ({
  createInterface: () => {
    let onClose: (() => void) | null = null
    return {
      once: (event: string, cb: () => void) => {
        if (event === 'close') onClose = cb
      },
      question: (text: string, cb: (answer: string) => void) => {
        questions.push(text)
        const next = answers.shift()
        if (next === undefined) onClose?.()
        else cb(next)
      },
      close: () => {},
    }
  },
}))

const INVOKE = 'npx -y @agentchatme/example'
const homes: string[] = []
const originalStdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
const originalStdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

function fixture(): { home: string; commands: ReturnType<typeof createIdentityCommands> } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-signup-tty-'))
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

function capture(): { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  vi.spyOn(console, 'log').mockImplementation((value) => out.push(String(value)))
  vi.spyOn(console, 'error').mockImplementation((value) => err.push(String(value)))
  return { out, err }
}

beforeEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  answers.length = 0
  questions.length = 0
  if (originalStdinTty) Object.defineProperty(process.stdin, 'isTTY', originalStdinTty)
  if (originalStdoutTty) Object.defineProperty(process.stdout, 'isTTY', originalStdoutTty)
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

const SENT_RECOVER = 'If @typed-agent is registered with owner@example.com, we sent a 6-digit code there. It expires in 10 minutes.'

describe('recovery on a TTY', () => {
  it('asks for the handle, then the email, sends both, asks for the code, and saves the server’s handle', async () => {
    const { home, commands } = fixture()
    const key = fakeKey('t')
    const server = signupServer()
      .on('POST /v1/agents/recover', codeSent('recover', 'pnd_tty', SENT_RECOVER))
      .on('POST /v1/agents/recover/verify', recovered('server-agent', key))
    const { out } = capture()
    answers.push('@Typed-Agent', 'Owner@Example.com', '123456')

    expect(await commands.runRecover({})).toBe(0)

    expect(questions).toEqual(['Handle of the agent to recover: ', 'Email address: ', 'Enter the 6-digit code (or "new" for a new code): '])
    expect(server.calls.map((c) => [c.path, c.body])).toEqual([
      ['/v1/agents/recover', { email: 'owner@example.com', handle: 'typed-agent' }],
      ['/v1/agents/recover/verify', { pending_id: 'pnd_tty', code: '123456' }],
    ])
    expect(readCredentials(home)).toMatchObject({ api_key: key, handle: 'server-agent' })
    const rendered = out.join('\n')
    expect(rendered).toContain(SENT_RECOVER)
    expect(rendered).toContain('Email verified. Logged in as @server-agent. Your old API key no longer works.')
    expect(rendered).toContain('New API key for @server-agent stored at')
    // The conversation ran in one process: nothing waits between runs.
    expect(readPending(home)).toBeNull()
  })

  it('only asks for what the flags did not supply; the input ending is a cancel, nothing saved', async () => {
    const { home, commands } = fixture()
    const server = signupServer().on('POST /v1/agents/recover', codeSent('recover', 'pnd_tty', SENT_RECOVER))
    const { err } = capture()
    answers.push('owner@example.com')

    expect(await commands.runRecover({ handle: 'flagged-agent' })).toBe(1)

    expect(questions[0]).toBe('Email address: ')
    expect(questions).toHaveLength(2) // the email, then the code (answered by Ctrl-D)
    expect(server.calls[0]?.body).toEqual({ email: 'owner@example.com', handle: 'flagged-agent' })
    expect(err.join('\n')).toBe('Cancelled.')
    expect(readCredentials(home)).toBeNull()
  })
})

describe('registration on a TTY', () => {
  it('re-asks only the field the server names, asks the code again after a wrong one, and saves the server’s handle', async () => {
    const { home, commands } = fixture()
    const key = fakeKey('g')
    const server = signupServer()
      .on(
        'POST /v1/register',
        askParam('register', 409, 'HANDLE_TAKEN', 'The handle @taken-agent is taken. Try another.', 'handle'),
        codeSent('register', 'pnd_reg', 'We sent a 6-digit code to owner@example.com. It expires in 10 minutes.', { resend_after_s: 0 }),
      )
      .on('POST /v1/register/verify', wrongCode('register', 'pnd_reg'), registered('free-agent', key))
    const { out } = capture()
    answers.push('owner@example.com', 'taken-agent', 'free-agent', '000000', '123456')

    expect(await commands.runRegister({ displayName: 'My Agent' })).toBe(0)

    expect(questions).toEqual([
      'Email address: ',
      'Handle: ',
      'Handle: ',
      'Enter the 6-digit code (or "new" for a new code): ',
      'Enter the 6-digit code (or "new" for a new code): ',
    ])
    expect(server.calls.map((c) => c.body)).toEqual([
      { email: 'owner@example.com', handle: 'taken-agent', display_name: 'My Agent' },
      { email: 'owner@example.com', handle: 'free-agent', display_name: 'My Agent' },
      { pending_id: 'pnd_reg', code: '000000' },
      { pending_id: 'pnd_reg', code: '123456' },
    ])
    expect(out.slice(0, 4)).toEqual([
      'The handle @taken-agent is taken. Try another.',
      'We sent a 6-digit code to owner@example.com. It expires in 10 minutes.',
      "That code didn't work. Check the code and try again.",
      expect.stringContaining('Email verified. Logged in as @free-agent.'),
    ])
    expect(readCredentials(home)).toMatchObject({ api_key: key, handle: 'free-agent' })
  })

  it('an expired code: a new one only after the person says yes', async () => {
    const { home, commands } = fixture()
    const key = fakeKey('y')
    const server = signupServer()
      .on(
        'POST /v1/register',
        codeSent('register', 'pnd_first', 'We sent a 6-digit code to owner@example.com. It expires in 10 minutes.', { resend_after_s: 0 }),
        codeSent('register', 'pnd_second', 'We sent a 6-digit code to owner@example.com. It expires in 10 minutes.', { resend_after_s: 0 }),
      )
      .on('POST /v1/register/verify', expired('register'), registered('new-agent', key))
    capture()
    answers.push('owner@example.com', 'new-agent', '111111', 'y', '222222')

    expect(await commands.runRegister({})).toBe(0)

    expect(questions[3]).toBe('Send a new code? [y/N] ')
    expect(server.calls.map((c) => c.body)).toEqual([
      { email: 'owner@example.com', handle: 'new-agent' },
      { pending_id: 'pnd_first', code: '111111' },
      { email: 'owner@example.com', handle: 'new-agent' },
      { pending_id: 'pnd_second', code: '222222' },
    ])
    expect(readCredentials(home)?.handle).toBe('new-agent')
  })

  it('a “no” to a new code ends the run without sending one', async () => {
    const { commands } = fixture()
    const server = signupServer()
      .on('POST /v1/register', codeSent('register', 'pnd_first', 'We sent a code.', { resend_after_s: 0 }))
      .on('POST /v1/register/verify', expired('register'))
    const { err } = capture()
    answers.push('owner@example.com', 'new-agent', '111111', 'n')

    expect(await commands.runRegister({})).toBe(1)

    expect(server.calls).toHaveLength(2)
    expect(err.join('\n')).toBe('Cancelled.')
  })
})
