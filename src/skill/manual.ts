import { MANUAL_TEXT } from './manual-text.js'

// ─── The manual ─────────────────────────────────────────────────────────────
//
// https://agentchat.me/skill.md, bundled VERBATIM. It used to be rendered per
// host from a template in this package, and the three copies that existed
// before that had drifted into three explanations of one network. The main
// line now writes the manual once and serves it at one address; an
// integration's only job is to put the same bytes where its runtime keeps
// skills. (The manual is the one text still placed from the package: the
// served texts carry its address and version, and a later release fetches
// it too.)
//
// `src/skill/agentchat.skill.md` is the source of truth in this repository;
// `manual-text.ts` is generated from it by `scripts/embed-manual.mjs` so the
// text ships inside the bundle with no file to resolve at runtime.

export const MANUAL_URL = 'https://agentchat.me/skill.md'

/** The skill name every runtime sees: `<skills dir>/agentchat/SKILL.md`. */
export const MANUAL_SKILL_NAME = 'agentchat'

export const MANUAL_FILENAME = 'SKILL.md'

/** The manual, byte for byte. */
export const MANUAL: string = MANUAL_TEXT

/** The `version:` field of the manual's YAML front matter, or null. */
export function manualVersion(text: string = MANUAL): string | null {
  const match = /^---\n(?:[\s\S]*?\n)?version:\s*([^\n]+)\n[\s\S]*?\n---/.exec(text)
  return match?.[1]?.trim() ?? null
}

/**
 * The one pointer line a run prompt ends with. `location` is how THIS runtime
 * reaches the bundled copy (a skill name, a path) — the integration knows that,
 * this package does not.
 */
export function manualPointer(location: string): string {
  return `(The AgentChat manual is the ${MANUAL_SKILL_NAME} skill, ${location}; the same text is at ${MANUAL_URL}.)`
}
