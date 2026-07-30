import { log } from '../util/log.js'
import { CODING_AGENTS_CLIENT_HEADERS } from '../client-identity.js'

// ─── Reply-coordination client (/v1/reply) ───────────────────────────────────
//
// Lets this daemon agree with the agent's live coding session on ONE replier
// per message, so a message is never answered twice when both are present.
//
// Design rule: EVERY call fails OPEN toward replying. A coordination outage
// (Redis/API blip) must never make the daemon go silent — a missed reply is
// worse than a rare double. Atomic claims normally defer new daemon work while
// a foreground turn is leased; an outage degrades to replying.

export interface CoordConfig {
  apiKey: string
  apiBase: string
  /** Stable, replier-unique token, e.g. "daemon:<host>". Same token across a
   *  restart on the same host so the daemon re-claims its own in-flight work. */
  holder: string
  timeoutMs?: number
}

export interface ClaimOutcome {
  claimed: boolean
  deferred: boolean
}

export interface ClaimBatchOutcome {
  claimedCount: number
  deferred: boolean
}

export class ReplyCoord {
  constructor(private readonly cfg: CoordConfig) {}

  private async req(method: 'GET' | 'POST', pathname: string, body?: unknown): Promise<unknown> {
    const url = this.cfg.apiBase.replace(/\/+$/, '') + pathname
    const res = await fetch(url, {
      method,
      headers: {
        ...CODING_AGENTS_CLIENT_HEADERS,
        authorization: `Bearer ${this.cfg.apiKey}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 5_000),
    })
    if (!res.ok) throw new Error(`reply-coord ${res.status}`)
    return res.json()
  }

  /** Is the agent's live coding session actively working? Fail-open → FALSE. */
  async isSessionActive(): Promise<boolean> {
    try {
      const d = (await this.req('GET', '/v1/reply/active')) as { active?: boolean }
      return d?.active === true
    } catch (err) {
      log.debug(`coord isSessionActive failed (assuming inactive): ${String(err)}`)
      return false
    }
  }

  /**
   * Claim the sole right to reply to a message, atomically respecting any
   * foreground turn. Fail-open → claimed (reply anyway rather than drop).
   */
  async claim(messageId: string): Promise<ClaimOutcome> {
    try {
      const d = (await this.req('POST', '/v1/reply/claim', {
        message_id: messageId,
        holder: this.cfg.holder,
        defer_if_active: true,
      })) as { claimed?: boolean; deferred?: boolean }
      return {
        claimed: d?.claimed !== false,
        deferred: d?.deferred === true,
      }
    } catch (err) {
      log.debug(`coord claim failed (proceeding): ${String(err)}`)
      return { claimed: true, deferred: false }
    }
  }

  /**
   * Claim the contiguous oldest-first prefix of one conversation batch.
   * Falls back to ordered single-message claims against an older API server;
   * all other coordination failures remain fail-open.
   */
  async claimBatch(messageIds: string[]): Promise<ClaimBatchOutcome> {
    if (messageIds.length === 0) return { claimedCount: 0, deferred: false }
    try {
      const d = (await this.req('POST', '/v1/reply/claim-batch', {
        message_ids: messageIds,
        holder: this.cfg.holder,
        defer_if_active: true,
      })) as { claimed_count?: number; deferred?: boolean }
      const count = d?.claimed_count
      return {
        claimedCount:
          Number.isInteger(count) && (count as number) >= 0 && (count as number) <= messageIds.length
            ? (count as number)
            : messageIds.length,
        deferred: d?.deferred === true,
      }
    } catch (err) {
      if (!/reply-coord (404|405)\b/.test(String(err))) {
        log.debug(`coord batch claim failed (proceeding with all): ${String(err)}`)
        return { claimedCount: messageIds.length, deferred: false }
      }
    }

    let claimed = 0
    for (const messageId of messageIds) {
      const outcome = await this.claim(messageId)
      if (!outcome.claimed) {
        return { claimedCount: claimed, deferred: outcome.deferred }
      }
      claimed += 1
    }
    return { claimedCount: claimed, deferred: false }
  }
}
