import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { integration as kit } from 'agentchatme'
import type { Verdict } from '../identity/host-profile.js'
import { MANUAL, manualVersion } from './manual.js'

// ─── The served manual, placed and kept current ─────────────────────────────
//
// An integration's skill file follows the manual the server announces in the
// served texts (`GET /v1/texts` → `manual: {url, version, sha256?}`). The
// download, its checks and the atomic write are the SDK kit's `syncManual`
// (`integration.syncManual`, ported from this file with every property of its
// security review: HTTPS and a host pin decided by where the announcement came
// from, each redirect hop checked, a size cap, the version and sha256 of the
// exact bytes, never worse than before, no credentials sent). What is here:
//
//   * `syncManual` — the kit's, with this package's bundled copy as the
//     fallback for a skill file that does not exist and cannot be downloaded
//     (a first install offline);
//   * `checkManual` — the one-file, no-network comparison `status` and
//     `doctor` print;
//   * `describeManualSync` — a sync result as one line.

/** What the served texts announce: `Texts['manual']`, with the optional integrity hash. */
export type ServedManual = kit.ServedManual

export const MANUAL_MAX_BYTES = kit.MANUAL_MAX_BYTES
export const MANUAL_FETCH_TIMEOUT_MS = kit.MANUAL_FETCH_TIMEOUT_MS
export const MANUAL_MAX_REDIRECTS = kit.MANUAL_MAX_REDIRECTS

/** `fetch`'s shape, injectable for tests. Defaults to the platform's own; called with `redirect: 'manual'`. */
export type ManualFetch = kit.ManualFetch

/**
 * - `current`  — the file already is the announced manual (version, and hash when announced); nothing fetched.
 * - `updated`  — the announced manual was written (downloaded, or the bundled copy when it is that manual).
 * - `kept`     — the existing file was left as it was: nothing announced to compare with, or no verified copy could be had.
 * - `fallback` — no file existed and nothing verified could be had: the bundled copy was written.
 * - `failed`   — no file existed and none could be written.
 */
export type ManualSyncState = kit.ManualSyncState

export interface ManualSyncResult extends Omit<kit.ManualSyncResult, 'source'> {
  /** Where the written bytes came from, when some were written. */
  readonly source: 'download' | 'bundled' | null
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

/** A kit result in this package's words (the fallback is the bundled copy). */
export function fromKitResult(result: kit.ManualSyncResult): ManualSyncResult {
  return { ...result, source: result.source === 'fallback' ? 'bundled' : result.source }
}

/**
 * Bring the skill file at `path` to the announced manual (the kit's
 * `syncManual`, the bundled copy as fallback). Never throws.
 */
export async function syncManual(options: SyncManualOptions): Promise<ManualSyncResult> {
  return fromKitResult(await kit.syncManual({ ...options, fallback: MANUAL }))
}

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

// ─── Helpers for the check ──────────────────────────────────────────────────

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

const SHA256_HEX = /^[0-9a-f]{64}$/

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
