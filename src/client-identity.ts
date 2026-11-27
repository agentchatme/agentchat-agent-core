import type { AgentChatClientIdentity, AgentChatClientKind, TextsRuntime } from 'agentchatme'

// ─── Who is calling ─────────────────────────────────────────────────────────
//
// An integration names itself to the server once: the runtime it serves, as
// the server's texts endpoint spells it (`claude-code`, `codex`, …), and its
// own package version. That one value drives two things — the served texts
// (`GET /v1/texts?runtime=`) and the client identity on every request and on
// the socket's hello — so the server's analytics tell the runtimes apart
// instead of lumping them under one bucket. Nothing in this package branches
// on it: it is a label the integration passes through, never a switch.

export interface IntegrationClient {
  readonly runtime: TextsRuntime
  readonly version: string
  /**
   * The client name sent to the server when it is not the runtime itself —
   * a front door that serves several runtimes (the `agentchat` listener)
   * names itself here, and `runtime` stays what the texts are rendered for.
   */
  readonly name?: string
  /**
   * The runtime this integration runs inside and its version, as
   * `<runtime>/<version>` (`claude-code/2.1.332`; `hostIdentityOf`): `host`
   * in X-AgentChat-Platform. Absent when it could not be read.
   */
  readonly host?: string
  /** This identity home's install id (`ensureInstallId`): `install` in X-AgentChat-Platform. */
  readonly installId?: string
  /** How this integration was installed, only when known for sure (`installMethodOf`): `method`. */
  readonly installMethod?: string
}

/** The name this client identifies as: its own `name`, else its runtime. */
export function clientNameOf(client: IntegrationClient): string {
  return client.name ?? client.runtime
}

/**
 * The SDK's client identity for this integration. The SDK types client names
 * as a closed union and the server normalises whatever arrives, so the
 * runtime name is passed through as-is; the union widens on the SDK side.
 */
export function clientIdentityOf(client: IntegrationClient): AgentChatClientIdentity {
  // host / installId / installMethod become X-AgentChat-Platform members (the SDK
  // checks each value's shape and leaves out one that does not fit).
  return {
    name: clientNameOf(client) as unknown as AgentChatClientKind,
    version: client.version,
    ...(client.host !== undefined ? { host: client.host } : {}),
    ...(client.installId !== undefined ? { installId: client.installId } : {}),
    ...(client.installMethod !== undefined ? { installMethod: client.installMethod } : {}),
  }
}

/**
 * `<runtime>/<version>` from a runtime's own version output (`claude
 * --version` → `2.1.332 (Claude Code)`, `codex --version` → `codex-cli
 * 0.154.0`): the first `x.y.z` in it. Null when it holds none.
 */
export function hostIdentityOf(runtime: string, versionOutput: string): string | null {
  const m = /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(versionOutput)
  return m === null ? null : `${runtime}/${m[1]}`
}

/**
 * How the code at `modulePath` was installed, only when that is certain from
 * where it runs: `npx` for npm's exec cache (`…/_npx/<hash>/node_modules/…`).
 * Null otherwise (a global install, a checkout, a copy the service runs):
 * the method is left out rather than guessed.
 */
export function installMethodOf(modulePath: string): string | null {
  return /[\\/]_npx[\\/][^\\/]+[\\/]node_modules[\\/]/.test(modulePath) ? 'npx' : null
}

/**
 * The client headers placed in a runtime's own tool configuration (the MCP
 * entries a run reads), where they stay until the next placement. They name
 * the integration and its version only: X-AgentChat-Platform is per request
 * (the SDK sends it on every call it makes, the hosted-tools probe included),
 * and a platform written into a config file would go stale there.
 */
export function clientHeadersOf(client: IntegrationClient): Record<string, string> {
  return {
    'X-AgentChat-Client': clientNameOf(client),
    'X-AgentChat-Client-Version': client.version,
  }
}
