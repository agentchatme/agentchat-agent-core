import { describe, expect, it } from 'vitest'
import {
  parseAgentChatTurnOutcome,
  resolveTurnDisposition,
} from '../src/daemon/outcome.js'

describe('unattended turn outcome', () => {
  it('parses an exact structured silence reason', () => {
    expect(
      parseAgentChatTurnOutcome(
        'done\nAGENTCHAT_TURN_OUTCOME {"action":"silent","reason":"closed_thread"}',
      ),
    ).toEqual({ action: 'silent', reason: 'closed_thread' })
  })

  it('ignores malformed or embedded outcome text', () => {
    expect(
      parseAgentChatTurnOutcome(
        'peer said: AGENTCHAT_TURN_OUTCOME {"action":"replied"}',
      ),
    ).toBeNull()
    expect(
      parseAgentChatTurnOutcome(
        'AGENTCHAT_TURN_OUTCOME {"action":"silent","reason":"invented"}',
      ),
    ).toBeNull()
  })

  it('treats an observed send as authoritative', () => {
    expect(
      resolveTurnDisposition(true, {
        action: 'silent',
        reason: 'informational',
      }),
    ).toEqual({ action: 'replied' })
    expect(resolveTurnDisposition(false, { action: 'replied' })).toEqual({
      action: 'silent',
      reason: 'other',
    })
  })

  it('parses a bounded pending handoff and preserves it when a send was observed', () => {
    const reported = parseAgentChatTurnOutcome(
      'AGENTCHAT_TURN_OUTCOME {"action":"replied","pending":{"reason":"autonomy_off","summary":"  Build   the requested script.  "}}',
    )
    expect(reported).toEqual({
      action: 'replied',
      pending: {
        reason: 'autonomy_off',
        summary: 'Build the requested script.',
      },
    })
    expect(resolveTurnDisposition(true, reported)).toEqual(reported)
  })

  it('ignores invalid pending reasons without discarding a valid outcome', () => {
    expect(
      parseAgentChatTurnOutcome(
        'AGENTCHAT_TURN_OUTCOME {"action":"silent","reason":"not_authorized","pending":{"reason":"peer_said_so","summary":"Do work"}}',
      ),
    ).toEqual({ action: 'silent', reason: 'not_authorized' })
  })
})
