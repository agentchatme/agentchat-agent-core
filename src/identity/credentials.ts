import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { integration, type SignupFlow } from 'agentchatme'
import { atomicWriteFile, readJsonFile } from '../util/fsutil.js'
import { log } from '../util/log.js'

// ─── Credential storage (host-agnostic) ─────────────────────────────────────
//
// Every function here takes the identity home as a parameter and NONE of them
// resolves one. That is the load-bearing rule of this library.
//
// The bug class it exists to prevent: when a shared module could resolve a
// home itself, it had to *decide* which agent it was acting on — and a
// function that decides can decide wrong. Registering one coding agent used to
// rewrite another's identity file, and signing out of one used to delete the
// other's credentials, because one code path served both. Here there is no
// such decision: the caller is a single-host integration that knows its own
// home at compile time and passes it in.
//
// Precedence within a home mirrors the Hermes plugin: an explicit
// AGENTCHAT_API_KEY env var wins over the file (for CI and externally-managed
// secrets); the file is what the setup wizard writes.

export const DEFAULT_API_BASE = 'https://api.agentchat.me'

const CredentialsSchema = z.object({
  api_key: z.string().min(20),
  handle: z.string().min(3),
  api_base: z.string().url().optional(),
  created_at: z.string().optional(),
})

export type Credentials = z.infer<typeof CredentialsSchema>

export interface ResolvedIdentity {
  apiKey: string
  apiBase: string
  /** Handle is only known when it came from the credentials file. */
  handle: string | null
  source: 'env' | 'file'
}

export function credentialsPath(home: string): string {
  return path.join(home, 'credentials')
}
export function pendingPath(home: string): string {
  return path.join(home, 'pending.json')
}
export function statePath(home: string): string {
  return path.join(home, 'state.json')
}

/** Read the credential stored in `home`, or null when absent/malformed. */
export function readCredentials(home: string): Credentials | null {
  const raw = readJsonFile<unknown>(credentialsPath(home))
  if (raw === null) return null
  const parsed = CredentialsSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/**
 * The identity an integration should act as, for one specific home.
 * `AGENTCHAT_API_KEY` overrides the file; `AGENTCHAT_API_BASE` overrides the
 * base URL. Neither is host-specific, so both are read from the environment.
 */
export interface ResolveIdentityOptions {
  /**
   * Whether `AGENTCHAT_API_KEY` may override the home's credentials (default
   * true). A resident listener passes false: the agent it serves is the one
   * its home holds, whatever happens to be exported in the shell that
   * started it.
   */
  readonly envKey?: boolean
}

/** `AGENTCHAT_API_KEY` from the environment when it is set and well-formed, else null. */
export function envApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env['AGENTCHAT_API_KEY']?.trim()
  return raw !== undefined && raw.length >= 20 ? raw : null
}

export function resolveIdentity(home: string, options: ResolveIdentityOptions = {}): ResolvedIdentity | null {
  const envKey = options.envKey === false ? undefined : process.env['AGENTCHAT_API_KEY']
  const envBase = process.env['AGENTCHAT_API_BASE']
  const file = readCredentials(home)

  if (envKey && envKey.trim().length >= 20) {
    return {
      apiKey: envKey.trim(),
      apiBase: envBase?.trim() || file?.api_base || DEFAULT_API_BASE,
      handle: file?.handle ?? null,
      source: 'env',
    }
  }

  // A SET-but-malformed env key silently losing to the file would be an
  // unnoticed identity swap on a messaging platform — say it on stderr.
  if (envKey && envKey.trim().length > 0 && file) {
    log.warn(
      'AGENTCHAT_API_KEY is set but malformed (under 20 chars); using the credentials-file identity instead',
    )
  }

  if (file) {
    return {
      apiKey: file.api_key,
      apiBase: envBase?.trim() || file.api_base || DEFAULT_API_BASE,
      handle: file.handle,
      source: 'file',
    }
  }

  return null
}

