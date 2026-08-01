import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  formatPendingRequestsNotice,
  getPendingRequest,
  listPendingRequests,
  pendingRequestId,
  pendingRequestsFingerprint,
  recordPendingRequest,
  resolvePendingRequest,
} from '../src/daemon/pending.js'

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-pending-'))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('local pending AgentChat requests', () => {
  it('deduplicates by identity and conversation while merging delivery references', () => {
    const first = recordPendingRequest(home, {
      selfHandle: 'local-agent',
      conversationId: 'conv_1',
      peerAgents: ['alice'],
      inboundMessageIds: ['msg_1'],
      focusMessageId: 'msg_1',
      reason: 'autonomy_off',
      summary: '  Build   the release script.  ',
    }, new Date('2026-07-31T10:00:00Z'))
    const second = recordPendingRequest(home, {
      selfHandle: '@local-agent',
      conversationId: 'conv_1',
      peerAgents: ['@alice', 'bob'],
      inboundMessageIds: ['msg_1', 'msg_2'],
      focusMessageId: 'msg_2',
      reason: 'sender_not_allowed',
      summary: 'Run the updated release request.',
    }, new Date('2026-07-31T10:05:00Z'))

    expect(second.id).toBe(first.id)
    expect(second).toMatchObject({
      peer_agents: ['@alice', '@bob'],
      inbound_message_ids: ['msg_1', 'msg_2'],
      focus_message_id: 'msg_2',
      first_requested_at: '2026-07-31T10:00:00.000Z',
      updated_at: '2026-07-31T10:05:00.000Z',
      reason: 'sender_not_allowed',
      summary: 'Run the updated release request.',
    })
    expect(listPendingRequests(home, 'local-agent')).toHaveLength(1)
  })

  it('never exposes one identity pending state to another identity', () => {
    const record = recordPendingRequest(home, {
      selfHandle: 'local-agent',
      conversationId: 'conv_secret',
      peerAgents: ['alice'],
      inboundMessageIds: ['msg_secret'],
      focusMessageId: 'msg_secret',
      reason: 'local_permission',
      summary: 'Needs a local permission.',
    })

    expect(listPendingRequests(home, 'other-agent')).toEqual([])
    expect(getPendingRequest(home, 'other-agent', record.id)).toBeNull()
    expect(resolvePendingRequest(home, 'other-agent', record.id)).toBe(false)
    expect(getPendingRequest(home, 'local-agent', record.id)).not.toBeNull()
  })

  it('uses stable safe ids, formats a concise notice, and resolves explicitly', () => {
    const record = recordPendingRequest(home, {
      selfHandle: 'local-agent',
      conversationId: 'conv_1',
      peerAgents: ['alice'],
      inboundMessageIds: ['msg_1'],
      focusMessageId: 'msg_1',
      reason: 'autonomy_off',
      summary: 'Create a script.',
    })
    expect(record.id).toBe(pendingRequestId('local-agent', 'conv_1'))
    expect(pendingRequestsFingerprint([record])).toMatch(/^[0-9a-f]{64}$/)
    expect(formatPendingRequestsNotice([record], {
      label: 'Test Host',
      invoke: 'agentchat-test',
    })).toContain('agentchat-test pending list')

    expect(resolvePendingRequest(home, 'local-agent', record.id)).toBe(true)
    expect(listPendingRequests(home, 'local-agent')).toEqual([])
  })
})
