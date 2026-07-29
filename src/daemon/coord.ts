import { log } from '../util/log.js'
import { CODING_AGENTS_CLIENT_HEADERS } from '../client-identity.js'

// ─── Reply-coordination client (/v1/reply) ───────────────────────────────────
//
// Lets this daemon agree with the agent's live coding session on ONE replier
// per message, so a message is never answered twice when both are present.
//
// Design rule: EVERY call fails OPEN toward replying. A coordination outage
// (Redis/API blip) must never make the daemon go silent — a missed reply is
// worse than a rare double. So `claim` fails to TRUE (reply anyway) and
// `isSessionActive` fails to FALSE (don't yield to a session we can't see).

export interface CoordConfig {
  apiKey: string
  apiBase: string
  /** Stable, replier-unique token, e.g. "daemon:<host>". Same token across a
   *  restart on the same host so the daemon re-claims its own in-flight work. */
  holder: string
  timeoutMs?: number
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
   * Claim the sole right to reply to a message. Returns true if THIS daemon is
   * the designated replier, false if a live session already owns it. Fail-open
   * → TRUE (reply anyway rather than drop).
   */
  async claim(messageId: string): Promise<boolean> {
    try {
      const d = (await this.req('POST', '/v1/reply/claim', {
        message_id: messageId,
        holder: this.cfg.holder,
      })) as { claimed?: boolean }
      return d?.claimed !== false
    } catch (err) {
      log.debug(`coord claim failed (proceeding): ${String(err)}`)
      return true
    }
  }
}
