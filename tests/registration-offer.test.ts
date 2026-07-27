import { describe, expect, it } from 'vitest'
import { formatRegistrationOffer } from '../src/digest/summary.js'

// ─── The first thing a new user ever sees ───────────────────────────────────
//
// This block is injected into a session that has the integration but no handle.
// The first real install showed two defects in it:
//
//  1. It claimed "Always-on is already running" unconditionally — including in
//     a session where registering the service had just failed. The user was
//     told the feature was up at the exact moment it was not.
//
//  2. It was a numbered runbook of CLI invocations, so the agent recited it.
//     A person who had just installed a plugin was handed `--email`/`--code`
//     syntax instead of being asked a question.

const COPY = { invoke: 'npx -y @agentchatme/codex', label: 'Codex', peerLabel: 'Claude Code', peerInvoke: 'x' }

describe('it never claims always-on is running when it is not', () => {
  it('says so plainly when it is not set up', () => {
    const s = formatRegistrationOffer(COPY, 'off')
    expect(s).toMatch(/not set up/i)
    expect(s).not.toMatch(/Always-on is running/i)
  })

  it('only the connected state says it is running', () => {
    expect(formatRegistrationOffer(COPY, 'connected')).toMatch(/Always-on is running/i)
    for (const st of ['off', 'idle', 'starting', 'down'] as const) {
      expect(formatRegistrationOffer(COPY, st), `${st} must not claim it is running`).not.toMatch(
        /Always-on is running/i,
      )
    }
  })

  it('a down daemon is reported as down, with where to look', () => {
    const s = formatRegistrationOffer(COPY, 'down')
    expect(s).toMatch(/not running/i)
    expect(s).toContain('daemon status')
    // …and never with an unrendered placeholder, which is what shipped when the
    // note was first split out of the template.
    expect(s).not.toContain('{invoke}')
  })

  it('idle and starting are honest without alarming — nothing is wrong yet', () => {
    for (const st of ['idle', 'starting'] as const) {
      const s = formatRegistrationOffer(COPY, st)
      expect(s).toMatch(/set up/i)
      expect(s).not.toMatch(/not running/i)
    }
  })
})

describe('it instructs the agent, it is not a script to read aloud', () => {
  it('says outright that the commands are the agent’s to run', () => {
    const s = formatRegistrationOffer(COPY, 'off')
    expect(s).toMatch(/yours to run, not to show/i)
    expect(s).toMatch(/do not paste this block/i)
  })

  it('asks for one plain sentence, not a walkthrough', () => {
    const s = formatRegistrationOffer(COPY, 'off')
    expect(s).toMatch(/ONE plain sentence/i)
    // The numbered-steps shape is what got recited. It must not come back.
    expect(s).not.toMatch(/^\s*\d\.\s/m)
  })

  it('still carries every command the agent needs', () => {
    const s = formatRegistrationOffer(COPY, 'off')
    for (const c of ['register --email', 'register --code', 'login --api-key', 'recover --email', 'recover --code']) {
      expect(s, `agent needs ${c}`).toContain(c)
    }
    expect(s).toContain('--not-now')
  })

  it('names the host it is speaking to', () => {
    expect(formatRegistrationOffer(COPY, 'off')).toContain('Codex')
    expect(formatRegistrationOffer({ ...COPY, label: 'Claude Code' }, 'off')).toContain('Claude Code')
  })
})
