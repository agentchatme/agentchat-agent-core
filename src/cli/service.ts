import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  VERSION,
  alwaysOnWanted,
  atomicCopyFile,
  clearAlwaysOnInstalledVersion,
  clearAlwaysOnOptOut,
  clearAlwaysOnWanted,
  installService,
  markAlwaysOnInstalledVersion,
  markAlwaysOnWanted,
  readAlwaysOnInstalledVersion,
  serviceDefinitionCurrent,
  serviceStatus,
  uninstallService,
} from '../index.js'
import { durableListenerPath, serviceEnvFrom, serviceLabelForHome, shippedListenerPath } from './home.js'

// ─── The listener as a background service ───────────────────────────────────
//
// launchd (macOS), a systemd user unit (Linux), a hidden Startup launcher
// (Windows / WSL) — the engine's service plumbing, one service per identity
// home. The service runs a DURABLE copy of the listener bundle (an npx cache
// is disposable) as `node <copy> --home <home>`, and the copy reads what to
// run from `<home>/listener.json`. Nothing about the command is in the
// service definition, and no key: the key stays in `credentials`.
// `AGENTCHAT_SERVICE_DRY_RUN=1` writes the definition and registers nothing.

export interface ListenerServiceOptions {
  /** Variables the selected preset needs captured (its config location). */
  readonly extraEnv?: readonly string[]
  readonly env?: NodeJS.ProcessEnv
  /** Test seam: the bundle to copy. */
  readonly shipped?: string
}

function serviceOpts(home: string, options: ListenerServiceOptions) {
  return {
    label: serviceLabelForHome(home),
    home,
    entry: durableListenerPath(home),
    env: serviceEnvFrom(options.env ?? process.env, options.extraEnv ?? []),
  }
}

/** Copy the listener out of this install and register the service. Throws on failure; idempotent. */
export function installListenerService(home: string, options: ListenerServiceOptions = {}): { label: string; entry: string } {
  const shipped = options.shipped ?? shippedListenerPath()
  if (!fs.existsSync(shipped)) throw new Error(`the listener bundle is missing from this install (expected ${shipped})`)
  const service = serviceOpts(home, options)
  fs.mkdirSync(path.dirname(service.entry), { recursive: true })
  if (path.resolve(shipped) !== path.resolve(service.entry)) atomicCopyFile(shipped, service.entry)
  installService(service)
  markAlwaysOnInstalledVersion(home, VERSION)
  clearAlwaysOnOptOut(home)
  markAlwaysOnWanted(home)
  return { label: service.label, entry: service.entry }
}

/**
 * Remove the service, then its durable copy (only once the service is gone:
 * deleting a binary a loaded restart policy points to makes a restart loop).
 * Throws — removing nothing — when the label's service serves another home.
 */
export function uninstallListenerService(home: string): { label: string } {
  const label = serviceLabelForHome(home)
  uninstallService({ label, home })
  clearAlwaysOnWanted(home)
  clearAlwaysOnInstalledVersion(home)
  try {
    fs.rmSync(durableListenerPath(home), { force: true })
  } catch {
    /* a locked file stays inert */
  }
  return { label }
}

/** Is the installed service this version's, pointing at its durable copy? */
export function listenerServiceCurrent(home: string, options: ListenerServiceOptions = {}): boolean {
  const service = serviceOpts(home, options)
  return (
    alwaysOnWanted(home) &&
    fs.existsSync(service.entry) &&
    readAlwaysOnInstalledVersion(home) === VERSION &&
    serviceDefinitionCurrent(service)
  )
}

export function listenerServiceStatus(home: string): string {
  return serviceStatus({ label: serviceLabelForHome(home), home })
}
