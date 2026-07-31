export type Verdict = 'PASS' | 'WARN' | 'FAIL'

export interface DoctorCheck {
  name: string
  verdict: Verdict
  detail: string
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
  /** THE identity home for this agent. */
  home(): string
  /** This host's always-loaded instruction file. */
  anchorFile(): string
  /** Exactly what a user types to reach this integration. */
  invocation(): string
  /** Render the anchor block body this host wants. */
  renderAnchor(handle: string): string
  /**
   * What to call the anchor in output. Defaults to the instruction file's own
   * basename (`CLAUDE.md`, `AGENTS.md`), which is what a user actually looks
   * for on disk.
   */
  anchorLabel?: string
  /**
   * Whether this host is wired up enough for an anchor to mean anything.
   * An integration uses this so it never writes an identity block announcing
   * a phone number before its own MCP, hooks, and durable bundle are actually
   * in place.
   */
  isWired?(): boolean
  /** Host-specific doctor checks, appended after the shared ones. */
  extraDoctorChecks?(opts: { fix?: boolean }): DoctorCheck[]
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
