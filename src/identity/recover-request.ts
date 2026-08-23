import { HttpTransport } from 'agentchatme'
import { CODING_AGENTS_CLIENT_HEADERS } from '../client-identity.js'

// ─── Recovery, step 1: POST /v1/agents/recover ──────────────────────────────
//
// One email may back several agents, so a recovery request names BOTH the
// email and the handle. An email-only request is only unambiguous while the
// email backs exactly one live agent; the server answers an ambiguous one
// with HANDLE_REQUIRED at verify time, after the code has already been spent.
// Sending the handle up front is what keeps recovery a single round-trip.
//
// This deliberately does not call `AgentChatClient.recover()`. The published
// SDK signature is `recover(email)` and cannot carry a handle, and every
// integration inlines whichever SDK its lockfile resolved — so waiting on the
// SDK would leave shipped CLIs sending email-only requests indefinitely. The
// request goes through the SDK's own `HttpTransport`, so the error vocabulary
// (`AgentChatError` with `code`, `status`, `details`) is exactly what the
// other identity calls throw and `describeApiError` already understands.

/** What the server returns for a recovery request. */
export interface RecoverStartResult {
  /**
   * The pending id to verify against. Present on every response from a
   * current server — a miss, a throttled email, and a hit all look the same,
   * so nobody can tell from the outside whether an email is registered. A
   * not-yet-upgraded server omits it when nothing matched.
   */
  pending_id?: string
  /** The generic "if an agent matches, a code was sent" sentence. */
  message: string
}

export interface RecoverStartInput {
  email: string
  handle: string
  apiBase: string
}

/** Ask the server to email a recovery code for `handle` at `email`. */
export async function startRecovery(input: RecoverStartInput): Promise<RecoverStartResult> {
  const http = new HttpTransport({
    baseUrl: input.apiBase,
    defaultHeaders: { ...CODING_AGENTS_CLIENT_HEADERS },
  })
  // `retry: 'never'` mirrors the SDK's own registration/recovery calls: each
  // attempt claims an OTP slot, so a transparent retry would double-send.
  const res = await http.request<RecoverStartResult>('POST', '/v1/agents/recover', {
    body: { email: input.email, handle: input.handle },
    retry: 'never',
  })
  return res.data
}
