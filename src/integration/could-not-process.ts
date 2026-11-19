import * as path from 'node:path'
import { z } from 'zod'
import { atomicWriteFile, readJsonFile } from '../util/fsutil.js'
import { log } from '../util/log.js'

// ─── Could not process: the conversations paused for this agent ─────────────
//
// When a conversation's run keeps failing while the runtime otherwise works,
// the SDK kit reports it and the server decides (contract v1, "could not
// process"). Its last answer for a conversation can be `paused`: a 24 h mute
// for this agent with source `could_not_process`, ending on its own at
// `paused_until`. The server keeps that mute; this ledger is only what this
// machine was told, so `status` and `doctor` can say plainly which
// conversations are paused and until when — after a daemon restart too.
//
// One small owner-only file in the identity home, for one agent (its handle):
// conversation ids and times, never content. An entry leaves when its pause
// ends, when the server answers anything else for that conversation, or when
// a run for it completes (the pause is over: it was run).

export const COULD_NOT_PROCESS_FILE = 'could-not-process.json'

/** The most paused conversations kept (newest first); more is a ledger, not a status. */
const MAX_PAUSED = 100

export interface PausedConversation {
  readonly conversation_id: string
  /** When the pause (the server's 24 h mute) ends, as the server answered. */
  readonly paused_until: string
  /** When the server answered `paused`. */
  readonly at: string
}

const PausedSchema = z.object({ conversation_id: z.string().min(1), paused_until: z.string(), at: z.string() })
const FileSchema = z.object({ version: z.literal(1), handle: z.string(), paused: z.array(PausedSchema) })

export function couldNotProcessPath(home: string): string {
  return path.join(home, COULD_NOT_PROCESS_FILE)
}

function live(entry: PausedConversation, now: number): boolean {
  const until = Date.parse(entry.paused_until)
  return Number.isFinite(until) && until > now
}

/** The paused conversations this machine was told about, for one agent. */
export class PausedConversations {
  private entries: PausedConversation[]

  constructor(
    private readonly home: string,
    private readonly handle: string,
    private readonly now: () => number = Date.now,
  ) {
    const raw = readJsonFile<unknown>(couldNotProcessPath(home))
    const parsed = raw === null ? null : FileSchema.safeParse(raw)
    // Another agent's ledger (the home changed hands) is not this one's.
    this.entries = parsed?.success === true && parsed.data.handle === handle ? parsed.data.paused.filter((e) => live(e, this.now())) : []
  }

  /** The conversations paused now, newest answer first. */
  list(): PausedConversation[] {
    const now = this.now()
    return this.entries.filter((e) => live(e, now))
  }

  /** The server answered `paused` for this conversation, until `pausedUntil`. */
  record(conversationId: string, pausedUntil: string): void {
    if (!Number.isFinite(Date.parse(pausedUntil))) return
    const entry: PausedConversation = { conversation_id: conversationId, paused_until: pausedUntil, at: new Date(this.now()).toISOString() }
    this.entries = [entry, ...this.entries.filter((e) => e.conversation_id !== conversationId)].slice(0, MAX_PAUSED)
    this.persist()
  }

  /** The conversation is not paused (any other answer for it, or a run for it completed). */
  clear(conversationId: string): void {
    const before = this.entries.length
    this.entries = this.entries.filter((e) => e.conversation_id !== conversationId)
    if (this.entries.length !== before) this.persist()
  }

  /** Best effort: the ledger is diagnostics, never a dependency of waking. */
  private persist(): void {
    const now = this.now()
    this.entries = this.entries.filter((e) => live(e, now))
    try {
      atomicWriteFile(couldNotProcessPath(this.home), `${JSON.stringify({ version: 1, handle: this.handle, paused: this.entries }, null, 2)}\n`, 0o600)
    } catch (err) {
      log.debug(`could-not-process ledger write failed: ${String(err)}`)
    }
  }
}
