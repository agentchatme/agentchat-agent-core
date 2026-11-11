import { integration as kit, type Texts } from 'agentchatme'

// ─── The identity line: placed, not authored ────────────────────────────────
//
// The few lines written into whatever file the runtime loads on EVERY turn
// (`CLAUDE.md`, `AGENTS.md`, `SOUL.md`, …) are the server's text: `GET
// /v1/texts` serves them with the handle filled in and the hosted tool names
// spelled for the runtime. This module no longer carries the words — it only
// says which served field is the identity line and normalises the handle the
// line is checked against. The fenced-block placement itself is
// `anchor/block.ts`; the fetch and the cache are `integration/texts.ts`.

/** The identity line, ready to place, from a served (or cached) texts response. */
export function identityLineOf(texts: Pick<Texts, 'identity_line'>): string {
  return texts.identity_line
}

/** Handles are canonical lowercase on the wire; a leading `@` is display only. The kit's (`integration.anchor.normalizeHandle`). */
export function normalizeHandle(handle: string): string {
  return kit.anchor.normalizeHandle(handle)
}
