import * as path from 'node:path'
import { z } from 'zod'
import { AgentChatClient, type Texts, type TextsRuntime } from 'agentchatme'
import { atomicWriteFile, readJsonFile } from '../util/fsutil.js'
import { log } from '../util/log.js'
import { clientIdentityOf, type IntegrationClient } from '../client-identity.js'
import type { TimerHandle } from './wake.js'

// ─── The served texts ───────────────────────────────────────────────────────
//
// Every text an agent sees is written once, on the server, and served as data
// (`GET /v1/texts?runtime=`): the wake instruction a run starts with, the
// invite prompt, the identity line placed in the runtime's instruction file,
// where the manual is and which version is current (the skill file follows
// it: ../skill/served-manual.ts). This package carries no copy of any of them
// (the bundled manual is only the fallback for a skill file that cannot be
// downloaded and does not exist yet).
//
// What it does carry is the plumbing: fetch at start and every 24 h, keep the
// last good response in the identity home so a daemon that comes up offline
// still has a prompt to start a run with, and say honestly in `status` where
// the current text came from. A fetch that fails is logged once per condition,
// not once per retry.

export const TEXTS_CACHE_FILE = 'texts.json'
export const TEXTS_REFRESH_MS = 24 * 3_600_000
/** After a failed refresh: try again sooner than the daily timer. */
export const TEXTS_RETRY_MS = 3_600_000
/** One attempt, a few seconds: a CLI command or a run must not wait out a black-holed network. */
const FETCH_TIMEOUT_MS = 5_000

const TextsSchema = z
  .object({
    version: z.string(),
    manual: z.object({ url: z.string(), version: z.string() }).passthrough(),
    wake_instruction: z.string().min(1),
    invite_prompt: z.string().min(1),
    identity_line: z.string().min(1),
    identity_line_template: z.string().min(1),
  })
  .passthrough()

const CacheSchema = z.object({
  version: z.literal(1),
  fetched_at: z.string(),
  runtime: z.string(),
  texts: TextsSchema,
})

export type TextsSource = 'server' | 'cache' | 'none'

export interface CachedTexts {
  readonly fetched_at: string
  readonly runtime: string
  readonly texts: Texts
}

export function textsCachePath(home: string): string {
  return path.join(home, TEXTS_CACHE_FILE)
}

/** The last response cached for this runtime, or null. A cache for another runtime is not this one's. */
export function readCachedTexts(home: string, runtime: TextsRuntime): CachedTexts | null {
  const parsed = CacheSchema.safeParse(readJsonFile<unknown>(textsCachePath(home)))
  if (!parsed.success || parsed.data.runtime !== runtime) return null
  return { fetched_at: parsed.data.fetched_at, runtime: parsed.data.runtime, texts: parsed.data.texts as Texts }
}

/** Best effort: the cache is a convenience for an offline start, never a dependency of a fetch. */
export function writeCachedTexts(home: string, runtime: TextsRuntime, texts: Texts, fetchedAt: Date): void {
  try {
    atomicWriteFile(
      textsCachePath(home),
      `${JSON.stringify({ version: 1, fetched_at: fetchedAt.toISOString(), runtime, texts }, null, 2)}\n`,
      0o600,
    )
  } catch (err) {
    log.debug(`texts cache write failed: ${String(err)}`)
  }
}

export type TextsClient = Pick<AgentChatClient, 'texts'>

export interface LoadedTexts {
  readonly texts: Texts
  readonly source: 'server' | 'cache'
  readonly fetched_at: string
}

export interface LoadTextsOptions {
  readonly home: string
  readonly runtime: TextsRuntime
  readonly client: TextsClient
  readonly timeoutMs?: number
  readonly now?: () => Date
}

/**
 * One fetch with the cache as fallback — what a CLI command does before it
 * places the identity line or checks it. Null only when the server could not
 * be reached and nothing was ever cached for this runtime.
 */
