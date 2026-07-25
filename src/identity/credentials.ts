import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
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
export function resolveIdentity(home: string): ResolvedIdentity | null {
  const envKey = process.env['AGENTCHAT_API_KEY']
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

// ─── Pending registration (between `register` and `register --code`) ───────

const PendingSchema = z.object({
  // 'register' creates a new agent; 'recover' re-keys an existing one.
  // Both share the two-invocation OTP shape, so they share this file — the
  // kind guard stops `register --code` completing a recovery (and vice
  // versa) with confusing results.
  kind: z.enum(['register', 'recover']).default('register'),
  pending_id: z.string().min(1),
  email: z.string().email(),
  handle: z.string().min(3).optional(),
  api_base: z.string().url().optional(),
  created_at: z.string(),
})

export type PendingRegistration = z.infer<typeof PendingSchema>

export function readPending(home: string): PendingRegistration | null {
  const raw = readJsonFile<unknown>(pendingPath(home))
  if (raw === null) return null
  const parsed = PendingSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export function writePending(home: string, pending: PendingRegistration): void {
  atomicWriteFile(pendingPath(home), JSON.stringify(pending, null, 2) + '\n', 0o600)
}

export function clearPending(home: string): void {
  try {
    fs.unlinkSync(pendingPath(home))
  } catch {
    // absent is fine
  }
}
