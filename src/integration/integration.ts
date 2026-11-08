import { AgentChatClient } from 'agentchatme'
import { log } from '../util/log.js'
import type { DaemonConfig } from '../daemon/config.js'
import { beat, idle } from '../daemon/health.js'
import { clientIdentityOf, type IntegrationClient } from '../client-identity.js'
import { IntegrationConnection, type InviteWake } from './connection.js'
import { IntegrationInvoker, PREFLIGHT_DEADLINE_MS } from './invoker.js'
import { OfferedInvites } from './invites.js'
import { buildRunPrompts, type RunPrompts } from './prompts.js'
import type { RunProfile } from './profile.js'
import type { RunRunner } from './runner.js'
import { writeIntegrationStatus, type IntegrationStatus, type SocketState } from './status.js'
import { TextsStore } from './texts.js'
import { ManualFollower, type ManualFetch } from '../skill/served-manual.js'
import { trayHasWaiting } from './tray.js'

// ─── The integration: a connection, an invoker, a runner ────────────────────
//
// Everything it knows about the agent arrives in `DaemonConfig`; everything it
// knows about the coding agent arrives as a `RunRunner`. It cannot name a
// host, so it cannot act on the wrong one.
//
// A WAKE IS NOT A RUN. Every wake — a `message.new` frame, a `wake` frame, the
// connect-time catch-up, a ladder re-wake — goes through the invoker, which
// reads one COUNT before it starts a run (`trayHasWaiting`: `GET /v1/inbox?
// limit=1` through the SDK, never a card, never a body, marks nothing read)
// and starts none when the tray is empty. That single guard is what makes
// reconnects cheap: sleep/wake, Wi-Fi roaming and every server deploy
// reconnect the whole fleet, and a reconnect with nothing unread costs a
// count, not a run.
//
// On `hello.ok` the integration therefore simply wakes once (catching a
// backlog no frame announced; it coalesces with whatever the server re-offers
// after the hello) and reads the pending group invites (`GET
// /v1/groups/invites` through the SDK): the server pushes an invite live only
// and never re-offers it, so an invite that arrived while the laptop was
// closed is surfaced here. Deduplicated downstream against the invites
// already offered from this machine. A failed invite read is logged, never
// fatal.
//
// The texts a run starts with are the server's (`GET /v1/texts`), fetched at
// start, refreshed daily, cached in the identity home for an offline start.
// The same texts announce the current manual; with a `manualPath` the skill
// file follows it on that cadence (`ManualFollower`: a download only when the
// announced version is not the one on disk, the old file kept on any failure).

const HEARTBEAT_MS = 30_000
const STATUS_MS = 30_000
/** HTTP calls the daemon makes are counts and texts; none deserves a long wait or the SDK's retry ramp. */
const HTTP_TIMEOUT_MS = 10_000

export interface IntegrationOptions {
  readonly cfg: DaemonConfig
  readonly runner: RunRunner
  /** How this integration names itself to the server (texts runtime + its version). */
  readonly client: IntegrationClient
  /** The one pointer line a run prompt ends with (`manualPointer(...)`). */
  readonly manualPointer: string
  /** The skill file that follows the served manual (`<skills dir>/agentchat/SKILL.md`); absent, the daemon leaves the manual to the CLI. */
  readonly manualPath?: string
  /** Injectable for tests; the manual download's `fetch`. */
  readonly manualFetch?: ManualFetch
  readonly profile: RunProfile
  readonly budgetMs: number
  /** Injectable for tests; defaults to a real connection on the SDK socket. */
  readonly connection?: IntegrationConnection
  /** Injectable for tests; defaults to an SDK client for `cfg`. */
  readonly api?: AgentChatClient
  /** Injectable for tests; defaults to a store on `api` and the identity home. */
  readonly texts?: TextsStore
}

export class Integration {
  private readonly api: AgentChatClient
  private readonly connection: IntegrationConnection
  private readonly texts: TextsStore
  private readonly manual: ManualFollower | null
  private readonly invoker: IntegrationInvoker
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private statusTimer: ReturnType<typeof setInterval> | null = null
  private lastError: string | null = null
  private stopping = false

