import { INBOX_TRAY_MAX_LIMIT, type AgentChatClient } from 'agentchatme'

// ─── Counts on the tray, never cards ────────────────────────────────────────
//
// One read through the SDK's `client.inbox.tray`, counted: card contents
// (the previews) are never read, kept or logged. Looking at the tray marks
// nothing delivered or read; delivered is the socket's ack on receipt, read is
// the agent's verdict inside its run. (Whether a wake deserves a run is the
// kit's receive loop: it reads the tray before every run.)

export type TrayClient = Pick<AgentChatClient, 'inbox'>

export interface TraySummary {
  /** Conversations with something waiting (cards on the tray). */
  waiting: number
  /** Conversations the agent deferred and that are hidden until their time. */
  deferred: number
  /** More conversations are waiting than one tray shows. */
  truncated: boolean
}

/** How many conversations are waiting, for `status`. One tray page, counted. */
export async function traySummary(client: TrayClient): Promise<TraySummary> {
  const tray = await client.inbox.tray({ limit: INBOX_TRAY_MAX_LIMIT })
  return {
    waiting: Array.isArray(tray.conversations) ? tray.conversations.length : 0,
    deferred: typeof tray.deferred === 'number' ? tray.deferred : 0,
    truncated: tray.truncated === true,
  }
}