export async function loadTexts(options: LoadTextsOptions): Promise<LoadedTexts | null> {
  const now = options.now ?? (() => new Date())
  try {
    const texts = await fetchTexts(options.client, options.runtime, options.timeoutMs)
    const fetchedAt = now()
    writeCachedTexts(options.home, options.runtime, texts, fetchedAt)
    return { texts, source: 'server', fetched_at: fetchedAt.toISOString() }
  } catch (err) {
    const cached = readCachedTexts(options.home, options.runtime)
    log.debug(`GET /v1/texts failed (${describe(err)}) — ${cached ? 'using the cached texts' : 'nothing cached'}`)
    return cached === null ? null : { texts: cached.texts, source: 'cache', fetched_at: cached.fetched_at }
  }
}

export interface FetchIdentityLineOptions {
  readonly home: string
  readonly apiKey: string
  readonly apiBase: string
  readonly client: IntegrationClient
  readonly timeoutMs?: number
}

export type FetchServedTextsOptions = FetchIdentityLineOptions

/**
 * The served texts for this agent, for an integration's own install and
 * placement paths: one fetch through an SDK client built here, the cache as
 * fallback, null when neither answers. The identity commands do the same
 * before `place`; this is the same read for callers that have no client.
 */
export async function fetchServedTexts(options: FetchServedTextsOptions): Promise<LoadedTexts | null> {
  const client = new AgentChatClient({
    apiKey: options.apiKey,
    baseUrl: options.apiBase,
    clientIdentity: clientIdentityOf(options.client),
    timeoutMs: options.timeoutMs ?? FETCH_TIMEOUT_MS,
    retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
  })
  return loadTexts({ home: options.home, runtime: options.client.runtime, client, ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) })
}

/** `fetchServedTexts`, reduced to the identity line. */
export async function fetchIdentityLine(options: FetchIdentityLineOptions): Promise<string | null> {
  const loaded = await fetchServedTexts(options)
  return loaded === null ? null : loaded.texts.identity_line
}

async function fetchTexts(client: TextsClient, runtime: TextsRuntime, timeoutMs = FETCH_TIMEOUT_MS): Promise<Texts> {
  const raw = await client.texts.get({ runtime, timeoutMs })
  const parsed = TextsSchema.safeParse(raw)
  if (!parsed.success) throw new Error('GET /v1/texts: unexpected shape')
  return parsed.data as Texts
}

export interface TextsStoreOptions {
  readonly home: string
  readonly runtime: TextsRuntime
  readonly client: TextsClient
  readonly refreshMs?: number
  readonly retryMs?: number
  readonly timeoutMs?: number
  /** Called after every change in what `current()` or `source` answer (a status writer hangs off this). */
  readonly onChange?: () => void
  readonly now?: () => Date
  readonly setTimeout?: (fn: () => void, ms: number) => TimerHandle
  readonly clearTimeout?: (handle: TimerHandle) => void
}

/**
 * The daemon's copy of the texts: fetched at start, refreshed on a timer, read
 * from the identity-home cache when the server cannot be reached, and fetched
 * on first use when the start fetch failed.
 */
export class TextsStore {
  readonly runtime: TextsRuntime
  private readonly home: string
  private readonly client: TextsClient
  private readonly refreshMs: number
  private readonly retryMs: number
  private readonly timeoutMs: number | undefined
  private readonly onChange: () => void
  private readonly now: () => Date
  private readonly _setTimeout: (fn: () => void, ms: number) => TimerHandle
  private readonly _clearTimeout: (handle: TimerHandle) => void

  private texts: Texts | null = null
  private _source: TextsSource = 'none'
  private _fetchedAt: string | null = null
  private inFlight: Promise<boolean> | null = null
  private timer: TimerHandle | null = null
  private stopped = false
  private lastFailure: string | null = null
  private serverSeen = false