  constructor(private readonly options: IntegrationOptions) {
    const { cfg, client } = options
    this.api =
      options.api ??
      new AgentChatClient({
        apiKey: cfg.apiKey,
        baseUrl: cfg.apiBase,
        clientIdentity: clientIdentityOf(client),
        timeoutMs: HTTP_TIMEOUT_MS,
        retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
      })
    this.manual =
      options.manualPath === undefined
        ? null
        : new ManualFollower({ path: options.manualPath, apiBase: cfg.apiBase, ...(options.manualFetch !== undefined ? { fetch: options.manualFetch } : {}) })
    this.texts =
      options.texts ??
      new TextsStore({ home: cfg.home, runtime: client.runtime, client: this.api, onChange: () => this.textsChanged() })
    this.invoker = new IntegrationInvoker({
      runner: options.runner,
      prompts: () => this.runPrompts(),
      budgetMs: options.budgetMs,
      onChange: () => this.writeStatus(),
      trayHasWaiting: () => trayHasWaiting(this.api),
      offeredInvites: OfferedInvites.load(cfg.home),
    })
    this.connection =
      options.connection ??
      new IntegrationConnection({ apiKey: cfg.apiKey, wsBase: cfg.wsBase, selfHandle: cfg.handle, client })
    this.connection.on('wake', (wake) => this.invoker.wake(wake.source))
    this.connection.on('invite', (invite) => {
      this.invoker.invite(invite)
    })
    this.connection.on('ready', () => {
      void this.catchUp()
    })
    this.connection.on('state', (state) => {
      if (state === 'ready') {
        beat(cfg.home)
        // An accepted hello lifts a refusal: the key works again.
        this.lastError = null
      } else {
        idle(cfg.home)
      }
      this.writeStatus()
    })
    this.connection.on('blocked', (detail) => {
      // A refused key is a state to show, not to die from: the SDK's client
      // stays up in `blocked` and tries a fresh hello every 10–15 min; `status`
      // reads `socket blocked` with this line as the last error until one is
      // accepted, or the user signs in with another key (a new connection).
      this.lastError = detail
      this.writeStatus()
    })
  }

