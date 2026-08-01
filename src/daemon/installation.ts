import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { atomicWriteFile } from '../util/fsutil.js'
import { log } from '../util/log.js'

const INSTALLATION_ID_FILE = 'daemon.installation-id'

/**
 * Stable id for one installed integration. It distinguishes two machines that
 * intentionally sign in to the same AgentChat agent without teaching the
 * server anything about hostnames, operating systems, or local paths.
 */
export function installationId(home: string): string {
  const file = path.join(home, INSTALLATION_ID_FILE)
  try {
    const existing = fs.readFileSync(file, 'utf-8').trim()
    if (/^[0-9a-f-]{36}$/i.test(existing)) return existing
  } catch {
    /* create below */
  }

  const id = crypto.randomUUID()
  try {
    atomicWriteFile(file, `${id}\n`, 0o600)
  } catch (err) {
    // A read-only home must not stop message delivery. The process-unique
    // fallback cannot reconcile across restarts, but it remains collision-safe.
    log.warn(`could not persist daemon installation id: ${String(err)}`)
  }
  return id
}

