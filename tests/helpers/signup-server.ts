import { vi } from 'vitest'
import { textsFor } from './served-texts.js'

// ─── The sign-up endpoints, as a fake `fetch` ───────────────────────────────
//
// Installed as the global `fetch`, which the SDK's transport takes when it is
// built without one of its own, so the real `integration.account` code reads
// every answer: the flow object, the error body, the Retry-After header.
// `GET /v1/texts` answers the served texts; every other request takes the
// next answer scripted for its "METHOD /path", and a request nothing was
// scripted for fails like a network error (the command under test then says
// it could not reach AgentChat, which no test expects by accident).
//
// The answers follow the shapes of contract v1, "Sign-up flows": the flow
// fields at the top level of a 2xx body, inside `details` of an error body.

export interface Answer {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

export interface Call {
  method: string
  path: string
  body: unknown
  headers: Record<string, string>
}

export interface SignupServer {
  /** Every request but the texts, in order. */
  readonly calls: Call[]
  /** Queue answers for `METHOD /path`, taken in order. */
  on(route: string, ...answers: Answer[]): SignupServer
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

export function signupServer(textsHandle = 'probe'): SignupServer {
  const script = new Map<string, Answer[]>()
  const calls: Call[] = []
  const fake = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method === 'GET' && url.pathname === '/v1/texts') {
      return json(200, textsFor(textsHandle, url.searchParams.get('runtime') ?? 'generic'))
    }
    calls.push({
      method,
      path: url.pathname,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    })
    const next = script.get(`${method} ${url.pathname}`)?.shift()
    if (next === undefined) throw new TypeError(`signup-server: nothing scripted for ${method} ${url.pathname}`)
    return json(next.status, next.body, next.headers)
  }
  vi.stubGlobal('fetch', fake)
  const server: SignupServer = {
    calls,
    on(route, ...answers) {
      script.set(route, [...(script.get(route) ?? []), ...answers])
      return server
    },
  }
  return server
}

// ─── Answers ────────────────────────────────────────────────────────────────

type Kind = 'register' | 'recover'
const VERIFY: Record<Kind, string> = { register: 'verify', recover: 'recover_verify' }

function error(status: number, code: string, message: string, details: Record<string, unknown>, headers?: Record<string, string>): Answer {
  return { status, body: { code, message, details: { version: 1, ...details } }, ...(headers ? { headers } : {}) }
}

/** The code was sent (register 200, recover 200). */
export function codeSent(kind: Kind, pendingId: string, message: string, extra: Record<string, unknown> = {}): Answer {
  return {
    status: 200,
    body: {
      pending_id: pendingId,
      message,
      version: 1,
      flow: kind,
      next_step: VERIFY[kind],
      status: 'pending',
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      expires_in_s: 600,
      code_length: 6,
      attempts: 0,
      max_attempts: 5,
      resend_after_s: 60,
      ...extra,
    },
  }
}

/** A wrong code with attempts left: the same pending id, asked again. */
export function wrongCode(kind: Kind, pendingId: string, attempts = 1): Answer {
  return error(400, 'INVALID_CODE', "That code didn't work. Check the code and try again.", {
    flow: kind,
    next_step: VERIFY[kind],
    status: 'pending',
    pending_id: pendingId,
    param: 'code',
    expires_in_s: 580,
    code_length: 6,
    attempts,
    max_attempts: 5,
    resend_after_s: 40,
  })
}

export function expired(kind: Kind): Answer {
  return error(400, 'EXPIRED', 'That code has expired. Request a new code.', { flow: kind, next_step: kind, status: 'expired' })
}

export function attemptsExhausted(kind: Kind, resendAfterS: number): Answer {
  return error(429, 'OTP_ATTEMPTS_EXHAUSTED', 'You entered the wrong code too many times. Request a new code.', {
    flow: kind,
    next_step: kind,
    status: 'max_attempts_reached',
    attempts: 5,
    max_attempts: 5,
    resend_after_s: resendAfterS,
  })
}

/** A 429 that names `step` with `retry_after_s` (and the Retry-After header). */
export function tooSoon(kind: Kind, step: string, code: string, message: string, retryAfterS: number): Answer {
  return error(429, code, message, { flow: kind, next_step: step, retry_after_s: retryAfterS }, { 'retry-after': String(retryAfterS) })
}

/** A start step that needs one input changed (`param`), e.g. HANDLE_TAKEN. */
export function askParam(kind: Kind, status: number, code: string, message: string, param: 'email' | 'handle', details: Record<string, unknown> = {}): Answer {
  return error(status, code, message, { flow: kind, next_step: kind, param, ...details })
}

export function serverError(kind: Kind, code: string, message: string): Answer {
  return error(500, code, message, { flow: kind, next_step: kind })
}

export function registered(handle: string, apiKey: string): Answer {
  return {
    status: 201,
    body: {
      agent: { handle, status: 'active' },
      api_key: apiKey,
      message: `Email verified. Logged in as @${handle}.`,
      version: 1,
      flow: 'register',
      next_step: 'done',
      status: 'approved',
    },
  }
}

export function recovered(handle: string, apiKey: string): Answer {
  return {
    status: 200,
    body: {
      api_key: apiKey,
      handle,
      message: `Email verified. Logged in as @${handle}. Your old API key no longer works.`,
      version: 1,
      flow: 'recover',
      next_step: 'done',
      status: 'approved',
    },
  }
}

/** `GET /v1/agents/me` for a key the server accepts. */
export function me(handle: string): Answer {
  return { status: 200, body: { handle, status: 'active' } }
}

export function unauthorized(): Answer {
  return { status: 401, body: { code: 'UNAUTHORIZED', message: 'Invalid API key' } }
}

/** A key shaped like an AgentChat key, built at run time (never a literal: the secret scan). */
export function fakeKey(fill: string): string {
  return `ac_${fill.repeat(32)}`
}
