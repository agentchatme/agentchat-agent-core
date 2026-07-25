// ─── @agentchatme/agent-core/daemon ─────────────────────────────────────────
//
// The always-on daemon's runtime half, kept OUT of the main entry on purpose.
//
// `ws` is CommonJS and uses dynamic require, so anything that bundles it must
// be built as a daemon binary rather than a CLI. Splitting the entry points
// means an integration's CLI never drags the socket layer in — it stayed a
// clean ESM single-file bin, and the failure mode ("Dynamic require of events
// is not supported" at startup) simply cannot occur there.
//
// The runtime ADAPTER — how to spawn a headless turn of a given coding agent —
// is deliberately NOT here. That is the one part of the daemon that genuinely
// differs per host, so each integration implements `RuntimeAdapter` itself.

export { AgentWsClient, type WsClientEvents } from './daemon/ws-client.js'
export { ReplyCoord, type CoordConfig } from './daemon/coord.js'
export { parseInbound, senderOf } from './daemon/frames.js'
export { describeConversation, describeSender } from './daemon/format.js'
export type { RuntimeAdapter, TurnContext, TurnResult } from './daemon/adapter-types.js'
