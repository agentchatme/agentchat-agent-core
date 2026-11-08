import type { BlockedInfo, RealtimeState } from 'agentchatme'
import type { SocketState } from './status.js'

// ─── The SDK socket's states, in the status file's words ───────────────────

/**
 * The SDK's connection state in the status file's vocabulary. Pure. `previous`
 * is the status word in effect, which decides two things the SDK's state alone
 * does not say: a `connecting` after a close is `reconnecting`, and the slow
 * retry out of `blocked` (`connecting` again) stays `blocked` — only an
 * accepted hello (`ready`) lifts it. `stopped` is `closed` from any state; a
 * refusal stays visible as the last error, not as the socket word.
 */
export function socketStateOf(next: RealtimeState, previous: SocketState): SocketState {
  switch (next) {
    case 'idle':
      return 'idle'
    case 'connecting':
      if (previous === 'blocked') return 'blocked'
      return previous === 'idle' || previous === 'connecting' ? 'connecting' : 'reconnecting'
    case 'ready':
      return 'ready'
    case 'backoff':
      return 'reconnecting'
    case 'blocked':
      return 'blocked'
    case 'stopped':
      return 'closed'
  }
}

/** The `last error` line for a refused credential: the server's close, what to do, and that the SDK keeps trying. */
export function blockedDetail(info: BlockedInfo): string {
  return `auth rejected (close ${info.code}${info.reason ? ` ${info.reason}` : ''}) — check the agent's API key; a fresh hello is tried every 10–15 min until one is accepted`
}
