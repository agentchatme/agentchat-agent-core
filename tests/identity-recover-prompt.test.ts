import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpTransport } from 'agentchatme'
import { createIdentityCommands } from '../src/identity/commands.js'
import { readPending } from '../src/identity/credentials.js'
import type { HostProfile } from '../src/identity/host-profile.js'
import { mockServedTexts } from './helpers/served-texts.js'

// ─── Interactive recovery asks for what it lacks ────────────────────────────
//
// A person at a terminal with no stored identity is asked for the handle and
// the email, one question each, instead of being told about flags. The TTY is
// simulated, and `node:readline` is replaced with a scripted answerer — the
// engine's `prompt()` goes through `createInterface().question()`, so this is
// the exact seam.

const answers: string[] = []
const questions: string[] = []

vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (text: string, cb: (answer: string) => void) => {
      questions.push(text)
      cb(answers.shift() ?? '')
    },
    close: () => {},
  }),
}))

const homes: string[] = []
const originalStdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
const originalStdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

function fixture(): { home: string; commands: ReturnType<typeof createIdentityCommands> } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-recover-tty-'))
  homes.push(home)
  const profile: HostProfile = {
    label: 'Example',
    id: 'example',
    client: { runtime: 'generic', version: '0.0.0-test' },
    home: () => home,
    anchorFile: () => path.join(home, 'ANCHOR.md'),
    invocation: () => 'npx -y @agentchatme/example',
    renderAnchor: (line) => line,
    isWired: () => false,
  }
  mockServedTexts()
  return { home, commands: createIdentityCommands(profile) }
}

afterEach(() => {
  vi.restoreAllMocks()
  answers.length = 0
  questions.length = 0
  if (originalStdinTty) Object.defineProperty(process.stdin, 'isTTY', originalStdinTty)
  if (originalStdoutTty) Object.defineProperty(process.stdout, 'isTTY', originalStdoutTty)
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

describe('recovery on a TTY', () => {
  it('prompts for the handle, then the email, and sends both', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
    const { home, commands } = fixture()
    const request = vi.spyOn(HttpTransport.prototype, 'request').mockResolvedValue({
      data: { pending_id: 'pnd_tty', message: 'sent' },
      headers: new Headers(),
      status: 200,
      requestId: null,
    } as never)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    answers.push('@Typed-Agent', 'Owner@Example.com')

    expect(await commands.runRecover({})).toBe(0)

    expect(questions).toHaveLength(2)
    expect(questions[0]).toMatch(/handle/i)
    expect(questions[1]).toMatch(/email/i)
    expect(questions[1]).toContain('@typed-agent')
    expect(request).toHaveBeenCalledWith('POST', '/v1/agents/recover', {
      body: { email: 'owner@example.com', handle: 'typed-agent' },
      retry: 'never',
    })
    expect(readPending(home)).toMatchObject({ kind: 'recover', handle: 'typed-agent' })
  })

  it('only asks for what the flags did not supply', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
    const { commands } = fixture()
    vi.spyOn(HttpTransport.prototype, 'request').mockResolvedValue({
      data: { pending_id: 'pnd_tty', message: 'sent' },
      headers: new Headers(),
      status: 200,
      requestId: null,
    } as never)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    answers.push('owner@example.com')

    expect(await commands.runRecover({ handle: 'flagged-agent' })).toBe(0)

    expect(questions).toHaveLength(1)
    expect(questions[0]).toMatch(/email/i)
  })
})
