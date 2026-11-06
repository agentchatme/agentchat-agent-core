import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Verdict } from '../identity/host-profile.js'
import { atomicWriteFile } from '../util/fsutil.js'
import { log } from '../util/log.js'
import { MANUAL, MANUAL_SKILL_NAME, manualFrontMatter, manualVersion } from './manual.js'

// ─── The served manual, placed and kept current ─────────────────────────────
//
// An integration's skill file follows the manual the server announces in the
// served texts (`GET /v1/texts` → `manual: {url, version, sha256?}`). When the
// file on disk is not the announced one, the announced address is downloaded,
// checked and written over the old file atomically. The file is its own
// record: its front matter (`version:`) and, when the server announces one,
// the sha256 of its bytes say what is placed — nothing else to keep in step.
//
// Every path is "never worse than before": offline, an error answer, a body
// over the size cap, a body that is not the agentchat skill at the announced
// version (or hash) — the existing file stays exactly as it is, and the next
// texts refresh tries again. The copy bundled in this package is written only
// when no file exists at all, or when it IS the announced manual (then there
// is nothing to download).
//
// Where a download may go is decided by where the announcement came from (the
// API base the texts were fetched from):
//   * an HTTPS base: every hop HTTPS, on `agentchat.me`, `*.agentchat.me` or the
//     base's own host — the announced address and every redirect (followed
//     here, at most three, each one checked: never a plaintext hop between two
//     TLS ones, never off those hosts);
//   * a plain-HTTP base on loopback (a development server): the same hosts,
//     and plain HTTP allowed only to loopback;
//   * any other plain-HTTP base: no download at all — an announcement that
//     travelled in the clear does not get to replace the file (it is kept, or
//     the bundled copy written when there is none), and `checkManual` says why.
//
// The body is text for a model to read. It is never executed and never
// interpreted beyond its front matter, and it is fetched without credentials:
// the manual is public, and the agent's key is not sent to an address the
// server merely names.

/** What the served texts announce: `Texts['manual']`, with the optional integrity hash. */
export interface ServedManual {
  readonly url: string
  readonly version: string
  /** Hex sha256 of the served bytes. When present, a download must match it and a file is current only if it does. */
  readonly sha256?: string
}

/** The manual is ~60 KB; anything past this is not the manual. */
export const MANUAL_MAX_BYTES = 512 * 1024
/** One attempt, every hop included; an installer or a refresh must not wait out a black-holed network. */
export const MANUAL_FETCH_TIMEOUT_MS = 10_000
/** Redirects followed (each one checked) before giving up. */
export const MANUAL_MAX_REDIRECTS = 3

/** `fetch`'s shape, injectable for tests. Defaults to the platform's own; called with `redirect: 'manual'`. */
export type ManualFetch = (url: string, init: RequestInit) => Promise<Response>

/**
 * - `current`  — the file already is the announced manual (version, and hash when announced); nothing fetched.
 * - `updated`  — the announced manual was written (downloaded, or the bundled copy when it is that manual).
 * - `kept`     — the existing file was left as it was: nothing announced to compare with, or no verified copy could be had.
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
  /** The file before carried the announced version but not the announced bytes (its sha256 differed). */
  readonly tampered: boolean
  /** The announced version; null when nothing was announced (no served texts in hand). */
  readonly served: string | null
  /** The announced address. */
  readonly url: string | null
  /** Where the written bytes came from, when some were written. */
  readonly source: 'download' | 'bundled' | null
  /** Whether the file changed. */
  readonly written: boolean
  /** Whether the file now is the announced manual; null when nothing was announced. */
  readonly upToDate: boolean | null
  /** Why the announced manual is not on disk (`kept` / `fallback` / `failed`), else null. */
  readonly error: string | null
}

export interface SyncManualOptions {
  /** The skill file, e.g. `<skills dir>/agentchat/SKILL.md`. The integration knows where; this package never derives it. */
  readonly path: string
  /** `texts.manual` from the served texts (or their identity-home cache); null when none are in hand. */
  readonly served: ServedManual | null
  /**
   * The API base the texts were fetched from (the identity's `api_base`). It
   * decides where a download may go; null (unknown) or a plain-HTTP base off
   * loopback means no download at all.
   */
  readonly apiBase: string | null
  readonly fetch?: ManualFetch
  readonly timeoutMs?: number
  readonly maxBytes?: number
  readonly signal?: AbortSignal
}

