import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  alwaysOnWanted,
  checkManual,
  createIdentityCommands,
  describeListenerConfig,
  describeManualSync,
  forwardUrlProblem,
  probeHostedMcp,
  readForwardSecret,
  readListenerConfig,
  renderAnchorBlock,
  resolveIdentity,
  syncManual,
  type DoctorCheck,
  type DoctorContext,
  type HostProfile,
  type IdentityCommands,
  type ListenerConfig,
  type ServedManual,
  type StatusContext,
} from '../index.js'
import { presetNamed } from '../presets/index.js'
import { cliClient, invocation, manualPathFor } from './home.js'
import { installListenerService, listenerServiceCurrent, listenerServiceStatus } from './service.js'

// ─── This agent, described once, for the identity commands ──────────────────
//
// register / login / recover / status / logout / doctor are the engine's flows
// (`createIdentityCommands`); this file says which home they act on and what
// "placing" means for a listener: the served manual kept at
// `<home>/skills/agentchat/SKILL.md`. There is no instruction file to put an
// identity line in — the listener runs an owner's command — so none is placed.
// Signing out also removes what carries the key besides `credentials`: a
// preset's tool config under `<home>/presets/`.

const PRESET_FILES_DIR = 'presets'

/** Files that hold the key besides `credentials` (a preset's `--mcp-config`). Removed on logout. */
export function removeKeyFiles(home: string): string[] {
  const dir = path.join(home, PRESET_FILES_DIR)
  if (!fs.existsSync(dir)) return []
  const removed: string[] = []
  for (const name of fs.readdirSync(dir)) {
    try {
      fs.rmSync(path.join(dir, name), { force: true })
      removed.push(name)
    } catch {
      /* best effort */
    }
  }
  return removed.length > 0 ? [`  removed the key from ${removed.length} preset tool config file(s) in ${dir}`] : []
}

function check(name: string, verdict: DoctorCheck['verdict'], detail: string): DoctorCheck {
  return { name, verdict, detail }
}

/** What the configured listener needs to work, as doctor checks. */
export function listenerChecks(home: string, config: ListenerConfig, env: NodeJS.ProcessEnv = process.env): DoctorCheck[] {
  const checks: DoctorCheck[] = [check('listener', 'PASS', describeListenerConfig(config))]
  let workdirOk = true
  try {
    workdirOk = fs.statSync(config.workdir).isDirectory()
  } catch {
    workdirOk = false
  }
  if (config.mode !== 'forward') {
    checks.push(workdirOk ? check('workdir', 'PASS', config.workdir) : check('workdir', 'FAIL', `${config.workdir} does not exist — re-run \`${invocation()} listen … --install\` from the directory the runs should use`))
  }
  if (config.mode === 'preset') {
    const preset = presetNamed(config.preset)
    if (preset === null) checks.push(check('preset', 'FAIL', `unknown preset "${config.preset}"`))
    else {
      const inspected = preset.inspect(env)
      checks.push(check('preset', inspected.ok ? 'PASS' : 'FAIL', `${preset.label}: ${inspected.detail}`))
    }
  }
  if (config.mode === 'forward') {
    const problem = forwardUrlProblem(config.url)
    checks.push(problem === null ? check('forward', 'PASS', config.url) : check('forward', 'FAIL', problem))
    checks.push(
      readForwardSecret(home) !== null
        ? check('forward-secret', 'PASS', `${path.join(home, 'forward.secret')} (the receiver checks Authorization: Bearer against it)`)
        : check('forward-secret', 'WARN', 'not created yet — the listener creates it on start'),
    )
  }
  return checks
}

