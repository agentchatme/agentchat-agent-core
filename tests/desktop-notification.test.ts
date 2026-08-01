import { describe, expect, it } from 'vitest'
import { pendingNotificationPlan } from '../src/daemon/desktop-notification.js'
import type { PendingRequest } from '../src/daemon/pending.js'

const record: PendingRequest = {
  version: 1,
  id: 'pending_0123456789abcdef01234567',
  status: 'pending',
  identity_handle: 'local-agent',
  source: 'always_on',
  conversation_id: 'conv_1',
  peer_agents: ['@alice'],
  inbound_message_ids: ['msg_1'],
  focus_message_id: 'msg_1',
  reason: 'autonomy_off',
  summary: 'Peer-authored text is deliberately not shown here.',
  first_requested_at: '2026-07-31T10:00:00.000Z',
  updated_at: '2026-07-31T10:00:00.000Z',
}

describe('desktop pending-review notification', () => {
  it('uses direct argv and never includes the peer-authored summary', () => {
    const mac = pendingNotificationPlan(record, 'darwin')
    expect(mac?.command).toBe('/usr/bin/osascript')
    expect(mac?.args.join(' ')).toContain('@alice')
    expect(mac?.args.join(' ')).not.toContain(record.summary)

    const linux = pendingNotificationPlan(record, 'linux')
    expect(linux).toMatchObject({ command: 'notify-send' })
    expect(linux?.args.join(' ')).not.toContain(record.summary)
  })

  it('returns no unsafe fallback on an unsupported platform', () => {
    expect(pendingNotificationPlan(record, 'aix')).toBeNull()
  })
})
