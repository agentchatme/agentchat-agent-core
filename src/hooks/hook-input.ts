import { log } from '../util/log.js'

// ─── Hook stdin parsing ─────────────────────────────────────────────────────
//
// Every host pipes a JSON event object to the hook on stdin. We only need
// a session identifier (for the continuation cap) and the session-start
// `source` (to ignore compaction), and we must never fail if the shape
// surprises us: a hook that dies on parse breaks every session.

export interface HookInput {
  sessionId: string
  /** Claude Code SessionStart source: startup | resume | clear | compact | fork.
   *  Undefined on other hosts/events. */
  source: string | undefined
}

export async function readHookInput(stream: NodeJS.ReadStream = process.stdin): Promise<HookInput> {
  let raw = ''
  if (!stream.isTTY) {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk))
        if (Buffer.concat(chunks).length > 1_000_000) break // never buffer unbounded stdin
      }
      raw = Buffer.concat(chunks).toString('utf-8')
    } catch {
      raw = ''
    }
  }

  let parsed: Record<string, unknown> = {}
  if (raw.trim().length > 0) {
    try {
      const value = JSON.parse(raw)
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>
      }
    } catch {
      log.debug('hook stdin was not valid JSON; proceeding with defaults')
    }
  }

  const sessionId =
    firstString(parsed, ['session_id', 'sessionId', 'thread_id', 'conversation_id']) ?? 'unknown'
  const source = firstString(parsed, ['source']) ?? undefined

  return { sessionId, source }
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}
