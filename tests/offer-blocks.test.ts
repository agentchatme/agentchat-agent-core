import { describe, expect, it } from 'vitest'
import { renderDeclinedBlock, renderUnregisteredBlock } from '../src/anchor/offer.js'
import { ANCHOR_END, ANCHOR_START, readAnchorHandleFrom, upsertAnchorBlock, renderAnchorBlock } from '../src/anchor/block.js'

// ─── The wizard's offer lives in the always-loaded file and must stop by itself ─

const COPY = { invoke: 'npx -y @agentchatme/example', label: 'Example' }

describe('the unregistered offer block', () => {
  const block = renderUnregisteredBlock(COPY)

  it('is fenced with the shared markers and names the host', () => {
    expect(block.startsWith(ANCHOR_START)).toBe(true)
    expect(block.endsWith(ANCHOR_END)).toBe(true)
    expect(block).toContain('this Example agent')
  })

  it('asks for the email, then the handle, then registers, one question per turn', () => {
    const email = block.indexOf('ask for their email')
    const handle = block.indexOf('then for the @handle they want')
    const register = block.indexOf(`${COPY.invoke} register --email <email> --handle <handle>`)
    expect(email).toBeGreaterThan(-1)
    expect(handle).toBeGreaterThan(email)
    expect(register).toBeGreaterThan(handle)
    expect(block).toContain('ask the user one question per turn')
  })

  it('has the agent relay each command’s answer and run the command it names', () => {
    expect(block).toContain('Each command prints AgentChat’s answer, then the command to run next')
    expect(block).toContain('Relay the answer to the user as it is')
    expect(block).toContain('such as the code AgentChat emailed them')
    expect(block).toContain('if it says to wait, wait')
    expect(block).toContain('exactly as the command printed them')
  })

  it('carries none of the server’s rules or wording: no handle rules, no code length, no scripted failure lines', () => {
    expect(block).not.toMatch(/3[–-]30|lowercase letters|trailing hyphens/)
    expect(block).not.toMatch(/6-digit|digits/)
    expect(block).not.toMatch(/If (the code|login|their handle)[^.]*fails|didn’t work|is taken or invalid/i)
    expect(block).not.toMatch(/register --code|recover --code/) // the commands print these themselves
  })

  it('covers login and recovery for an existing account, with the handle AND the email', () => {
    expect(block).toContain(`ask the user to run \`${COPY.invoke} login\` in their own terminal`)
    expect(block).not.toContain('--api-key')
    expect(block).toContain(`${COPY.invoke} recover --handle <handle> --email <email>`)
    expect(block).toContain('recovery replaces the old API key')
  })

  it('tells the agent how to stop being asked', () => {
    expect(block).toContain(`${COPY.invoke} register --not-now`)
  })

  it('claims no handle, so the handle reader sees none', () => {
    expect(readAnchorHandleFrom(block)).toBeNull()
  })

  it('is replaced, not joined, by the identity block on registration', () => {
    const file = upsertAnchorBlock(`# notes\n\n${block}\n`, renderAnchorBlock('I am @new-agent on AgentChat (api.agentchat.me). Served line, test copy.', 'new-agent'))
    expect(file.split(ANCHOR_START)).toHaveLength(2)
    expect(file).toContain('I am @new-agent on AgentChat')
    expect(file).not.toContain('no account yet')
    expect(file).toContain('# notes')
  })
})

describe('the declined block', () => {
  const block = renderDeclinedBlock(COPY)

  it('states the fact and instructs nothing', () => {
    expect(block).toContain('Do not offer to set it up')
    expect(block).not.toContain('Ask exactly')
    expect(block).toContain(`${COPY.invoke} register --email <email> --handle <handle>`)
  })
})
