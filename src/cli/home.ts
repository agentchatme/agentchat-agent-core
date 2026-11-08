import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MANUAL_FILENAME, MANUAL_SKILL_NAME, VERSION, serviceLabelFor, type IntegrationClient } from '../index.js'

// ─── The only file of the `agentchat` CLI that knows where things are ───────
//
// The CLI is a front door like an integration: it knows its own identity home
// and nothing else's. It ships inside @agentchatme/agent-core for now and
// imports the engine only through the package's public entry points
// (`tests/cli-boundary.test.ts`), so it can move to a package of its own by
// changing the names in this file.
//
// The identity home: `--home <dir>`, else `AGENTCHAT_HOME`, else
// `~/.agentchat` — the same home and the same `credentials` format the stdio
// MCP server (`@agentchatme/mcp`) reads, so one sign-in serves both.

/** The package the CLI ships in today (what `npx -y <package>` names). */
export const CLI_PACKAGE = '@agentchatme/agent-core'
export const CLI_BIN = 'agentchat'
/** How the CLI names itself to the server (client identity on requests and the socket). */
export const CLI_CLIENT_NAME = 'agentchat-cli'
export const HOME_ENV = 'AGENTCHAT_HOME'

/** The served texts' runtime for a command we know nothing about: bare tool names, as plain MCP clients see them. */
const GENERIC = 'generic'

export function cliClient(runtime: IntegrationClient['runtime'] = GENERIC): IntegrationClient {
  return { runtime, version: VERSION, name: CLI_CLIENT_NAME }
}

export function defaultHome(): string {
  return path.join(os.homedir(), '.agentchat')
}

/** `--home`, else `AGENTCHAT_HOME`, else `~/.agentchat`. Resolved to an absolute path. */
export function resolveHome(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const fromFlag = flag?.trim()
  if (fromFlag !== undefined && fromFlag.length > 0) return path.resolve(fromFlag)
  const fromEnv = env[HOME_ENV]?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) return path.resolve(fromEnv)
  return defaultHome()
}

/** Exactly what a user types to reach this CLI: `agentchat` when installed, the npx form when run through npx. */
export function invocation(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['AGENTCHAT_CLI_NAME']?.trim()
  if (override !== undefined && override.length > 0) return override
  return env['npm_command'] === 'exec' ? `npx -y ${CLI_PACKAGE}` : CLI_BIN
}

/** The served manual, kept current here (`<home>/skills/agentchat/SKILL.md`): a skills dir an owner can point a runtime at. */
export function manualPathFor(home: string): string {
  return path.join(home, 'skills', MANUAL_SKILL_NAME, MANUAL_FILENAME)
}

export const SERVICE_BASE_LABEL = 'agentchatd-listener'

/** One service per identity home: the plain label for `~/.agentchat`, a hashed one for any other. */
export function serviceLabelForHome(home: string): string {
  return serviceLabelFor(SERVICE_BASE_LABEL, home, defaultHome())
}

/** The durable copy of the listener the service runs — outside any npx cache. */
export function durableListenerPath(home: string): string {
  return path.join(home, 'bin', 'agentchat-listener.mjs')
}

/** The listener bundle shipped beside this CLI bundle (`dist/listener-daemon.js`). */
export function shippedListenerPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'listener-daemon.js')
}

/**
 * Env the service must see: a launchd/systemd service does not inherit the
 * login shell (PATH is captured by the service plumbing). Only switches and
 * locations — never a key: the key stays in `credentials`.
 */
export const SERVICE_ENV_KEYS = [
  'AGENTCHAT_API_BASE',
  'AGENTCHAT_INTEGRATION',
  'AGENTCHAT_RUN_BUDGET_MS',
  'AGENTCHAT_RUN_MAX_BUDGET_USD',
  'AGENTCHAT_LOG_LEVEL',
] as const

/** The switches above plus `extra` (a preset's own: where its runtime keeps its config). */
export function serviceEnvFrom(env: NodeJS.ProcessEnv = process.env, extra: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of [...SERVICE_ENV_KEYS, ...extra]) {
    const value = env[key]?.trim()
    if (value !== undefined && value.length > 0) out[key] = value
  }
  return out
}
