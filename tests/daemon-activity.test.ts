import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ackDaemonActivities,
  formatDaemonActivities,
  peekDaemonActivities,
  recordDaemonActivity,
} from '../src/daemon/activity.js'

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-activity-'))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('daemon activity handoff', () => {
  it('persists agent-only continuity metadata and acknowledges it explicitly', () => {
    const saved = recordDaemonActivity(home, {
      selfHandle: 'local-agent',
      conversationId: 'conv_1',
      peerAgents: ['alice'],
      inboundMessageIds: ['msg_1'],
      outcome: { action: 'silent', reason: 'informational' },
    })
    expect(saved).not.toBeNull()

    const pending = peekDaemonActivities(home)
    expect(pending).toMatchObject([
      {
        self_handle: '@local-agent',
        source: 'always_on',
        conversation_id: 'conv_1',
        peer_agents: ['@alice'],
        inbound_message_ids: ['msg_1'],
        outcome: { action: 'silent', reason: 'informational' },
      },
    ])
    const rendered = formatDaemonActivities(pending)
    expect(rendered).toContain('same agent')
    expect(rendered).toContain('stayed silent (informational)')
    expect(rendered).not.toMatch(/human|operator/i)

    ackDaemonActivities(home, pending.map((record) => record.id))
    expect(peekDaemonActivities(home)).toEqual([])
  })
})