function serviceCheck(home: string, config: ListenerConfig | null, fix: boolean): DoctorCheck | null {
  if (!alwaysOnWanted(home)) return null
  const extraEnv = config?.mode === 'preset' ? (presetNamed(config.preset)?.serviceEnv ?? []) : []
  if (listenerServiceCurrent(home, { extraEnv })) return check('service', 'PASS', listenerServiceStatus(home))
  if (fix && config !== null) {
    try {
      installListenerService(home, { extraEnv })
      return check('service', 'PASS', `re-installed — ${listenerServiceStatus(home)}`)
    } catch (err) {
      return check('service', 'FAIL', `could not re-install: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return check('service', 'FAIL', `installed but not current (an older version, or its definition changed) — \`${invocation()} doctor --fix\` re-installs it`)
}

async function manualCheck(home: string, manual: ServedManual | null, apiBase: string | null, fix: boolean): Promise<DoctorCheck> {
  const file = manualPathFor(home)
  if (fix) {
    const result = await syncManual({ path: file, served: manual, apiBase })
    return check('manual', result.state === 'failed' ? 'FAIL' : result.state === 'current' || result.state === 'updated' ? 'PASS' : 'WARN', describeManualSync(result))
  }
  const checked = checkManual({ path: file, served: manual, apiBase })
  return check('manual', checked.verdict, checked.detail)
}

/** `~/.agentchat` for a home under the user's home directory; the full path otherwise. What output calls this agent. */
export function homeLabel(home: string): string {
  const user = os.homedir()
  return home === user || home.startsWith(user + path.sep) ? `~${home.slice(user.length)}` : home
}

export function cliProfile(home: string, env: NodeJS.ProcessEnv = process.env): HostProfile {
  return {
    label: homeLabel(home),
    id: 'agentchat-cli',
    client: cliClient(),
    home: () => home,
    invocation: () => invocation(env),
    renderAnchor: renderAnchorBlock,
    place: async (_handle, _apiKey, _identityLine, manual) => {
      const identity = resolveIdentity(home)
      const result = await syncManual({ path: manualPathFor(home), served: manual, apiBase: identity?.apiBase ?? null })
      return [`  manual: ${describeManualSync(result)}`]
    },
    unplace: () => removeKeyFiles(home),
    logoutHints: () => (alwaysOnWanted(home) ? [`The listener service stays installed and idles until you sign in again; \`${invocation(env)} listen --uninstall\` removes it.`] : []),
    extraStatus: async ({ manual }: StatusContext): Promise<string[]> => {
      const identity = resolveIdentity(home)
      const read = readListenerConfig(home)
      const lines = ['Listener:']
      lines.push(read.ok ? `  ✓ ${describeListenerConfig(read.config)}` : `  ○ none installed — \`${invocation(env)} listen --run "<command>" --install\``)
      if (alwaysOnWanted(home)) lines.push(`  service: ${listenerServiceStatus(home)}`)
      const manualState = checkManual({ path: manualPathFor(home), served: manual, apiBase: identity?.apiBase ?? null })
      lines.push(`  ${manualState.verdict === 'PASS' ? '✓' : '✗'} manual: ${manualState.detail}`)
      if (identity !== null) {
        const reach = await probeHostedMcp({ apiKey: identity.apiKey, apiBase: identity.apiBase, client: cliClient() })
        lines.push(`  ${reach.ok ? '✓' : '✗'} hosted tools: ${reach.ok ? `${reach.serverName ?? 'reachable'} ${reach.serverVersion ?? ''}`.trim() : (reach.error ?? 'unreachable')}`)
      }
      return lines
    },
    extraDoctorChecks: async (ctx: DoctorContext): Promise<DoctorCheck[]> => {
      const identity = resolveIdentity(home)
      const checks: DoctorCheck[] = [await manualCheck(home, ctx.manual, identity?.apiBase ?? null, ctx.fix === true)]
      const read = readListenerConfig(home)
      let config: ListenerConfig | null = null
      if (read.ok) {
        config = read.config
        checks.push(...listenerChecks(home, config, env))
      } else if (fs.existsSync(path.join(home, 'listener.json'))) {
        checks.push(check('listener', 'FAIL', read.error))
      } else {
        checks.push(check('listener', 'PASS', 'none installed (tools and a foreground `listen` still work)'))
      }
      const service = serviceCheck(home, config, ctx.fix === true)
      if (service !== null) checks.push(service)
      if (identity !== null) {
        const reach = await probeHostedMcp({ apiKey: identity.apiKey, apiBase: identity.apiBase, client: cliClient() })
        checks.push(check('hosted-tools', reach.ok ? 'PASS' : 'FAIL', reach.ok ? `${reach.serverName ?? 'reachable'} ${reach.serverVersion ?? ''}`.trim() : (reach.error ?? 'unreachable')))
      }
      return checks
    },
  }
}

export function cliIdentityCommands(home: string, env: NodeJS.ProcessEnv = process.env): IdentityCommands {
  return createIdentityCommands(cliProfile(home, env))
}
