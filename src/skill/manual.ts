import type { Texts } from 'agentchatme'
import { MANUAL_TEXT } from './manual-text.js'

// ─── The manual ─────────────────────────────────────────────────────────────
//
// The manual has one home: the address the server announces in the served
// texts (`GET /v1/texts` → `manual: {url, version}`; today
// https://agentchat.me/skill.md). It used to be rendered per host from a
// template in this package, and the three copies that existed before that had
// drifted into three explanations of one network. The main line now writes
// the manual once and serves it at one address; an integration's only job is
// to put the SERVED bytes where its runtime keeps skills and keep them current
// (`syncManual` in ./served-manual.ts — the SDK kit's, with this copy as the
// fallback; the resident integration follows the texts with the kit's
// `ManualSync`).
//
// What is bundled here is the fallback for a skill file that does not exist
// yet and cannot be downloaded (a first install offline, or with no account
// to ask the server which version is current) — a byte copy of the served
// manual at release time, never a second source of truth.
// `src/skill/agentchat.skill.md` is that copy; `manual-text.ts` is generated
// from it by `scripts/embed-manual.mjs` so the text ships inside the bundle
// with no file to resolve at runtime.

/**
 * Where the manual is when no served texts are in hand: the offline floor for
 * a first install, never the address a run is pointed at while texts are
 * (`servedManualUrl`).
 */
export const MANUAL_URL = 'https://agentchat.me/skill.md'

/** The skill name every runtime sees: `<skills dir>/agentchat/SKILL.md`. */
export const MANUAL_SKILL_NAME = 'agentchat'

export const MANUAL_FILENAME = 'SKILL.md'

/** The bundled copy, byte for byte (the fallback; the served manual is the source). */
export const MANUAL: string = MANUAL_TEXT

/**
 * The YAML front matter's top-level `key: value` fields, or null when the text
 * does not open with a front matter block. Deliberately not a YAML parser:
 * the manual's front matter is flat, and nothing here interprets more of a
 * downloaded text than its name and version. A leading byte-order mark and
 * CRLF line endings (a file saved by a Windows editor) read the same as LF.
 */
export function manualFrontMatter(raw: string): ReadonlyMap<string, string> | null {
  const text = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replace(/\r\n/g, '\n')
  if (!text.startsWith('---\n')) return null
  // The closing fence: a line that is exactly `---`.
  let close = text.indexOf('\n---', 3)
  while (close >= 0 && text.charAt(close + 4) !== '\n' && close + 4 !== text.length) close = text.indexOf('\n---', close + 1)
  if (close < 0) return null
  const fields = new Map<string, string>()
  for (const line of text.slice(4, close).split('\n')) {
    const match = /^([A-Za-z0-9_-]+):[ \t]*(.*?)[ \t]*$/.exec(line)
    if (match === null) continue
    const value = match[2] ?? ''
    fields.set(match[1] ?? '', /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value)
  }
  return fields
}

/** The `version:` field of the manual's YAML front matter, or null. */
export function manualVersion(text: string = MANUAL): string | null {
  const version = manualFrontMatter(text)?.get('version')
  return version !== undefined && version.length > 0 ? version : null
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '[::1]'])

/**
 * Where the served texts say the manual is (`texts.manual.url`), or
 * `MANUAL_URL` when no texts are in hand. Only an address a run can follow
 * counts, under the manual download's own rule: an absolute `https:` URL, or
 * plain `http:` to loopback (a development server). Anything else — another
 * scheme, a relative path, credentials in it, whitespace or a control
 * character in it (more than an address) — reads as none.
 */
export function servedManualUrl(texts: Pick<Texts, 'manual'> | null | undefined): string {
  const url = texts?.manual?.url
  if (typeof url !== 'string') return MANUAL_URL
  const trimmed = url.trim()
  if (trimmed.length === 0 || /[\s\u0000-\u001f\u007f]/.test(trimmed)) return MANUAL_URL
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return MANUAL_URL
  }
  // Never an address that carries credentials (the download refuses those too).
  if (parsed.username !== '' || parsed.password !== '') return MANUAL_URL
  if (parsed.protocol === 'https:') return parsed.href
  const loopback = LOOPBACK_HOSTS.has(parsed.hostname) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(parsed.hostname)
  return parsed.protocol === 'http:' && loopback ? parsed.href : MANUAL_URL
}

/**
 * The one pointer line a run prompt ends with. `location` is how THIS runtime
 * reaches its copy of the manual (a skill name, a path) — the integration knows
 * that, this package does not. `url` is where the served texts say the manual
 * is (`servedManualUrl`); `MANUAL_URL` only when none are in hand.
 */
export function manualPointer(location: string, url: string = MANUAL_URL): string {
  return `(The AgentChat manual is the ${MANUAL_SKILL_NAME} skill, ${location}; the same text is at ${url}.)`
}

/**
 * The pointer a run prompt ends with, as an integration hands it to the
 * daemon: a function of the manual's address, called for each run with the
 * address the texts in hand announce (`servedManualUrl`), so the line follows
 * the served texts. A plain string is used as it is (an empty one adds
 * nothing).
 */
export type ManualPointer = string | ((manualUrl: string) => string)

/** The pointer line for a run, with the manual's address the texts in hand announce. */
export function resolveManualPointer(pointer: ManualPointer, texts: Pick<Texts, 'manual'> | null | undefined): string {
  return typeof pointer === 'string' ? pointer : pointer(servedManualUrl(texts))
}
