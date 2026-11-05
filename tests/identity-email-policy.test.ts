import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentChatClient, AgentChatError } from 'agentchatme'
import { createIdentityCommands } from '../src/identity/commands.js'
import { readPending } from '../src/identity/credentials.js'
import type { HostProfile } from '../src/identity/host-profile.js'
import { mockServedTexts } from './helpers/served-texts.js'
import { renderUnregisteredBlock } from '../src/anchor/offer.js'
import { MANUAL } from '../src/skill/manual.js'

// ─── One email, several agents ──────────────────────────────────────────────
//
// The number of agents an email may back is a server-side setting. The error
// text must therefore quote the limit the server just reported and never a
// constant of our own — a constant would be wrong the day the setting moves.
// `EMAIL_TAKEN` is the same refusal from a server that has not been upgraded
// yet (its limit was one) and must keep getting sensible advice.

const homes: string[] = []
const INVOKE = 'npx -y @agentchatme/example'
const COPY = { invoke: INVOKE, label: 'Example' }

function fixture(): { home: string; commands: ReturnType<typeof createIdentityCommands> } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-email-policy-'))
  homes.push(home)
  const profile: HostProfile = {
    label: 'Example',
    id: 'example',
    client: { runtime: 'generic', version: '0.0.0-test' },
    home: () => home,
    anchorFile: () => path.join(home, 'ANCHOR.md'),
    invocation: () => INVOKE,
    renderAnchor: (line) => line,
    isWired: () => false,
  }
  mockServedTexts()
  return { home, commands: createIdentityCommands(profile) }
}

const originalStdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
const originalStdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

beforeEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalStdinTty) Object.defineProperty(process.stdin, 'isTTY', originalStdinTty)
  if (originalStdoutTty) Object.defineProperty(process.stdout, 'isTTY', originalStdoutTty)
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

async function registerAgainst(error: AgentChatError): Promise<{ code: number; err: string; home: string }> {
  const { home, commands } = fixture()
  vi.spyOn(AgentChatClient, 'register').mockRejectedValue(error)
  const lines: string[] = []
  vi.spyOn(console, 'error').mockImplementation((value) => lines.push(String(value)))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const code = await commands.runRegister({ email: 'owner@example.com', handle: 'new-agent' })
  return { code, err: lines.join('\n'), home }
}

describe('registration against a full email', () => {
  it('EMAIL_LIMIT_REACHED quotes the limit the server reported', async () => {
    const { code, err, home } = await registerAgainst(
      new AgentChatError(
        {
          code: 'EMAIL_LIMIT_REACHED',
          message: 'This email already backs 7 active agents. Delete one, or register with a different email.',
          details: { limit: 7 },
        },
        409,
      ),
    )
    expect(code).toBe(1)
    expect(err).toContain('Registration failed.')
    expect(err).toContain('7 active agents')
    expect(err).toContain(`${INVOKE} login`)
    expect(err).toContain(`${INVOKE} recover --handle <handle> --email <email>`)
    expect(err).toMatch(/different email/)
    expect(err).toMatch(/\+ alias/)
    expect(readPending(home)).toBeNull()
  })

  it('EMAIL_LIMIT_REACHED without details falls back to the server’s own sentence', async () => {
    const { err } = await registerAgainst(
      new AgentChatError(
        { code: 'EMAIL_LIMIT_REACHED', message: 'This email already backs its maximum number of agents.' },
        409,
      ),
    )
    expect(err).toContain('This email already backs its maximum number of agents.')
    expect(err).not.toMatch(/\b10\b/)
    expect(err).toContain('recover --handle <handle> --email <email>')
  })

  it('EMAIL_EXHAUSTED quotes the lifetime limit the server reported', async () => {
    const { err } = await registerAgainst(
      new AgentChatError(
        {
          code: 'EMAIL_EXHAUSTED',
          message: 'This email has reached the maximum of 12 account registrations.',
          details: { limit: 12 },
        },
        409,
      ),
    )
    expect(err).toContain('lifetime maximum of 12 account registrations')
    expect(err).toMatch(/different email/)
    expect(err).not.toMatch(/\b30\b/)
  })

  it('EMAIL_EXHAUSTED without details falls back to the server’s own sentence', async () => {
    const { err } = await registerAgainst(
      new AgentChatError({ code: 'EMAIL_EXHAUSTED', message: 'No more registrations for this email.' }, 409),
    )
    expect(err).toContain('No more registrations for this email.')
    expect(err).not.toMatch(/\b3\b registrations/)
  })

  it('legacy EMAIL_TAKEN from an older server gets the same advice as EMAIL_LIMIT_REACHED', async () => {
    const { err } = await registerAgainst(
      new AgentChatError({ code: 'EMAIL_TAKEN', message: 'This email already has an active agent.' }, 409),
    )
    expect(err).toContain('This email already has an active agent.')
    expect(err).toContain(`${INVOKE} login`)
    expect(err).toContain(`${INVOKE} recover --handle <handle> --email <email>`)
    expect(err).toMatch(/different email/)
  })
})

/** The block is hand-wrapped prose; compare it with its line breaks folded. */
const flat = (text: string): string => text.replace(/\s+/g, ' ')

describe('the agent-facing copy states the policy', () => {
  const block = flat(renderUnregisteredBlock(COPY))

  it('nowhere claims one account per email, and never teaches the email-only recovery form', () => {
    for (const [name, text] of Object.entries({ block, manual: MANUAL })) {
      expect(text, name).not.toMatch(/one (account|agent) per email/i)
      expect(text, name).not.toMatch(/recover --email/)
    }
  })

  it('recovery is taught as handle plus email, asked one question at a time', () => {
    expect(block).toContain(`${INVOKE} recover --handle <handle> --email <email>`)
    expect(block).toContain('What email did you use for this AgentChat account?')
    expect(block).toMatch(/Which @handle is the account\?/)
    expect(block).toContain('AgentChat sent a 6-digit recovery code to <email>')
    const email = block.indexOf('What email did you use')
    const handle = block.indexOf('Which @handle is the account')
    const run = block.indexOf('recover --handle <handle> --email <email>')
    const paste = block.indexOf('recovery code to <email>')
    const code = block.indexOf('recover --code')
    expect(email).toBeGreaterThanOrEqual(0)
    expect(handle).toBeGreaterThan(email)
    expect(run).toBeGreaterThan(handle)
    expect(paste).toBeGreaterThan(run)
    expect(code).toBeGreaterThan(paste)
  })

  it('the always-loaded offer block stays lean: the recovery form and the one-line reason, nothing more', () => {
    // The block is re-read every session, so the cap guidance lives in the
    // manual and the CLI's own error — not here. Integrations assert an upper
    // bound on this block's size.
    expect(block).toMatch(/One email can back several agents, so recovery needs both/)
    expect(block).not.toMatch(/\+ alias/)
    expect(renderUnregisteredBlock(COPY).length).toBeLessThan(4000)
  })

  it('the bundled manual documents the policy, the error codes, and the recovery form', () => {
    expect(MANUAL).toMatch(/One email can back several agents/)
    expect(MANUAL).toContain('`EMAIL_LIMIT_REACHED`')
    expect(MANUAL).toContain('`EMAIL_EXHAUSTED`')
    expect(MANUAL).toContain('`HANDLE_REQUIRED`')
    expect(MANUAL).toMatch(/Always send `handle`/)
  })
})
