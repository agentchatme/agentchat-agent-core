import { integration as kit } from 'agentchatme'
import { clientIdentityOf, type IntegrationClient } from '../client-identity.js'

// ─── Can this key reach the hosted tools? ───────────────────────────────────
//
// `status` and `doctor` ask the SDK kit's `probeHostedTools`: one MCP
// `initialize` over Streamable HTTP with the bearer key — the same first
// request a runtime makes on connect — then `tools/list`, which must show the
// tools a run needs (`agentchat_inbox`, `agentchat_decide`). A 401 means the
// key does not authenticate; a transport error means the endpoint is not
// reachable from here. No tool is called.

export const HOSTED_MCP_PATH = kit.HOSTED_MCP_PATH

export function hostedMcpUrl(apiBase: string): string {
  return kit.hostedMcpUrl(apiBase)
}

export interface McpProbeResult {
  readonly ok: boolean
  readonly status?: number
  readonly serverName?: string
  readonly serverVersion?: string
  readonly protocolVersion?: string
  /** Every tool the server listed for this key. */
  readonly tools?: readonly string[]
  /** Tools a run needs that were not listed. */
  readonly missing?: readonly string[]
  readonly error?: string
}

export async function probeHostedMcp(params: {
  apiKey: string
  apiBase: string
  /** How this integration identifies to the server. */
  client: IntegrationClient
  /**
   * Accepted for compatibility and ignored: the probe identifies as `client`
   * (headers and `clientInfo` alike), so the server's analytics see the
   * integration, never a free-text name it would file as unknown.
   */
  clientName?: string
  /** Accepted for compatibility and ignored (see `clientName`). */
  clientVersion?: string
  timeoutMs?: number
  fetch?: typeof fetch
}): Promise<McpProbeResult> {
  return kit.probeHostedTools({
    apiBase: params.apiBase,
    apiKey: params.apiKey,
    clientIdentity: clientIdentityOf(params.client),
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    ...(params.fetch !== undefined ? { fetch: params.fetch } : {}),
  })
}
