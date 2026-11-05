import * as path from 'node:path'
import { z } from 'zod'
import { atomicWriteFile, readJsonFile } from '../util/fsutil.js'
import { log } from '../util/log.js'

// ─── Which invites were already offered to a run ────────────────────────────
//
// The server pushes a group invite live once and never re-offers it, so on
// every connect the integration lists the pending invites and offers each to
// a run. "Offered" used to live in process memory, which meant a daemon
// restart offered every still-pending invite again — one paid run per invite,
// per restart, for as long as the agent left them pending. The set now lives
// in the identity home: an invite id is recorded once its run has actually
// started, and never offered again from this machine. An invite whose run did
// not start is deliberately NOT recorded, so the next wake (and the next
// connect's listing) offers it again instead of losing it.
//
// Bounded and private to the user: ids and timestamps only.

export const OFFERED_INVITES_FILE = 'invites.offered.json'
const MAX_REMEMBERED = 1_000

const Schema = z.object({
  version: z.literal(1),
  offered: z.array(z.object({ id: z.string(), at: z.string() })),
})

/** The seam the invoker uses; `OfferedInvites` is the on-disk implementation. */
export interface OfferedInviteStore {
  has(inviteId: string): boolean
  add(inviteId: string): void
}

export function offeredInvitesPath(home: string): string {
  return path.join(home, OFFERED_INVITES_FILE)
}

export class OfferedInvites implements OfferedInviteStore {
  private readonly entries: Array<{ id: string; at: string }>

  /** `home === null` keeps the set in memory only (tests). */
  constructor(
    private readonly home: string | null,
    entries: Array<{ id: string; at: string }> = [],
    private readonly now: () => Date = () => new Date(),
  ) {
    this.entries = entries.slice(-MAX_REMEMBERED)
  }

  /** Read the set from the identity home; a missing or malformed file is an empty set. */
  static load(home: string, now?: () => Date): OfferedInvites {
    const parsed = Schema.safeParse(readJsonFile<unknown>(offeredInvitesPath(home)))
    return new OfferedInvites(home, parsed.success ? parsed.data.offered : [], now)
  }

  get size(): number {
    return this.entries.length
  }

  has(inviteId: string): boolean {
    return this.entries.some((entry) => entry.id === inviteId)
  }

  add(inviteId: string): void {
    if (this.has(inviteId)) return
    this.entries.push({ id: inviteId, at: this.now().toISOString() })
    while (this.entries.length > MAX_REMEMBERED) this.entries.shift()
    this.persist()
  }

  private persist(): void {
    if (this.home === null) return
    try {
      atomicWriteFile(
        offeredInvitesPath(this.home),
        `${JSON.stringify({ version: 1, offered: this.entries } satisfies z.infer<typeof Schema>, null, 2)}\n`,
        0o600,
      )
    } catch (err) {
      // Best effort: the worst case is one repeated invite run after a restart.
      log.debug(`offered-invites write failed: ${String(err)}`)
    }
  }
}
