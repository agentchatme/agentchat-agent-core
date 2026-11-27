import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { integration, type SignupFlow } from 'agentchatme'
import { atomicWriteFile, readJsonFile } from '../util/fsutil.js'

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
// Within a home, the home's `credentials` name the agent. An exported
// AGENTCHAT_API_KEY is used only when the home holds no key (CI, an
// externally managed secret): one that differs from the home's key is never
// adopted, because a shell variable left over from another agent would
// otherwise make every command, and every placement, quietly that other
// agent. Commands say so in words (`envKeyConflict`).

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
 * The identity an integration should act as, for one specific home: the
 * home's `credentials`, else `AGENTCHAT_API_KEY` when the home holds no key.
 * `AGENTCHAT_API_BASE` overrides the base URL. Neither is host-specific, so
 * both are read from the environment.
 */
export interface ResolveIdentityOptions {
  /**
   * Whether `AGENTCHAT_API_KEY` may stand in for a home that holds no key
   * (default true). It never overrides a key the home holds. A resident
   * listener passes false: the agent it serves is the one its home holds,
   * whatever happens to be exported in the shell that started it.
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

  if (file) {
    // An exported key that is not this home's is not adopted; a command that
    // acts as the agent refuses on it first (`envKeyConflict`).
    return {
      apiKey: file.api_key,
      apiBase: envBase?.trim() || file.api_base || DEFAULT_API_BASE,
      handle: file.handle,
      source: 'file',
    }
  }

  if (envKey && envKey.trim().length >= 20) {
    return {
      apiKey: envKey.trim(),
      apiBase: envBase?.trim() || DEFAULT_API_BASE,
      handle: null,
      source: 'env',
    }
  }

  return null
}

/**
 * One sentence when an exported `AGENTCHAT_API_KEY` is not the key `home`
 * holds, else null (none exported, the same key, or a home with no key, where
 * the exported one stands in). Never contains either key. The caller adds
 * what to do in its own words.
 */
export function envKeyConflict(home: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exported = env['AGENTCHAT_API_KEY']?.trim()
  if (exported === undefined || exported.length === 0) return null
  const stored = readCredentials(home)
  if (stored === null || stored.api_key === exported) return null
  return `AGENTCHAT_API_KEY is exported and is not the key ${credentialsPath(home)} holds (it is another agent's key, or an old one); commands for this agent act only with that file's key`
}

export function writeCredentials(home: string, creds: Credentials): void {
  atomicWriteFile(credentialsPath(home), JSON.stringify(creds, null, 2) + '\n', 0o600)
}

// ─── The install id ──────────────────────────────────────────────────────────
//
// One random id per identity home: `ins_` and 22 base64url characters (16
// random bytes), never derived from the machine, the user or a path. It names
// this install to the server (`install` in X-AgentChat-Platform, and the
// setup telemetry) so an install can be followed from before its sign-up to
// its agent, and nothing else. Kept beside the credentials (owner-only); it
// survives logout (the same install signs in again) and goes with uninstall
// (`clearInstallId`). Under AGENTCHAT_TELEMETRY=off none is made or sent.

export const INSTALL_ID_FILE = 'install-id'
const INSTALL_ID_SHAPE = /^ins_[A-Za-z0-9_-]{22}$/

export function installIdPath(home: string): string {
  return path.join(home, INSTALL_ID_FILE)
}

/** The home's install id, or null when there is none (or the file holds something else). Never creates one. */
export function readInstallId(home: string): string | null {
  try {
    const id = fs.readFileSync(installIdPath(home), 'utf-8').trim()
    return INSTALL_ID_SHAPE.test(id) ? id : null
  } catch {
    return null
  }
}

/** A new install id: `ins_` and 22 base64url characters from 16 random bytes. */
export function newInstallId(): string {
  return `ins_${crypto.randomBytes(16).toString('base64url')}`
}

/**
 * The home's install id, made once: created with an exclusive open, so two
 * commands starting at the same moment agree on one (the second reads the
 * first's). A file that holds something else is replaced. Null when the home
 * cannot be written; never throws.
 */
export function ensureInstallId(home: string): string | null {
  const existing = readInstallId(home)
  if (existing !== null) return existing
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    const id = newInstallId()
    try {
      fs.writeFileSync(installIdPath(home), `${id}\n`, { flag: 'wx', mode: 0o600 })
      return id
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null
      // Another command made it first, or what is there is not an id: read it, else replace it.
      const theirs = readInstallId(home)
      if (theirs !== null) return theirs
      atomicWriteFile(installIdPath(home), `${id}\n`, 0o600)
      return id
    }
  } catch {
    return null
  }
}

// The runtime this integration last found itself in (`<runtime>/<version>`),
// as a command read it (`HostProfile.host()`): the daemon names it on its
// socket without running the runtime's `--version` before it starts.
export const HOST_FILE = 'runtime-host'
const HOST_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._+/-]{0,63}$/

/** The host a command last read here, or null. */
export function readRememberedHost(home: string): string | null {
  try {
    const host = fs.readFileSync(path.join(home, HOST_FILE), 'utf-8').trim()
    return HOST_SHAPE.test(host) ? host : null
  } catch {
    return null
  }
}

/** Keep the host a command read (when it changed). Never throws. */
export function rememberHost(home: string, host: string): void {
  if (!HOST_SHAPE.test(host) || readRememberedHost(home) === host) return
  try {
    atomicWriteFile(path.join(home, HOST_FILE), `${host}\n`, 0o600)
  } catch {
    /* a host not kept is read again next time */
  }
}

/** Remove the home's install id (uninstall). True when there was one. */
export function clearInstallId(home: string): boolean {
  try {
    fs.unlinkSync(installIdPath(home))
    return true
  } catch {
    return false
  }
}

/** Delete the credential and any half-finished registration in `home`.
 *  Touches nothing outside `home` — that is the caller's whole agent.
 *  The install id stays: the same install may sign in again. */
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

/** @deprecated Renamed to {@link PendingSignup}; kept so existing imports keep compiling. */
export type PendingRegistration = PendingSignup

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
