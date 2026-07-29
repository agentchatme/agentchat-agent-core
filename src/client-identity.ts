import { VERSION } from './version.js'

/** Low-cardinality identity attached to every coding-agent API operation. */
export const CODING_AGENTS_CLIENT_IDENTITY = {
  name: 'coding_agents',
  version: VERSION,
} as const

/** Headers for raw HTTP and WebSocket transports that bypass the SDK. */
export const CODING_AGENTS_CLIENT_HEADERS: Readonly<Record<string, string>> = {
  'X-AgentChat-Client': CODING_AGENTS_CLIENT_IDENTITY.name,
  'X-AgentChat-Client-Version': CODING_AGENTS_CLIENT_IDENTITY.version,
}
