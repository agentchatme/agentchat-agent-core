import * as path from 'node:path'
import { parseArgs } from 'node:util'
import { log, readListenerConfig } from '../index.js'
import { runIntegration } from '../daemon-entry.js'
import { planListener } from './runners.js'

// ─── The installed listener: what the service runs ──────────────────────────
//
// `node <home>/bin/agentchat-listener.mjs --home <home>` — copied there by
// `agentchat listen --install`, self-contained, run by launchd / systemd /
// the Windows launcher. It reads what to run from `<home>/listener.json` (the
// owner's choice, written by the owner) and hands it to the engine's resident
// supervisor: idle without an identity, connect when one appears, follow the
// credential, one run at a time. Without a valid config it stays resident and
// looks again every few seconds — exiting would only make the service manager
// restart it in a loop.

const CONFIG_POLL_MS = 10_000

export async function listenerDaemon(argv: string[] = process.argv.slice(2)): Promise<number> {
  let home: string
  try {
    const { values } = parseArgs({ args: argv, allowPositionals: false, options: { home: { type: 'string' } } })
    if (values.home === undefined) throw new Error('--home is required')
    home = path.resolve(values.home)
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err))
    console.error('Usage: agentchat-listener --home <identity home>')
    return 1
  }
  if (process.env['AGENTCHAT_LOG_LEVEL'] === undefined) process.env['AGENTCHAT_LOG_LEVEL'] = 'info'

  let lastError: string | null = null
  let stopping = false
  const onSignal = (): void => {
    stopping = true
  }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)
  log.info(`listener resident for ${home}`)
  for (;;) {
    const read = readListenerConfig(home)
    if (read.ok) {
      process.off('SIGTERM', onSignal)
      process.off('SIGINT', onSignal)
      if (stopping) return 0
      try {
        const config = read.config
        const plan = planListener(home, config)
        return await runIntegration({
          home,
          workdir: config.workdir,
          runner: plan.runner,
          client: plan.client,
          manualPointer: plan.manualPointer,
          manualPath: plan.manualPath,
          ...(config.mode === 'preset' ? { profile: config.profile } : {}),
          ...(config.budget_ms !== undefined ? { budgetMs: config.budget_ms } : {}),
        })
      } catch (err) {
        // An unknown preset (a config from a newer build): say it, keep looking.
        const message = err instanceof Error ? err.message : String(err)
        if (message !== lastError) log.error(`listener config not usable: ${message} — waiting for a new one`)
        lastError = message
        process.on('SIGTERM', onSignal)
        process.on('SIGINT', onSignal)
      }
    } else if (read.error !== lastError) {
      log.warn(`${read.error} — waiting for one (\`agentchat listen … --install\` writes it)`)
      lastError = read.error
    }
    const deadline = Date.now() + CONFIG_POLL_MS
    while (!stopping && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250))
    if (stopping) return 0
  }
}

listenerDaemon().then(
  (code) => {
    process.exitCode = code
  },
  (err: unknown) => {
    console.error(String(err instanceof Error ? (err.stack ?? err.message) : err))
    process.exitCode = 1
  },
)
