import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Verdict } from '../identity/host-profile.js'
import { atomicWriteFile } from '../util/fsutil.js'
import { log } from '../util/log.js'
import { MANUAL, MANUAL_SKILL_NAME, manualFrontMatter, manualVersion } from './manual.js'

// ─── The served manual, placed and kept current ─────────────────────────────
//
// An integration's skill file follows the manual the server announces in the
// served texts (`GET /v1/texts` → `manual: {url, version}`). When the version
// on disk is not the announced one, the announced address is downloaded,
// checked and written over the old file atomically. The file's own front
// matter (`version:`) is the record of what is placed: there is no second
// record to keep in step with it.
//
// Every path is "never worse than before": offline, an error answer, a body
// over the size cap, a body whose front matter is not the agentchat skill at
// the announced version — the existing file stays exactly as it is, and the
// next texts refresh tries again. The copy bundled in this package is written
// only when no file exists at all, or when it IS the announced version (then
// there is nothing to download).
//
// The body is text for a model to read. It is never executed and never
// interpreted beyond its front matter, and it is fetched without credentials:
// the manual is public, and the agent's key is not sent to an address the
// server merely names.

/** What the served texts announce: `Texts['manual']`. */
export interface ServedManual {
  readonly url: string
  readonly version: string
}

/** The manual is ~60 KB; anything past this is not the manual. */
export const MANUAL_MAX_BYTES = 512 * 1024
/** One attempt; an installer or a refresh must not wait out a black-holed network. */
export const MANUAL_FETCH_TIMEOUT_MS = 10_000

/** `fetch`'s shape, injectable for tests. Defaults to the platform's own. */
export type ManualFetch = (url: string, init: RequestInit) => Promise<Response>

/**
 * - `current`  — the file already carries the announced version; nothing fetched.
 * - `updated`  — the announced version was written (downloaded, or the bundled copy when it is that version).
 * - `kept`     — the existing file was left as it was: nothing announced to compare with, or the download failed.
 * - `fallback` — no file existed and nothing verified could be had: the bundled copy was written.
 * - `failed`   — no file existed and none could be written.
 */
export type ManualSyncState = 'current' | 'updated' | 'kept' | 'fallback' | 'failed'

export interface ManualSyncResult {
  readonly state: ManualSyncState
  readonly path: string
  /** The version the file carries after the sync; null when there is no file or it names none. */
  readonly version: string | null
  /** The version the file carried before; null when there was none. */
  readonly previous: string | null
  /** The announced version; null when nothing was announced (no served texts in hand). */
  readonly served: string | null
  /** The announced address. */
  readonly url: string | null
  /** Where the written text came from, when one was written. */
  readonly source: 'download' | 'bundled' | null
  /** Whether the file changed. */
  readonly written: boolean
  /** Whether the file now carries the announced version; null when nothing was announced. */
  readonly upToDate: boolean | null
  /** Why the announced version is not on disk (`kept` / `fallback` / `failed`), else null. */
  readonly error: string | null
}

export interface SyncManualOptions {
  /** The skill file, e.g. `<skills dir>/agentchat/SKILL.md`. The integration knows where; this package never derives it. */
  readonly path: string
  /** `texts.manual` from the served texts (or their identity-home cache); null when none are in hand. */
  readonly served: ServedManual | null
  readonly fetch?: ManualFetch
  readonly timeoutMs?: number
  readonly maxBytes?: number
  readonly signal?: AbortSignal
}

