import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIdentityCommands } from '../src/identity/commands.js'
import { renderAnchorBlock } from '../src/anchor/block.js'
import { readPending } from '../src/identity/credentials.js'
import type { HostProfile } from '../src/identity/host-profile.js'
import { askParam, signupServer, type Answer } from './helpers/signup-server.js'
import { renderUnregisteredBlock } from '../src/anchor/offer.js'
import { MANUAL } from '../src/skill/manual.js'

// ─── One email, several agents ──────────────────────────────────────────────
//
// The number of agents an email may back is a server-side setting, and so is
// what to say about it: the server's sentence carries the number it applies
// today, and the engine shows that sentence as it is and adds only the
// command to re-run with another email. No limit, and no advice of its own,
// lives here; an older server's codes (`EMAIL_TAKEN`) are read by the SDK.

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
    renderAnchor: renderAnchorBlock,
    isWired: () => false,
  }
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
  vi.unstubAllGlobals()
  if (originalStdinTty) Object.defineProperty(process.stdin, 'isTTY', originalStdinTty)
  if (originalStdoutTty) Object.defineProperty(process.stdout, 'isTTY', originalStdoutTty)
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

async function registerAgainst(answer: Answer): Promise<{ code: number; err: string; home: string }> {
  const { home, commands } = fixture()
  signupServer().on('POST /v1/register', answer)
  const lines: string[] = []
  vi.spyOn(console, 'error').mockImplementation((value) => lines.push(String(value)))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const code = await commands.runRegister({ email: 'owner@example.com', handle: 'new-agent' })
  return { code, err: lines.join('\n'), home }
}

const RERUN_WITH_EMAIL = `Run \`${INVOKE} register --email <email> --handle new-agent\``

describe('registration against a full email', () => {
  it('EMAIL_LIMIT_REACHED: the server’s sentence with its number, then re-run with another email', async () => {
    const { code, err, home } = await registerAgainst(
      askParam('register', 409, 'EMAIL_LIMIT_REACHED', 'This email address already has 7 active agents, the most allowed. Use a different email address.', 'email', {
        limit: 7,
      }),
    )
    expect(code).toBe(1)
    expect(err).toBe(`This email address already has 7 active agents, the most allowed. Use a different email address.\n${RERUN_WITH_EMAIL}`)
    expect(readPending(home)).toBeNull()
  })

  it('EMAIL_EXHAUSTED: the same, with the lifetime number the server reported', async () => {
    const { err } = await registerAgainst(
      askParam('register', 409, 'EMAIL_EXHAUSTED', 'This email address has been used for 12 accounts, the most allowed. Use a different email address.', 'email', {
        limit: 12,
      }),
    )
    expect(err).toBe(`This email address has been used for 12 accounts, the most allowed. Use a different email address.\n${RERUN_WITH_EMAIL}`)
  })

  it('no number of its own: the output carries only what the server said', async () => {
    const { err } = await registerAgainst(
      askParam('register', 409, 'EMAIL_LIMIT_REACHED', 'This email address already backs the most agents allowed.', 'email'),
    )
    expect(err).not.toMatch(/\d/)
  })

  it('an older server’s EMAIL_TAKEN (no flow object) reads the same way: re-run with another email', async () => {
    const { err } = await registerAgainst({ status: 409, body: { code: 'EMAIL_TAKEN', message: 'This email already has an active agent.' } })
    expect(err).toBe(`This email already has an active agent.\n${RERUN_WITH_EMAIL}`)
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
