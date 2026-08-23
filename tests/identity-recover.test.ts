import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentChatClient, AgentChatError, HttpTransport } from 'agentchatme'
import { createIdentityCommands } from '../src/identity/commands.js'
import {
  readCredentials,
  readPending,
  writeCredentials,
  writePending,
} from '../src/identity/credentials.js'
import type { HostProfile } from '../src/identity/host-profile.js'

// ─── Recovery names an agent by handle AND email ────────────────────────────
//
// One email can back several agents, so "recover the agent on this email" is
// no longer a well-formed request. The engine must always send the handle,
// find it without being told when it can (this agent's own stored handle),
// refuse clearly when it cannot, and cope with the one server answer a
// compliant client never provokes (HANDLE_REQUIRED).

const homes: string[] = []
const INVOKE = 'npx -y @agentchatme/example'

function fixture(): { home: string; commands: ReturnType<typeof createIdentityCommands> } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-recover-'))
  homes.push(home)
  const profile: HostProfile = {
    label: 'Example',
    id: 'example',
    home: () => home,
    anchorFile: () => path.join(home, 'ANCHOR.md'),
    invocation: () => INVOKE,
    renderAnchor: (handle) => `@${handle}`,
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

/** Script the server's answer; `null` is the pending-less shape of an older server. */
function serverAccepts(pendingId: string | null = 'pnd_abc') {
  return vi.spyOn(HttpTransport.prototype, 'request').mockResolvedValue({
    data: {
      ...(pendingId !== null ? { pending_id: pendingId } : {}),
      message: 'If an agent is registered with that email, a recovery code was sent to it.',
    },
    headers: new Headers(),
    status: 200,
    requestId: null,
  } as never)
}

const originalStdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
const originalStdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

beforeEach(() => {
  nonInteractive()
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalStdinTty) Object.defineProperty(process.stdin, 'isTTY', originalStdinTty)
  if (originalStdoutTty) Object.defineProperty(process.stdout, 'isTTY', originalStdoutTty)
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

describe('starting recovery', () => {
  it('sends handle and email together to POST /v1/agents/recover and remembers both', async () => {
    const { home, commands } = fixture()
    const request = serverAccepts('pnd_123')
    const { out } = capture()

    expect(await commands.runRecover({ email: 'Owner@Example.com', handle: 'my-agent' })).toBe(0)

    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('POST', '/v1/agents/recover', {
      body: { email: 'owner@example.com', handle: 'my-agent' },
      retry: 'never',
    })
    expect(readPending(home)).toMatchObject({
      kind: 'recover',
      pending_id: 'pnd_123',
      email: 'owner@example.com',
      handle: 'my-agent',
    })
    const rendered = out.join('\n')
    expect(rendered).toContain(`${INVOKE} recover --code <6-digit-code>`)
    expect(rendered).toContain('@my-agent')
    // The server never confirms that an account exists; neither may we.
    expect(rendered).not.toMatch(/^Recovery code sent/m)
  })

  it('accepts the handle with a leading @ and in any case', async () => {
    const { commands } = fixture()
    const request = serverAccepts()
    capture()

    expect(await commands.runRecover({ email: 'owner@example.com', handle: '@My-Agent' })).toBe(0)

    expect(request.mock.calls[0]?.[2]).toMatchObject({ body: { handle: 'my-agent' } })
  })

  it('defaults to this agent’s stored handle when --handle is omitted', async () => {
    const { home, commands } = fixture()
    writeCredentials(home, { api_key: `ac_${'k'.repeat(32)}`, handle: 'stored-agent' })
    const request = serverAccepts()
    const { out } = capture()

    expect(await commands.runRecover({ email: 'owner@example.com' })).toBe(0)

    expect(request.mock.calls[0]?.[2]).toMatchObject({
      body: { email: 'owner@example.com', handle: 'stored-agent' },
    })
    expect(out.join('\n')).toContain('Recovering @stored-agent')
    expect(out.join('\n')).toContain('--handle')
  })

  it('an explicit --handle beats the stored one', async () => {
    const { home, commands } = fixture()
    writeCredentials(home, { api_key: `ac_${'k'.repeat(32)}`, handle: 'stored-agent' })
    const request = serverAccepts()
    const { out } = capture()

    expect(await commands.runRecover({ email: 'owner@example.com', handle: 'other-agent' })).toBe(0)

    expect(request.mock.calls[0]?.[2]).toMatchObject({ body: { handle: 'other-agent' } })
    expect(out.join('\n')).not.toContain('Recovering @stored-agent')
  })

  it('with no stored handle and no TTY it fails naming --handle, without touching the network', async () => {
    const { home, commands } = fixture()
    const request = serverAccepts()
    const { err } = capture()

    expect(await commands.runRecover({ email: 'owner@example.com' })).toBe(1)

    expect(request).not.toHaveBeenCalled()
    expect(readPending(home)).toBeNull()
    const rendered = err.join('\n')
    expect(rendered).toContain('Missing --handle')
    expect(rendered).toContain(`${INVOKE} recover --handle <handle> --email <email>`)
    expect(rendered).toMatch(/more than one agent/i)
  })

  it('with no email and no TTY it fails naming --email', async () => {
    const { commands } = fixture()
    const request = serverAccepts()
    const { err } = capture()

    expect(await commands.runRecover({ handle: 'my-agent' })).toBe(1)

    expect(request).not.toHaveBeenCalled()
    expect(err.join('\n')).toContain('Missing --email')
    expect(err.join('\n')).toContain(`${INVOKE} recover --handle <handle> --email <email>`)
  })

  it('rejects an invalid handle locally', async () => {
    const { commands } = fixture()
    const request = serverAccepts()
    const { err } = capture()

    expect(await commands.runRecover({ email: 'owner@example.com', handle: 'x' })).toBe(1)

    expect(request).not.toHaveBeenCalled()
    expect(err.join('\n')).toMatch(/Handle "@x" is invalid/)
  })

  it('rejects a non-email locally', async () => {
    const { commands } = fixture()
    const request = serverAccepts()
    const { err } = capture()

    expect(await commands.runRecover({ email: 'not-an-email', handle: 'my-agent' })).toBe(1)

    expect(request).not.toHaveBeenCalled()
    expect(err.join('\n')).toMatch(/does not look like an email address/)
  })

  it('relays a not-yet-upgraded server’s pending-less answer and stores nothing', async () => {
    const { home, commands } = fixture()
    serverAccepts(null)
    const { out } = capture()

    expect(await commands.runRecover({ email: 'owner@example.com', handle: 'my-agent' })).toBe(0)

    expect(readPending(home)).toBeNull()
    expect(out.join('\n')).toContain('If an agent is registered with that email')
  })

  it('reports a server rejection and stores nothing', async () => {
    const { home, commands } = fixture()
    vi.spyOn(HttpTransport.prototype, 'request').mockRejectedValue(
      new AgentChatError({ code: 'VALIDATION_ERROR', message: 'email: invalid' }, 400),
    )
    const { err } = capture()

    expect(await commands.runRecover({ email: 'owner@example.com', handle: 'my-agent' })).toBe(1)

    expect(readPending(home)).toBeNull()
    expect(err.join('\n')).toContain('Recovery failed.')
    expect(err.join('\n')).toContain('VALIDATION_ERROR')
  })
})

describe('completing recovery', () => {
  it('the completion hint names both flags when nothing is pending', async () => {
    const { commands } = fixture()
    const { err } = capture()

    expect(await commands.runRecover({ code: '123456' })).toBe(1)

    expect(err.join('\n')).toContain(`${INVOKE} recover --handle <handle> --email <email>`)
  })

  it('HANDLE_REQUIRED lists the handles, says to re-run with one, and drops the spent pending record', async () => {
    const { home, commands } = fixture()
    writePending(home, {
      kind: 'recover',
      pending_id: 'pnd_ambiguous',
      email: 'owner@example.com',
      created_at: new Date().toISOString(),
    })
    vi.spyOn(AgentChatClient, 'recoverVerify').mockRejectedValue(
      new AgentChatError(
        {
          code: 'HANDLE_REQUIRED',
          message: 'This email backs more than one agent. Run recovery again with the handle you want to recover.',
          details: { handles: ['first-agent', 'second-agent'] },
        },
        409,
      ),
    )
    const { err } = capture()

    expect(await commands.runRecover({ code: '123456' })).toBe(1)

    const rendered = err.join('\n')
    expect(rendered).toContain('@first-agent')
    expect(rendered).toContain('@second-agent')
    expect(rendered).toContain(`${INVOKE} recover --handle <handle> --email <email>`)
    expect(readPending(home)).toBeNull()
    expect(readCredentials(home)).toBeNull()
  })

  it('HANDLE_REQUIRED without a handle list still says what to do', async () => {
    const { home, commands } = fixture()
    writePending(home, {
      kind: 'recover',
      pending_id: 'pnd_ambiguous',
      email: 'owner@example.com',
      created_at: new Date().toISOString(),
    })
    vi.spyOn(AgentChatClient, 'recoverVerify').mockRejectedValue(
      new AgentChatError({ code: 'HANDLE_REQUIRED', message: 'handle required' }, 409),
    )
    const { err } = capture()

    expect(await commands.runRecover({ code: '123456' })).toBe(1)

    expect(err.join('\n')).toContain('recover --handle <handle> --email <email>')
    expect(err.join('\n')).not.toContain('Agents on this email')
  })

  it('a wrong code keeps the pending record so the code can be retried', async () => {
    const { home, commands } = fixture()
    writePending(home, {
      kind: 'recover',
      pending_id: 'pnd_live',
      email: 'owner@example.com',
      handle: 'my-agent',
      created_at: new Date().toISOString(),
    })
    vi.spyOn(AgentChatClient, 'recoverVerify').mockRejectedValue(
      new AgentChatError({ code: 'INVALID_CODE', message: 'wrong' }, 400),
    )
    capture()

    expect(await commands.runRecover({ code: '000000' })).toBe(1)

    expect(readPending(home)?.pending_id).toBe('pnd_live')
  })

  it('status names the handle a pending recovery is for', async () => {
    const { home, commands } = fixture()
    writePending(home, {
      kind: 'recover',
      pending_id: 'pnd_live',
      email: 'owner@example.com',
      handle: 'my-agent',
      created_at: new Date().toISOString(),
    })
    const { out } = capture()

    expect(await commands.runStatus({})).toBe(0)

    expect(out.join('\n')).toContain('recovery for @my-agent is waiting')
  })
})
