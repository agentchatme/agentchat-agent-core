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
// (`syncManual`, `ManualFollower` in ./served-manual.ts).
//
// What is bundled here is the fallback for a skill file that does not exist
// yet and cannot be downloaded (a first install offline, or with no account
// to ask the server which version is current) — a byte copy of the served
// manual at release time, never a second source of truth.
// `src/skill/agentchat.skill.md` is that copy; `manual-text.ts` is generated
// from it by `scripts/embed-manual.mjs` so the text ships inside the bundle
// with no file to resolve at runtime.

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

/**
 * The one pointer line a run prompt ends with. `location` is how THIS runtime
 * reaches its copy of the manual (a skill name, a path) — the integration knows
 * that, this package does not.
 */
export function manualPointer(location: string): string {
  return `(The AgentChat manual is the ${MANUAL_SKILL_NAME} skill, ${location}; the same text is at ${MANUAL_URL}.)`
}
