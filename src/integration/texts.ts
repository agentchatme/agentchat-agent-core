import * as path from 'node:path'
import { AgentChatClient, integration as kit, type Texts, type TextsRuntime } from 'agentchatme'
import { readJsonFile } from '../util/fsutil.js'
import { clientIdentityOf, type IntegrationClient } from '../client-identity.js'

// ─── The served texts, for the CLI commands ─────────────────────────────────
//
// Every text an agent sees is written once, on the server, and served as data
// (`GET /v1/texts?runtime=`): the wake instruction a run starts with, the
// invite prompt, the identity line, where the manual is and which version is
// current. This package carries no copy of any of them.
//
// The fetching, caching and refreshing is the SDK kit's `TextsCache` (the
// resident integration holds one); its last good copy lives in the identity
// home (`texts.json`). What is here is the one-shot read a CLI command makes
// before it places or checks the identity line — one fetch, the cached copy
// when the server cannot be reached — and the cache's location.

export const TEXTS_CACHE_FILE = 'texts.json'
/** One attempt, a few seconds: a CLI command must not wait out a black-holed network. */
const FETCH_TIMEOUT_MS = 5_000

export type TextsSource = 'server' | 'cache' | 'none'

export interface CachedTexts {
  readonly fetched_at: string
  readonly runtime: string
  readonly texts: Texts
}

export function textsCachePath(home: string): string {
  return path.join(home, TEXTS_CACHE_FILE)
}

/** The last copy kept for this runtime, or null. A copy for another runtime is not this one's. No network. */
export function readCachedTexts(home: string, runtime: TextsRuntime): CachedTexts | null {
  const raw = readJsonFile<Record<string, unknown>>(textsCachePath(home))
  if (raw === null || raw['version'] !== 1 || raw['runtime'] !== runtime || typeof raw['fetched_at'] !== 'string') return null
  return kit.isTexts(raw['texts']) ? { fetched_at: raw['fetched_at'], runtime, texts: raw['texts'] } : null
}

export type TextsClient = kit.TextsClient

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
 * One fetch with the cached copy as fallback (the kit's `TextsCache`, started
 * and stopped) — what a CLI command does before it places the identity line
 * or checks it. Null only when the server could not be reached and nothing was
 * ever kept for this runtime.
 */
export async function loadTexts(options: LoadTextsOptions): Promise<LoadedTexts | null> {
  const now = options.now
  const cache = new kit.TextsCache({
    client: options.client,
    runtime: options.runtime,
    filePath: textsCachePath(options.home),
    fetchTimeoutMs: options.timeoutMs ?? FETCH_TIMEOUT_MS,
    ...(now !== undefined ? { now: () => now().getTime() } : {}),
  })
  try {
    const texts = await cache.start()
    if (texts === null || cache.source === 'none') return null
    return { texts, source: cache.source, fetched_at: cache.fetchedAt ?? new Date().toISOString() }
  } finally {
    cache.stop()
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
 * placement paths: one fetch through an SDK client built here, the cached
 * copy as fallback, null when neither answers.
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