/** The version the file at `file` carries, or null when it is missing or names none. */
export function readManualVersion(file: string): string | null {
  return readLocal(file).version
}

/**
 * Bring the skill file at `path` to the announced manual. Never throws; the
 * result says what happened and, when the announced manual is not on disk,
 * why. See the module comment for the rules.
 */
export async function syncManual(options: SyncManualOptions): Promise<ManualSyncResult> {
  const file = options.path
  const served = options.served
  const local = readLocal(file)
  const base = { path: file, previous: local.version, served: served?.version ?? null, url: served?.url ?? null }
  let tampered = false

  let error: string | null = null
  if (served !== null) {
    const hash = announcedHash(served)
    if (hash instanceof Error) {
      error = hash.message
    } else {
      if (local.exists && local.version === served.version) {
        if (hash === null || sha256(local.bytes) === hash) {
          return { ...base, tampered, state: 'current', version: local.version, source: null, written: false, upToDate: true, error: null }
        }
        tampered = true
      }
      const origin = manualOrigin(options.apiBase)
      if (!origin.ok) {
        error = origin.reason
      } else {
        let bytes: Uint8Array | null = null
        let source: 'download' | 'bundled' = 'bundled'
        if (isAnnounced(BUNDLED_BYTES, manualVersion(MANUAL), served, hash)) {
          bytes = BUNDLED_BYTES
        } else {
          try {
            bytes = await downloadManual(served, hash, origin, options)
            source = 'download'
          } catch (err) {
            error = describe(err)
          }
        }
        if (bytes !== null) {
          try {
            writeManual(file, bytes)
            return { ...base, tampered, state: 'updated', version: served.version, source, written: true, upToDate: true, error: null }
          } catch (err) {
            error = `could not write ${file}: ${describe(err)}`
          }
        }
      }
    }
  }

  if (local.exists) {
    return { ...base, tampered, state: 'kept', version: local.version, source: null, written: false, upToDate: served === null ? null : false, error }
  }
  try {
    writeManual(file, BUNDLED_BYTES)
  } catch (err) {
    return { ...base, tampered, state: 'failed', version: null, source: null, written: false, upToDate: served === null ? null : false, error: describe(err) }
  }
  const bundled = manualVersion(MANUAL)
  const bundledIsServed = served !== null && isAnnounced(BUNDLED_BYTES, bundled, served, announcedHashOrNull(served))
  return { ...base, tampered, state: 'fallback', version: bundled, source: 'bundled', written: true, upToDate: served === null ? null : bundledIsServed, error }
}