  constructor(options: TextsStoreOptions) {
    this.home = options.home
    this.runtime = options.runtime
    this.client = options.client
    this.refreshMs = options.refreshMs ?? TEXTS_REFRESH_MS
    this.retryMs = options.retryMs ?? TEXTS_RETRY_MS
    this.timeoutMs = options.timeoutMs
    this.onChange = options.onChange ?? (() => undefined)
    this.now = options.now ?? (() => new Date())
    this._setTimeout = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this._clearTimeout = options.clearTimeout ?? ((handle) => clearTimeout(handle))
    const cached = readCachedTexts(this.home, this.runtime)
    if (cached !== null) {
      this.texts = cached.texts
      this._source = 'cache'
      this._fetchedAt = cached.fetched_at
    }
  }

  /** Where the current texts came from: the server (this process), the on-disk cache, or nowhere yet. */
  get source(): TextsSource {
    return this._source
  }

  /** When the current texts were fetched from the server (by this process or the one that cached them). */
  get fetchedAt(): string | null {
    return this._fetchedAt
  }

  /** The texts in hand, without a network call. */
  current(): Texts | null {
    return this.texts
  }

  /**
   * The start-time fetch, then the refresh timer. Returns once the first
   * attempt has settled, so a run that starts right after `start()` has the
   * freshest text available; a failure is logged once and does not throw —
   * the daemon starts anyway, on the cache if there is one.
   */
  async start(): Promise<void> {
    this.stopped = false
    const ok = await this.refresh()
    if (!ok && this.texts === null) {
      log.warn(
        'GET /v1/texts did not answer and nothing is cached in the identity home — starting anyway; a run waits for the texts (fetched again on first use, then hourly)',
      )
    }
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) {
      this._clearTimeout(this.timer)
      this.timer = null
    }
  }

  /**
   * Fetch now (coalescing a fetch already in flight), cache on success, arm
   * the next refresh either way. Resolves whether the server answered.
   */
  refresh(): Promise<boolean> {
    if (this.inFlight !== null) return this.inFlight
    this.inFlight = this.fetchOnce().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  /**
   * The texts for a run: what is in hand, after one more fetch attempt if the
   * server has not answered yet in this process. Null only when the server is
   * unreachable and nothing was ever cached — the run then does not start and
   * the wake retries on the ladder.
   */
  async ensure(): Promise<Texts | null> {
    if (!this.serverSeen && !this.stopped) await this.refresh()
    return this.texts
  }

  private async fetchOnce(): Promise<boolean> {
    try {
      const texts = await fetchTexts(this.client, this.runtime, this.timeoutMs)
      if (this.stopped) return true
      const fetchedAt = this.now()
      this.texts = texts
      this._source = 'server'
      this._fetchedAt = fetchedAt.toISOString()
      this.serverSeen = true
      writeCachedTexts(this.home, this.runtime, texts, fetchedAt)
      if (this.lastFailure !== null) {
        log.info(`GET /v1/texts answered again (texts v${texts.version}, manual ${texts.manual.version})`)
        this.lastFailure = null
      } else {
        log.info(`texts fetched for ${this.runtime} (texts v${texts.version}, manual ${texts.manual.version})`)
      }
      this.arm(this.refreshMs)
      this.onChange()
      return true
    } catch (err) {
      if (this.stopped) return false
      const message = describe(err)
      if (message !== this.lastFailure) {
        log.warn(
          `GET /v1/texts failed (${message}) — ${this.texts === null ? 'no texts yet' : `keeping the ${this._source === 'server' ? 'last fetched' : 'cached'} texts from ${this._fetchedAt ?? '?'}`}; retrying in ${Math.round(this.retryMs / 60_000)} min`,
        )
        this.lastFailure = message
      }
      this.arm(this.retryMs)
      this.onChange()
      return false
    }
  }

  private arm(ms: number): void {
    if (this.stopped) return
    if (this.timer !== null) this._clearTimeout(this.timer)
    this.timer = this._setTimeout(() => {
      this.timer = null
      void this.refresh()
    }, ms)
    ;(this.timer as { unref?: () => void }).unref?.()
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
