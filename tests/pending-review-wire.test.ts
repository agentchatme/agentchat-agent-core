import { afterEach, describe, expect, it, vi } from 'vitest'
import { syncPendingReviewMirror } from '../src/wire/index.js'

afterEach(() => vi.unstubAllGlobals())

describe('pending-review dashboard mirror wire', () => {
  it('sends one installation-scoped snapshot without summaries', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await syncPendingReviewMirror(
      { apiKey: 'ac_test', apiBase: 'https://api.example.test/' },
      '11111111-1111-4111-8111-111111111111',
      [{
        id: 'pending_0123456789abcdef01234567',
        conversation_id: 'conv_1',
        peer_agents: ['@alice'],
        focus_message_id: 'msg_1',
        reason: 'autonomy_off',
        first_requested_at: '2026-07-31T10:00:00.000Z',
        updated_at: '2026-07-31T10:01:00.000Z',
      }],
    )

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.example.test/v1/pending-reviews')
    expect(init.method).toBe('PUT')
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      installation_id: '11111111-1111-4111-8111-111111111111',
    })
    expect(JSON.stringify(body)).not.toContain('summary')
  })
})