  async start(): Promise<void> {
    // Bounded: a preflight that never answers must not hold the supervisor
    // (and with it the shutdown path) forever.
    let timer: ReturnType<typeof setTimeout> | null = null
    const pre = await Promise.race([
      this.options.runner.preflight(),
      new Promise<{ ok: false; detail: string }>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, detail: `preflight did not answer within ${Math.round(PREFLIGHT_DEADLINE_MS / 1000)} s` }), PREFLIGHT_DEADLINE_MS)
        timer.unref()
      }),
    ]).finally(() => {
      if (timer !== null) clearTimeout(timer)
    })
    if (!pre.ok) {
      throw new Error(`runtime (${this.options.runner.name}) not ready: ${pre.detail ?? 'unknown'}`)
    }
    log.info(
      `integration up as @${this.options.cfg.handle} via ${this.options.runner.name} (${this.options.client.runtime} ${this.options.client.version}), profile ${this.options.profile}; fetching the served texts, then holding the socket`,
    )
    // The start-time fetch settles before the socket opens, so the first wake
    // has the freshest text; a failure logs once and the cache (if any) serves.
    await this.texts.start()
    if (this.stopping) return
    this.connection.start()
    this.heartbeatTimer = setInterval(() => {
      if (this.connection.connected) beat(this.options.cfg.home)
    }, HEARTBEAT_MS)
    this.heartbeatTimer.unref()
    this.statusTimer = setInterval(() => this.writeStatus(), STATUS_MS)
    this.statusTimer.unref()
    this.writeStatus()
  }

  /**
   * Stop holding the socket and interrupt a run in flight (its process group
   * is SIGTERMed by the runner). Synchronous; `settled()` or `stopAndWait()`
   * tell when the run has actually ended.
   */
  stop(): void {
    if (this.stopping) return
    this.stopping = true
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.statusTimer) clearInterval(this.statusTimer)
    this.invoker.stop()
    this.texts.stop()
    this.manual?.stop()
    this.connection.stop()
    idle(this.options.cfg.home)
    this.writeStatus()
  }

  /**
   * `stop()`, then wait up to `graceMs` for the interrupted run to end. What a
   * shutdown awaits before the process exits, so a launchd/systemd stop
   * reaches the child and the restarted daemon does not find a run still
   * going. Resolves true when nothing is running any more.
   */
  async stopAndWait(graceMs: number): Promise<boolean> {
    this.stop()
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      return await Promise.race([
        this.invoker.settled().then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), graceMs)
        }),
      ])
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  /** A run in flight finishes on its own; this resolves when it has. */
  settled(): Promise<void> {
    return this.invoker.settled()
  }

  snapshot(): IntegrationStatus {
    const c = this.invoker.counters()
    // Stopping reads `closed` whatever the socket was doing; a refusal stays
    // visible to `status` and `doctor` as the last error.
    const socket: SocketState = this.stopping ? 'closed' : this.connection.state
    const texts = this.texts.current()
    return {
      version: 2,
      updated_at: new Date().toISOString(),
      pid: process.pid,
      runtime: this.options.runner.name,
      handle: this.options.cfg.handle,
      profile: this.options.profile,
      socket,
      wakes: c.wakes,
      wakes_absorbed: c.absorbed,
      invites: c.invites,
      runs_started: c.runsStarted,
      runs_ok: c.runsOk,
      runs_failed: c.runsFailed,
      runs_timed_out: c.runsTimedOut,
      runs_not_started: c.runsNotStarted,
      runs_skipped_empty: c.runsSkippedEmpty,
      last_run: c.lastRun,
      retry_rung: c.retryRung,
      retry_due_at: c.retryDueAt === null ? null : new Date(c.retryDueAt).toISOString(),
      last_error: this.lastError,
      texts: {
        source: this.texts.source,
        fetched_at: this.texts.fetchedAt,
        version: texts?.version ?? null,
        manual_version: texts?.manual.version ?? null,
      },
    }
  }

  /**
   * After every change in the texts in hand: the status file, and the skill
   * file brought to the manual they announce. Exposed for an injected store's
   * `onChange` (tests); the store this class builds calls it itself.
   */
  textsChanged(): void {
    this.writeStatus()
    if (this.manual !== null && !this.stopping) void this.manual.follow(this.texts.current()?.manual ?? null)
  }

  /** The served texts plus the pointer line, or null while no text is in hand. */
  private async runPrompts(): Promise<RunPrompts | null> {
    const texts = await this.texts.ensure()
    return texts === null ? null : buildRunPrompts(texts, this.options.manualPointer)
  }

  /**
   * The connect-time catch-up: one wake (the invoker counts the tray before
   * any run, so an empty tray costs a count, not a run) and the pending invites.
   */
  private async catchUp(): Promise<void> {
    if (this.stopping) return
    log.info('wake — connect (a run starts only if the tray has something unread)')
    this.invoker.wake('connect')
    try {
      const invites = await this.api.listGroupInvites()
      if (this.stopping) return
      let surfaced = 0
      for (const row of invites) {
        const invite: InviteWake = {
          inviteId: row.id,
          groupId: row.group_id ?? null,
          groupName: row.group_name ?? null,
          inviterHandle: row.inviter_handle ?? null,
        }
        if (this.invoker.invite(invite)) surfaced += 1
      }
      if (surfaced > 0) log.info(`wake — ${surfaced} pending group invite(s) surfaced on connect`)
    } catch (err) {
      log.warn(`connect-time invite list failed (${err instanceof Error ? err.message : String(err)}) — live invite frames are unaffected`)
    }
    this.writeStatus()
  }

  private writeStatus(): void {
    writeIntegrationStatus(this.options.cfg.home, this.snapshot())
  }
}