/** One human line for an installer's report. */
export function describeManualSync(result: ManualSyncResult): string {
  const at = result.path
  const have = result.tampered ? `${result.previous} with a sha256 that is not the served one` : (result.previous ?? 'an unversioned file')
  switch (result.state) {
    case 'current':
      return `current (${result.version}) — ${at}`
    case 'updated':
      return `${result.version} ${result.source === 'download' ? `downloaded from ${result.url}` : 'placed from the bundled copy (the served version)'} → ${at}${result.previous !== null ? ` (was ${have})` : ''}`
    case 'fallback':
      return result.served === null
        ? `bundled copy ${result.version} → ${at} (no served version in hand to check it against)`
        : `bundled copy ${result.version} → ${at}; served ${result.served} could not be fetched: ${result.error}`
    case 'kept':
      return result.served === null
        ? `unchecked (have ${have}; no served version in hand) — ${at}`
        : `stale (have ${have}, served ${result.served}) — ${at}; kept as it is: ${result.error}`
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
  /** `current (2.2.1)`, `stale (have 2.1.2, served 2.2.1)`, `unchecked (have 2.2.1; …)`, `missing`. */
  readonly summary: string
  /** The summary and the file. */
  readonly detail: string
}

export interface CheckManualOptions {
  readonly path: string
  /** What the served texts announce; null when none are in hand. */
  readonly served: ServedManual | null
  /** The API base the texts came from; a base no download would be made from is named in the summary. */
  readonly apiBase: string | null
}

/** Compare the skill file with the announced manual. Reads one file; no network. */
export function checkManual(options: CheckManualOptions): ManualCheck {
  const { path: file, served } = options
  const local = readLocal(file)
  const version = local.version
  const have = version ?? 'an unversioned file'
  const result = (state: ManualCheckState, verdict: Verdict, summary: string): ManualCheck => ({
    state,
    path: file,
    version,
    served: served?.version ?? null,
    verdict,
    summary,
    detail: `${summary} — ${file}`,
  })
  if (!local.exists) return result('missing', 'FAIL', 'missing')
  if (served === null) return result('unchecked', 'WARN', `unchecked (have ${have}; no served version in hand)`)
  const hash = announcedHash(served)
  if (hash instanceof Error) return result('unchecked', 'WARN', `unchecked (have ${have}; ${hash.message})`)
  if (version === served.version && (hash === null || sha256(local.bytes) === hash)) return result('current', 'PASS', `current (${version})`)
  const origin = manualOrigin(options.apiBase)
  const why = origin.ok ? '' : `; not downloaded: ${origin.reason}`
  return version === served.version
    ? result('stale', 'WARN', `stale (have ${version} but not the served text: its sha256 differs${why})`)
    : result('stale', 'WARN', `stale (have ${have}, served ${served.version}${why})`)
}

// ─── The daemon's side ──────────────────────────────────────────────────────

export interface ManualFollowerOptions {
  readonly path: string
  /** The API base the daemon fetches the texts from. */
  readonly apiBase: string
  readonly fetch?: ManualFetch
  readonly timeoutMs?: number
}

/**
 * Keeps the skill file at the manual the served texts announce, for a
 * resident daemon. `follow` is called whenever the texts in hand change (the
 * start fetch, every refresh, a failed refresh falling back to the cache), so
 * it runs on the texts' own cadence: daily, hourly while the server does not
 * answer. When the file already is the announced manual it reads one file and
 * stops. Calls are serialised; a download in flight is aborted by `stop`. A
 * failure is logged once per condition, not once per attempt.
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
        apiBase: this.options.apiBase,
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

// ─── Where a download may go ────────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const MANUAL_HOME = 'agentchat.me'

type Origin = { readonly ok: true; readonly host: string; readonly plainLoopback: boolean } | { readonly ok: false; readonly reason: string }

/** Whether, and how, an announcement from `apiBase` may be acted on over the network. */
function manualOrigin(apiBase: string | null): Origin {
  if (apiBase === null) return { ok: false, reason: 'no API base is known for the served texts' }
  let base: URL
  try {
    base = new URL(apiBase)
  } catch {
    return { ok: false, reason: `the API base ${apiBase} is not a URL` }
  }
  if (base.protocol === 'https:') return { ok: true, host: base.hostname, plainLoopback: false }
  if (base.protocol === 'http:' && LOOPBACK_HOSTS.has(base.hostname)) return { ok: true, host: base.hostname, plainLoopback: true }
  return { ok: false, reason: `the served texts came from ${base.origin}, which is not HTTPS, so the manual is not downloaded` }
}

/** Why `url` may not be fetched for a manual announced from `origin`, or null when it may. */
function refusal(url: URL, origin: Extract<Origin, { ok: true }>): string | null {
  const host = url.hostname
  if (host !== MANUAL_HOME && !host.endsWith(`.${MANUAL_HOME}`) && host !== origin.host) {
    return `${url.host} is neither ${MANUAL_HOME} nor the API's own host`
  }
  if (url.username !== '' || url.password !== '') return 'the address carries credentials'
  if (url.protocol === 'https:') return null
  if (url.protocol === 'http:' && origin.plainLoopback && LOOPBACK_HOSTS.has(host)) return null
  return `${url.protocol}// to ${url.host} — the manual is fetched over HTTPS only (plain HTTP only to loopback, from a loopback API base)`
}

// ─── Download and checks ────────────────────────────────────────────────────

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const SHA256_HEX = /^[0-9a-f]{64}$/
const BUNDLED_BYTES: Uint8Array = Buffer.from(MANUAL, 'utf-8')

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The announced hash, lower-cased; null when none is announced; an Error when one is announced but malformed. */
function announcedHash(served: ServedManual): string | null | Error {
  const raw = (served as { sha256?: unknown }).sha256
  if (raw === undefined || raw === null) return null
  const hash = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return SHA256_HEX.test(hash) ? hash : new Error('the announced sha256 is not a hex sha256')
}

function announcedHashOrNull(served: ServedManual): string | null {
  const hash = announcedHash(served)
  return hash instanceof Error ? null : hash
}

function isAnnounced(bytes: Uint8Array, version: string | null, served: ServedManual, hash: string | null): boolean {
  return version === served.version && (hash === null || sha256(bytes) === hash)
}

interface LocalManual {
  readonly exists: boolean
  readonly bytes: Uint8Array
  readonly version: string | null
}

function readLocal(file: string): LocalManual {
  if (!fs.existsSync(file)) return { exists: false, bytes: new Uint8Array(0), version: null }
  try {
    const bytes = fs.readFileSync(file)
    return { exists: true, bytes, version: manualVersion(bytes.toString('utf-8')) }
  } catch {
    return { exists: true, bytes: new Uint8Array(0), version: null }
  }
}

async function downloadManual(served: ServedManual, hash: string | null, origin: Extract<Origin, { ok: true }>, options: SyncManualOptions): Promise<Uint8Array> {
  let url: URL
  try {
    url = new URL(served.url)
  } catch {
    throw new Error(`the announced address is not a URL: ${served.url}`)
  }
  const refused = refusal(url, origin)
  if (refused !== null) throw new Error(`refusing ${url.href}: ${refused}`)
  const maxBytes = options.maxBytes ?? MANUAL_MAX_BYTES
  const timeoutMs = options.timeoutMs ?? MANUAL_FETCH_TIMEOUT_MS
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = options.signal !== undefined ? AbortSignal.any([options.signal, timeout]) : timeout
  const doFetch: ManualFetch = options.fetch ?? ((input, init) => fetch(input, init))

  let bytes: Uint8Array
  try {
    for (let hop = 0; ; hop++) {
      // Redirects are followed here, one hop at a time, so every hop is
      // checked — not only where a chain ends.
      const response = await doFetch(url.href, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: { accept: 'text/markdown, text/plain;q=0.9, */*;q=0.1' },
      })
      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel().catch(() => undefined)
        if (hop >= MANUAL_MAX_REDIRECTS) throw new Error(`more than ${MANUAL_MAX_REDIRECTS} redirects from ${served.url}`)
        const location = response.headers.get('location')
        if (location === null || location === '') throw new Error(`HTTP ${response.status} from ${url.href} with no Location`)
        let next: URL
        try {
          next = new URL(location, url)
        } catch {
          throw new Error(`HTTP ${response.status} from ${url.href} to an unparseable Location`)
        }
        const why = refusal(next, origin)
        if (why !== null) throw new Error(`redirected to ${next.href}: ${why}`)
        url = next
        continue
      }
      if (response.type === 'opaqueredirect' || response.status === 0) throw new Error(`an opaque redirect from ${url.href}`)
      // A fetch that followed on its own (an injected one) still says where it ended.
      if (response.url !== '' && response.url !== url.href) {
        const why = refusal(new URL(response.url), origin)
        if (why !== null) throw new Error(`redirected to ${response.url}: ${why}`)
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${url.href}`)
      const declared = Number(response.headers.get('content-length') ?? Number.NaN)
      if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`${declared} bytes declared, over the ${maxBytes}-byte cap`)
      bytes = await readCapped(response, maxBytes)
      break
    }
  } catch (err) {
    if (timeout.aborted) throw new Error(`no answer from ${served.url} within ${timeoutMs} ms`)
    throw err
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new Error('the body is not UTF-8 text')
  }
  checkManualText(text, served.version)
  if (hash !== null) {
    const got = sha256(bytes)
    if (got !== hash) throw new Error(`the body's sha256 is ${got}, the server announced ${hash}`)
  }
  return bytes
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

/** The exact bytes: what was hashed is what is placed. */
function writeManual(file: string, bytes: Uint8Array): void {
  // The skills directory is the runtime's, made the way the runtime would
  // make it; only the file is ours.
  fs.mkdirSync(path.dirname(file), { recursive: true })
  atomicWriteFile(file, bytes, 0o644)
}

function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = (err as { cause?: unknown }).cause
  const detail = cause instanceof Error ? ((cause as NodeJS.ErrnoException).code ?? cause.message) : null
  return detail !== null && !err.message.includes(detail) ? `${err.message} (${detail})` : err.message
}
