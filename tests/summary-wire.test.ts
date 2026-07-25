import { afterEach, describe, expect, it, vi } from 'vitest'
import { digestConversations, formatSessionStart, formatStopPickup } from '../src/digest/summary.js'
import { syncPeek, syncAck, lastDeliveryId, type SyncRow } from '../src/wire/index.js'

function row(overrides: Partial<SyncRow> & { id: string }): SyncRow {
  return {
    conversation_id: 'conv_1',
    delivery_id: `del_${'0'.repeat(30)}${overrides.id.padStart(2, '0')}`,
    sender: 'mike-asst',
    type: 'text',
    content: { text: `hello ${overrides.id}` },
    created_at: '2026-07-08T00:00:00Z',
    ...overrides,
  } as SyncRow
}

describe('digestConversations', () => {
  it('groups rows per conversation, keeps latest snippet, unions senders', () => {
    const digests = digestConversations([
      row({ id: '1', conversation_id: 'conv_a', sender: 'mike-asst' }),
      row({ id: '2', conversation_id: 'conv_a', sender: 'san-asst', content: { text: 'newest' } }),
      row({ id: '3', conversation_id: 'grp_team', sender: 'vellum-noir' }),
    ])
    expect(digests).toHaveLength(2)
    const a = digests.find((d) => d.conversationId === 'conv_a')!
    expect(a.count).toBe(2)
    expect(a.senders).toEqual(['mike-asst', 'san-asst'])
    expect(a.latestSnippet).toBe('newest')
    expect(a.isGroup).toBe(false)
    expect(digests.find((d) => d.conversationId === 'grp_team')!.isGroup).toBe(true)
  })

  it('reads the sender from the live wire field `sender`, falling back to `sender_handle`', () => {
    // Live-fire 2026-07-12: prod /v1/messages/sync rows carry `sender`
    // (public-message shape), NOT the dashboard-RPC `sender_handle`. A
    // regression back to sender_handle-only rendered every digest sender
    // as @unknown.
    const [primary] = digestConversations([row({ id: '1', sender: 'real-sender' })])
    expect(primary!.senders).toEqual(['real-sender'])
    const legacyRow = row({ id: '2' }) as Record<string, unknown>
    delete legacyRow['sender']
    legacyRow['sender_handle'] = 'legacy-sender'
    const [fallback] = digestConversations([legacyRow as never])
    expect(fallback!.senders).toEqual(['legacy-sender'])
  })

  it('flattens whitespace and truncates long snippets', () => {
    const long = 'x'.repeat(500)
    const [d] = digestConversations([row({ id: '1', content: { text: `a\n\n b\t${long}` } })])
    expect(d!.latestSnippet.length).toBeLessThanOrEqual(140)
    expect(d!.latestSnippet).toContain('a b')
    expect(d!.latestSnippet.endsWith('…')).toBe(true)
  })

  it('labels non-text messages by type instead of crashing', () => {
    const [d] = digestConversations([row({ id: '1', type: 'attachment', content: {} })])
    expect(d!.latestSnippet).toBe('[attachment]')
  })

  it('carries the newest created_at as latestCreatedAt (for the recency cue)', () => {
    const [d] = digestConversations([
      row({ id: '1', created_at: '2026-07-08T00:00:00Z' }),
      row({ id: '2', created_at: '2026-07-08T01:00:00Z', content: { text: 'newest' } }),
    ])
    expect(d!.latestCreatedAt).toBe('2026-07-08T01:00:00Z')
  })
})

describe('formatters', () => {
  it('session-start digest states identity, counts, and skill-directed triage', () => {
    const text = formatSessionStart('demo-agent', [
      row({ id: '1' }),
      row({ id: '2', conversation_id: 'grp_g', sender: 'aleph-null' }),
    ])
    expect(text).toContain('You are @demo-agent on AgentChat.')
    expect(text).toContain('2 unread messages in 2 conversations:')
    expect(text).toContain('@mike-asst')
    expect(text).toContain('group grp_g')
    expect(text).toContain('silence, not acknowledgments')
  })

  it('stop digest allows ending the turn in silence', () => {
    const text = formatStopPickup('demo-agent', [row({ id: '1' })])
    expect(text).toContain('While you were working, 1 AgentChat message arrived for @demo-agent')
    expect(text).toContain('silence is a valid outcome')
  })

  it('names the group and flags a mention from the server context block', () => {
    const base = row({ id: '1', conversation_id: 'grp_ops', sender: 'bob' })
    const enriched = {
      ...base,
      context: { conversation: { group_name: 'Ops' }, mentions: ['demo-agent'] },
    } as unknown as SyncRow
    const text = formatSessionStart('demo-agent', [enriched])
    expect(text).toContain('group "Ops"')
    expect(text).toContain('mentions you')
    // A different agent's mention does not flag this one.
    const other = formatSessionStart('someone-else', [enriched])
    expect(other).not.toContain('mentions you')
  })

  it('adds a relative recency cue to each digest line', () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-07-08T02:00:00Z')) // 2h after the fixture created_at
    const text = formatSessionStart('demo-agent', [row({ id: '1' })])
    expect(text).toContain('latest 2 hours ago')
    // recency rides alongside the existing fields, not instead of them
    expect(text).toContain('"hello 1"')
    vi.useRealTimers()
  })
})

describe('wire client', () => {
  const cfg = { apiKey: 'ac_test_0123456789abcdef0123', apiBase: 'https://api.example.test' }

  afterEach(() => vi.unstubAllGlobals())

  function stubFetch(payload: unknown, status = 200) {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL | string, init?: RequestInit) => {
        calls.push({ url: String(url), init })
        return new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
    return calls
  }

  it('syncPeek parses the production bare-array shape', async () => {
    const calls = stubFetch([row({ id: '1' }), row({ id: '2' })])
    const rows = await syncPeek(cfg, { limit: 50, after: 'del_' + 'a'.repeat(32) })
    expect(rows).toHaveLength(2)
    expect(calls[0]!.url).toContain('/v1/messages/sync?limit=50&after=del_')
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toContain('Bearer ac_test_')
  })

  it('syncPeek skips malformed rows and survives a non-array payload', async () => {
    stubFetch([row({ id: '1' }), { nope: true }])
    expect(await syncPeek(cfg)).toHaveLength(1)
    vi.unstubAllGlobals()
    stubFetch({ envelopes: [] }) // the OLD (wrong) SDK-era shape must not crash us
    expect(await syncPeek(cfg)).toHaveLength(0)
  })

  it('syncAck posts the string cursor and returns acked count', async () => {
    const calls = stubFetch({ acked: 7 })
    const acked = await syncAck(cfg, 'del_' + 'b'.repeat(32))
    expect(acked).toBe(7)
    expect(calls[0]!.url).toContain('/v1/messages/sync/ack')
    expect(JSON.parse(String(calls[0]!.init?.body))).toStrictEqual({
      last_delivery_id: 'del_' + 'b'.repeat(32),
    })
  })

  it('lastDeliveryId returns the newest non-null cursor', () => {
    const rows = [row({ id: '1' }), row({ id: '2', delivery_id: null }), row({ id: '3' })]
    expect(lastDeliveryId(rows)).toBe(rows[2]!.delivery_id)
    expect(lastDeliveryId([row({ id: '9', delivery_id: null })])).toBeNull()
    expect(lastDeliveryId([])).toBeNull()
  })
})