/** The version the file at `file` carries, or null when it is missing or names none. */
export function readManualVersion(file: string): string | null {
  try {
    return manualVersion(fs.readFileSync(file, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * Bring the skill file at `path` to the announced manual. Never throws; the
 * result says what happened and, when the announced version is not on disk,
 * why. See the module comment for the rules.
 */
export async function syncManual(options: SyncManualOptions): Promise<ManualSyncResult> {
  const file = options.path
  const served = options.served
  const exists = fs.existsSync(file)
  const previous = exists ? readManualVersion(file) : null
  const base = { path: file, previous, served: served?.version ?? null, url: served?.url ?? null }

  if (served !== null && exists && previous === served.version) {
    return { ...base, state: 'current', version: previous, source: null, written: false, upToDate: true, error: null }
  }

  let error: string | null = null
  if (served !== null) {
    let text: string | null = null
    let source: 'download' | 'bundled' = 'bundled'
    if (manualVersion(MANUAL) === served.version) {
      text = MANUAL
    } else {
      try {
        text = await downloadManual(served, options)
        source = 'download'
      } catch (err) {
        error = describe(err)
      }
    }
    if (text !== null) {
      try {
        writeManual(file, text)
        return { ...base, state: 'updated', version: served.version, source, written: true, upToDate: true, error: null }
      } catch (err) {
        error = `could not write ${file}: ${describe(err)}`
      }
    }
  }

  if (exists) {
    return { ...base, state: 'kept', version: previous, source: null, written: false, upToDate: served === null ? null : false, error }
  }
  try {
    writeManual(file, MANUAL)
  } catch (err) {
    return { ...base, state: 'failed', version: null, source: null, written: false, upToDate: served === null ? null : false, error: describe(err) }
  }
  const bundled = manualVersion(MANUAL)
  return {
    ...base,
    state: 'fallback',
    version: bundled,
    source: 'bundled',
    written: true,
    upToDate: served === null ? null : bundled === served.version,
    error,
  }
}

/** One human line for an installer's report. */
export function describeManualSync(result: ManualSyncResult): string {
  const at = result.path
  switch (result.state) {
    case 'current':
      return `current (${result.version}) — ${at}`
    case 'updated':
      return `${result.version} ${result.source === 'download' ? `downloaded from ${result.url}` : 'placed from the bundled copy (the served version)'} → ${at}${result.previous !== null ? ` (was ${result.previous})` : ''}`
    case 'fallback':
      return result.served === null
        ? `bundled copy ${result.version} → ${at} (no served version in hand to check it against)`
        : `bundled copy ${result.version} → ${at}; served ${result.served} could not be fetched: ${result.error}`
    case 'kept':
      return result.served === null
        ? `unchecked (have ${result.previous ?? 'an unversioned file'}; no served version in hand) — ${at}`
        : `stale (have ${result.previous ?? 'an unversioned file'}, served ${result.served}) — ${at}; kept as it is: ${result.error}`
    case 'failed':
      return `could not write ${at}: ${result.error}`
  }
}

// ─── For status and doctor ──────────────────────────────────────────────────

export type ManualCheckState = 'current' | 'stale' | 'unchecked' | 'missing'

export interface ManualCheck {
  readonly state: ManualCheckState
  readonly path: string
  readonly version: string | null
  readonly served: string | null
  /** current → PASS; stale or unchecked → WARN (the agent still has a manual); missing → FAIL. */
  readonly verdict: Verdict
  /** `current (2.2.0)`, `stale (have 2.1.2, served 2.2.0)`, `unchecked (have 2.2.0; …)`, `missing`. */
  readonly summary: string
  /** The summary and the file. */
  readonly detail: string
}

/** Compare the skill file with the announced version (`texts.manual.version`, null when none is in hand). Reads one file. */
export function checkManual(file: string, served: string | null): ManualCheck {
  const exists = fs.existsSync(file)
  const version = exists ? readManualVersion(file) : null
  const have = version ?? 'an unversioned file'
  const [state, verdict, summary]: [ManualCheckState, Verdict, string] = !exists
    ? ['missing', 'FAIL', 'missing']
    : served === null
      ? ['unchecked', 'WARN', `unchecked (have ${have}; no served version in hand)`]
      : version === served
        ? ['current', 'PASS', `current (${version})`]
        : ['stale', 'WARN', `stale (have ${have}, served ${served})`]
  return { state, path: file, version, served, verdict, summary, detail: `${summary} — ${file}` }
}

// ─── The daemon's side ──────────────────────────────────────────────────────

export interface ManualFollowerOptions {
  readonly path: string
  readonly fetch?: ManualFetch
  readonly timeoutMs?: number
}

/**
 * Keeps the skill file at the version the served texts announce, for a
 * resident daemon. `follow` is called whenever the texts in hand change (the
 * start fetch, every refresh, a failed refresh falling back to the cache), so
 * it runs on the texts' own cadence: daily, hourly while the server does not
 * answer. When the file already carries the announced version it reads one
 * file and stops. Calls are serialised; a download in flight is aborted by
 * `stop`. A failure is logged once per condition, not once per attempt.
 */
export class ManualFollower {
  private readonly controller = new AbortController()
  private chain: Promise<unknown> = Promise.resolve()
  private lastFailure: string | null = null

  constructor(private readonly options: ManualFollowerOptions) {}

  follow(served: ServedManual | null): Promise<ManualSyncResult | null> {
    const next = this.chain.then(async () => {
      if (served === null || this.controller.signal.aborted) return null
      const result = await syncManual({
        path: this.options.path,
        served,
        signal: this.controller.signal,
        ...(this.options.fetch !== undefined ? { fetch: this.options.fetch } : {}),
        ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
      })
      if (!this.controller.signal.aborted) this.report(result)
      return result
    })
    this.chain = next.catch(() => undefined)
    return next
  }

  stop(): void {
    this.controller.abort()
  }

  private report(result: ManualSyncResult): void {
    if (result.upToDate === true) {
      if (result.written) log.info(`manual ${describeManualSync(result)}`)
      this.lastFailure = null
      return
    }
    const line =
      result.state === 'fallback' || result.state === 'failed'
        ? `manual: ${describeManualSync(result)}`
        : `manual ${result.served} announced but not placed (${result.error}) — keeping ${result.previous ?? 'the unversioned file'} at ${result.path}; tried again at the next texts refresh`
    if (result.error !== this.lastFailure) log.warn(line)
    this.lastFailure = result.error
  }
}

// ─── Download and checks ────────────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** HTTPS, or plain HTTP to this machine (a local development server). */
function secureEnough(url: URL): boolean {
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
}

async function downloadManual(served: ServedManual, options: SyncManualOptions): Promise<string> {
  let url: URL
  try {
    url = new URL(served.url)
  } catch {
    throw new Error(`the announced address is not a URL: ${served.url}`)
  }
  if (!secureEnough(url)) throw new Error(`refusing ${url.protocol}// for ${url.href} — the manual is fetched over HTTPS only`)
  const maxBytes = options.maxBytes ?? MANUAL_MAX_BYTES
  const timeoutMs = options.timeoutMs ?? MANUAL_FETCH_TIMEOUT_MS
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = options.signal !== undefined ? AbortSignal.any([options.signal, timeout]) : timeout
  const doFetch: ManualFetch = options.fetch ?? ((input, init) => fetch(input, init))

  let bytes: Uint8Array
  try {
    const response = await doFetch(url.href, {
      method: 'GET',
      redirect: 'follow',
      signal,
      headers: { accept: 'text/markdown, text/plain;q=0.9, */*;q=0.1' },
    })
    // A redirect that left HTTPS is not trusted, whatever it says.
    if (response.url !== '' && !secureEnough(new URL(response.url))) throw new Error(`redirected to ${response.url} — the manual is fetched over HTTPS only`)
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url.href}`)
    const declared = Number(response.headers.get('content-length') ?? Number.NaN)
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`${declared} bytes declared, over the ${maxBytes}-byte cap`)
    bytes = await readCapped(response, maxBytes)
  } catch (err) {
    if (timeout.aborted) throw new Error(`no answer from ${url.href} within ${timeoutMs} ms`)
    throw err
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('the body is not UTF-8 text')
  }
  checkManualText(text, served.version)
  return text
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (reader === undefined) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new Error(`the body is over the ${maxBytes}-byte cap`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/** The body is the agentchat skill at the announced version, or it is not used. */
function checkManualText(text: string, announced: string): void {
  if (text.includes('\u0000')) throw new Error('the body is not text')
  const fields = manualFrontMatter(text)
  if (fields === null) throw new Error('the body has no front matter — not the manual')
  if (fields.get('name') !== MANUAL_SKILL_NAME) throw new Error(`the front matter names "${fields.get('name') ?? ''}", not the ${MANUAL_SKILL_NAME} skill`)
  const version = manualVersion(text)
  if (version !== announced) throw new Error(`the body is version ${version ?? '(none)'}, the server announced ${announced}`)
}

function writeManual(file: string, text: string): void {
  // The skills directory is the runtime's, made the way the runtime would
  // make it; only the file is ours.
  fs.mkdirSync(path.dirname(file), { recursive: true })
  atomicWriteFile(file, text, 0o644)
}

function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = (err as { cause?: unknown }).cause
  const detail = cause instanceof Error ? ((cause as NodeJS.ErrnoException).code ?? cause.message) : null
  return detail !== null && !err.message.includes(detail) ? `${err.message} (${detail})` : err.message
}
