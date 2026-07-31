import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { readHookInput } from '../src/hooks/hook-input.js'

function input(value: unknown): NodeJS.ReadStream {
  return Readable.from([JSON.stringify(value)]) as unknown as NodeJS.ReadStream
}

describe('hook input parsing', () => {
  it('reads the continuation proof emitted by both host hook protocols', async () => {
    await expect(
      readHookInput(
        input({
          session_id: 'session-1',
          stop_hook_active: true,
        }),
      ),
    ).resolves.toMatchObject({
      sessionId: 'session-1',
      stopHookActive: true,
    })

    await expect(
      readHookInput(
        input({
          sessionId: 'session-2',
          stopHookActive: false,
        }),
      ),
    ).resolves.toMatchObject({
      sessionId: 'session-2',
      stopHookActive: false,
    })
  })
})
