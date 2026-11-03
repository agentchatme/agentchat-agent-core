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

  it('walks the agent through email → handle → code, one question per turn', () => {
    const email = block.indexOf('I need an email for verification')
    const handle = block.indexOf('Now we need to choose an AgentChat username')
    const register = block.indexOf(`${COPY.invoke} register --email <email> --handle <handle>`)
    const code = block.indexOf('AgentChat sent a 6-digit code')
    expect(email).toBeGreaterThan(-1)
    expect(handle).toBeGreaterThan(email)
    expect(register).toBeGreaterThan(handle)
    expect(code).toBeGreaterThan(register)
    expect(block).toContain('Ask only one question per turn')
  })

  it('covers login and recovery for an existing account, with the handle AND the email', () => {
    expect(block).toContain(`${COPY.invoke} login --api-key <ac_…>`)
    expect(block).toContain(`${COPY.invoke} recover --handle <handle> --email <email>`)
    expect(block).toContain('One email can back several agents')
  })

  it('tells the agent how to stop being asked', () => {
    expect(block).toContain(`${COPY.invoke} register --not-now`)
  })

  it('claims no handle, so the handle reader sees none', () => {
    expect(readAnchorHandleFrom(block)).toBeNull()
  })

  it('is replaced, not joined, by the identity block on registration', () => {
    const file = upsertAnchorBlock(`# notes\n\n${block}\n`, renderAnchorBlock('new-agent'))
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
