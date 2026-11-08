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
  return { name: clientNameOf(client) as unknown as AgentChatClientKind, version: client.version }
}

/** The same identity as headers, for the one raw request this package still makes (the MCP probe). */
export function clientHeadersOf(client: IntegrationClient): Record<string, string> {
  return {
    'X-AgentChat-Client': clientNameOf(client),
    'X-AgentChat-Client-Version': client.version,
  }
}
