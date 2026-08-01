import type {
  PendingTurnRequest,
  SilentReason,
  TurnDisposition,
} from './adapter-types.js'
import { PendingReasonSchema } from './pending.js'

const SILENT_REASONS = new Set<SilentReason>([
  'informational',
  'closed_thread',
  'not_actionable',
  'not_authorized',
  'other',
])

const MAX_PENDING_SUMMARY = 240

function pendingOf(value: unknown): PendingTurnRequest | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const pending = value as Record<string, unknown>
  const reason = PendingReasonSchema.safeParse(pending['reason'])
  if (
    !reason.success ||
    typeof pending['summary'] !== 'string' ||
    pending['summary'].trim().length === 0
  ) {
    return undefined
  }
  return {
    reason: reason.data,
    summary: pending['summary']
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_PENDING_SUMMARY),
  }
}

/** Parse only an exact, standalone assistant-output marker. Adapters pass
 * assistant text here, never tool results or peer-authored delivery data. */
export function parseAgentChatTurnOutcome(
  text: string,
): TurnDisposition | null {
  let parsed: TurnDisposition | null = null
  for (const line of text.split(/\r?\n/)) {
    const match = /^AGENTCHAT_TURN_OUTCOME (\{.*\})$/.exec(line.trim())
    if (!match) continue
    try {
      const value = JSON.parse(match[1] as string) as Record<string, unknown>
      const pending = pendingOf(value['pending'])
      if (value['action'] === 'replied') {
        parsed = {
          action: 'replied',
          ...(pending ? { pending } : {}),
        }
      } else if (
        value['action'] === 'silent' &&
        typeof value['reason'] === 'string' &&
        SILENT_REASONS.has(value['reason'] as SilentReason)
      ) {
        parsed = {
          action: 'silent',
          reason: value['reason'] as SilentReason,
          ...(pending ? { pending } : {}),
        }
      }
    } catch {
      // A malformed marker is treated as absent, never as turn failure.
    }
  }
  return parsed
}

/** Wire-observed sends are authoritative. A model cannot claim it replied
 * when no send completed, and a missing marker remains a valid silence. */
export function resolveTurnDisposition(
  sent: boolean,
  reported: TurnDisposition | null,
): TurnDisposition {
  if (sent) {
    return {
      action: 'replied',
      ...(reported?.pending ? { pending: reported.pending } : {}),
    }
  }
  if (reported?.action === 'silent') return reported
  return {
    action: 'silent',
    reason: 'other',
    ...(reported?.pending ? { pending: reported.pending } : {}),
  }
}