export function writeCredentials(home: string, creds: Credentials): void {
  atomicWriteFile(credentialsPath(home), JSON.stringify(creds, null, 2) + '\n', 0o600)
}

/** Delete the credential and any half-finished registration in `home`.
 *  Touches nothing outside `home` — that is the caller's whole agent. */
export function clearCredentials(home: string): boolean {
  let removed = false
  for (const p of [credentialsPath(home), pendingPath(home)]) {
    try {
      fs.unlinkSync(p)
      removed = true
    } catch {
      // absent is fine
    }
  }
  return removed
}

// ─── A sign-up waiting for its emailed code ─────────────────────────────────
//
// Between `register` (or `recover`) and the run with `--code`. The record is
// the server's own flow object from its last answer (`pending_id`,
// `expires_in_s`, `resend_after_s`, …, parsed by the SDK's `flowOf`) and when
// that answer arrived, since its seconds count from then. Beside it: what the
// start call sent, so the next run can print the command for a new code, and
// the API base it went to, so the code goes to the same server.

const PendingSchema = z.object({
  // 'register' creates a new agent; 'recover' re-keys an existing one. The
  // kind guard stops `register --code` completing a recovery (and vice versa).
  kind: z.enum(['register', 'recover']),
  flow: z.record(z.unknown()),
  received_at: z.string(),
  email: z.string(),
  handle: z.string().optional(),
  display_name: z.string().optional(),
  description: z.string().optional(),
  api_base: z.string().url().optional(),
})

/** The record release 0.5.0 and earlier wrote: the pending id alone. */
const LegacyPendingSchema = z.object({
  kind: z.enum(['register', 'recover']).default('register'),
  pending_id: z.string().min(1),
  email: z.string(),
  handle: z.string().min(1).optional(),
  api_base: z.string().url().optional(),
  created_at: z.string(),
})

export interface PendingSignup {
  kind: 'register' | 'recover'
  /** The server's flow object, as its last answer gave it. */
  flow: SignupFlow
  /** When that answer arrived (ISO-8601): `expires_in_s` and `resend_after_s` count from here. */
  received_at: string
  /** What the start call sent. */
  email: string
  handle?: string
  display_name?: string
  description?: string
  /** The API base the start call went to, when not the default. */
  api_base?: string
}

export function readPending(home: string): PendingSignup | null {
  const raw = readJsonFile<unknown>(pendingPath(home))
  if (raw === null) return null
  const parsed = PendingSchema.safeParse(raw)
  if (parsed.success) {
    const { kind, received_at, email, handle, display_name, description, api_base } = parsed.data
    const flow = integration.account.flowOf(parsed.data.flow)
    if (flow === null) return null
    return {
      kind,
      flow,
      received_at,
      email,
      ...(handle !== undefined ? { handle } : {}),
      ...(display_name !== undefined ? { display_name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(api_base !== undefined ? { api_base } : {}),
    }
  }
  // A code requested before an upgrade (`npx -y` fetches the newest release
  // between two runs) still completes: the old record becomes the flow it
  // stood for.
  const legacy = LegacyPendingSchema.safeParse(raw)
  if (!legacy.success) return null
  const { kind, pending_id, email, handle, api_base, created_at } = legacy.data
  return {
    kind,
    flow: { version: 1, flow: kind, next_step: kind === 'register' ? 'verify' : 'recover_verify', status: 'pending', pending_id },
    received_at: created_at,
    email,
    ...(handle !== undefined ? { handle } : {}),
    ...(api_base !== undefined ? { api_base } : {}),
  }
}

export function writePending(home: string, pending: PendingSignup): void {
  atomicWriteFile(pendingPath(home), JSON.stringify(pending, null, 2) + '\n', 0o600)
}

export function clearPending(home: string): void {
  try {
    fs.unlinkSync(pendingPath(home))
  } catch {
    // absent is fine
  }
}
