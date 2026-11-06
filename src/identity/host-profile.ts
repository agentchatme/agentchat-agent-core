import type { IntegrationClient } from '../client-identity.js'
import type { ServedManual } from '../skill/served-manual.js'
import type { ResolvedIdentity } from './credentials.js'

export type Verdict = 'PASS' | 'WARN' | 'FAIL'

export interface DoctorCheck {
  name: string
  verdict: Verdict
  detail: string
}

/** What the shared `status` hands a host's extra lines: what it already fetched from the served texts (one fetch per command). */
export interface StatusContext {
  identityLine: string | null
  /** The manual the served texts announce (`texts.manual`), or null when none are in hand — what `checkManual` compares the skill file with. */
  manual: ServedManual | null
}

/** What the shared doctor hands a host's extra checks. */
export interface DoctorContext {
  fix?: boolean
  /** The served identity line for this agent, or null when the server could not be reached and nothing is cached. */
  identityLine: string | null
  /** The manual the served texts announce, or null when none are in hand (`--fix` syncs the skill file to it). */
  manual: ServedManual | null
}

/**
 * Everything the shared identity commands need to know about ONE coding agent.
 *
 * This is the seam. The register / login / recover / status / logout / doctor
 * flows are the same everywhere because they are a contract with the AgentChat
 * server; what differs per host is only what is described here. An integration
 * builds one of these and gets the commands back.
 *
 * Note what is NOT here: any way to name a *different* host. A profile
 * describes the caller and nothing else, so a command built from it cannot
 * reach another agent's files. That is the same property the per-repo split
 * gives, kept intact while the flow itself is shared once.
 *
 * The path-ish fields are functions, not strings: `CODEX_HOME` and friends are
 * read per call, and evaluating them at module load would freeze a value the
 * user can still change.
 */
export interface HostProfile {
  /** Human name for output, e.g. `Claude Code`. */
  label: string
  /** Stable machine identifier for `--json`, e.g. `claude-code`. */
  id: string
  /** How this integration names itself to the server: the texts runtime and its own version. */
  client: IntegrationClient
  /** THE identity home for this agent. */
  home(): string
  /** This host's always-loaded instruction file. */
  anchorFile(): string
  /** Exactly what a user types to reach this integration. */
  invocation(): string
  /** Render the anchor block body this host wants from the served identity line (normally `renderAnchorBlock`). */
  renderAnchor(identityLine: string): string
  /**
   * What to call the anchor in output. Defaults to the instruction file's own
   * basename (`CLAUDE.md`, `AGENTS.md`), which is what a user actually looks
   * for on disk.
   */
  anchorLabel?: string
  /**
   * Whether this host is wired up enough for an anchor to mean anything.
   * An integration uses this so it never writes an identity block announcing
   * a phone number before its own placement is actually in place.
   */
  isWired?(): boolean
  /**
   * Place the integration's texts for a freshly established identity: the
   * identity line, the manual, the hosted tool server with the key, and
   * whatever the key's home is on this runtime. Called after register, login
   * and recover (every time the key changes), and by `doctor --fix`.
   * `identityLine` is the served line for this agent (fetched just before,
   * or the cached one), or null when neither could be had — the host then
   * leaves the anchor for `doctor --fix` and says so. `manual` is what the
   * same texts announce (`syncManual` brings the skill file to it), or null.
   * Returns report lines. When absent, only the anchor is written.
   */
  place?(handle: string, apiKey: string, identityLine: string | null, manual: ServedManual | null): string[] | Promise<string[]>
  /**
   * Undo `place` for the identity being signed out: remove the key from the
   * tool server registration and anything else that would still authenticate
   * as the old identity. The anchor is removed by the shared flow. Returns
   * report lines.
   *
   * `identity` is the identity AS IT WAS BEFORE the credential was cleared
   * (its key and API base), or null when there was none: a host recognises
   * its own registration by that key and that server, and guessing either
   * after the fact left a non-default `api_base` entry classified as foreign
   * and the key still registered.
   */
  unplace?(identity: ResolvedIdentity | null): string[]
  /** Host-specific doctor checks, appended after the shared ones. */
  extraDoctorChecks?(context: DoctorContext): DoctorCheck[] | Promise<DoctorCheck[]>
  /**
   * Host-specific `status` lines (placement, probes), printed after the shared
   * ones in text mode. The served identity line and manual come along so the
   * host does not fetch `/v1/texts` a second time.
   */
  extraStatus?(context: StatusContext): string[] | Promise<string[]>
  /** Extra lines printed after a successful logout. */
  logoutHints?(): string[]
}

/** The label to use for this host's anchor in user-facing output. */
export function anchorLabelOf(profile: HostProfile): string {
  if (profile.anchorLabel !== undefined) return profile.anchorLabel
  const file = profile.anchorFile()
  const slash = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  return slash >= 0 ? file.slice(slash + 1) : file
}
