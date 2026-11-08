import * as path from 'node:path'
import {
  ensureForwardSecret,
  forwardSecretPath,
  forwardUrlProblem,
  describeListenerConfig,
  isRunProfile,
  ListenerConfigSchema,
  readListenerConfig,
  resolveIdentity,
  resolveRunProfile,
  writeListenerConfig,
  type ListenerConfig,
  type ListenerConfigInput,
} from '../index.js'
import { runIntegration } from '../daemon-entry.js'
import { presetNamed, presetNames } from '../presets/index.js'
import { invocation } from './home.js'
import { planListener, type PlanOptions } from './runners.js'
import { installListenerService, listenerServiceStatus, uninstallListenerService } from './service.js'

// ─── `agentchat listen` / `agentchat forward` ───────────────────────────────
//
// One resident loop, three things it can do on a wake (listener.json modes):
// run the owner's command, run a known coding agent's headless mode (a
// preset), or forward the wake to the owner's endpoint. In the foreground it
// runs what the flags say until Ctrl-C; with `--install` the choice is written
// to `<home>/listener.json` and a background service runs it from then on.
// One listener per identity home (the engine's leader lock): a foreground
// listener on a home whose service is running is refused.

export interface ListenFlags {
  readonly run?: string | undefined
  readonly preset?: string | undefined
  readonly profile?: string | undefined
  readonly to?: string | undefined
  readonly workdir?: string | undefined
  /** Seconds. */
  readonly budget?: string | undefined
  readonly withKey?: boolean | undefined
  readonly install?: boolean | undefined
  readonly uninstall?: boolean | undefined
}

export interface ListenIo {
  readonly out: (line: string) => void
  readonly err: (line: string) => void
  readonly env?: NodeJS.ProcessEnv
  readonly cwd?: string
  /** Tests: end a foreground listener. */
  readonly signal?: AbortSignal
  /** Tests: what a signal-initiated shutdown calls last. */
  readonly exit?: (code: number) => void
  /** Tests: the bundle the service copies. */
  readonly shipped?: string
  readonly plan?: PlanOptions
}

type Built = { ok: true; config: ListenerConfigInput } | { ok: false; error: string }

function budgetMs(raw: string | undefined): number | undefined | Error {
  if (raw === undefined) return undefined
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 7_200) return new Error('--budget is seconds, 1–7200')
  return Math.round(seconds * 1000)
}

/** The listener config the flags describe. Pure apart from reading `env`. */
export function configFromFlags(mode: 'listen' | 'forward', flags: ListenFlags, io: { env: NodeJS.ProcessEnv; cwd: string }): Built {
  const budget = budgetMs(flags.budget)
  if (budget instanceof Error) return { ok: false, error: budget.message }
  const workdir = path.resolve(io.cwd, flags.workdir ?? '.')
  const common = { version: 1 as const, workdir, ...(budget !== undefined ? { budget_ms: budget } : {}), updated_at: new Date().toISOString() }

  if (mode === 'forward') {
    if (flags.run !== undefined || flags.preset !== undefined) return { ok: false, error: '`forward` takes --to only; `listen` runs a command' }
    if (flags.to === undefined) return { ok: false, error: `Missing --to. Usage: ${invocation(io.env)} forward --to http://localhost:<port>/<path>` }
    const problem = forwardUrlProblem(flags.to)
    if (problem !== null) return { ok: false, error: problem }
    return { ok: true, config: { ...common, mode: 'forward', url: flags.to } }
  }

  if (flags.to !== undefined) return { ok: false, error: '--to belongs to `forward`' }
  if (flags.run !== undefined && flags.preset !== undefined) return { ok: false, error: 'pass --run or --preset, not both' }
  if (flags.run !== undefined) {
    if (flags.run.trim().length === 0) return { ok: false, error: '--run needs a command' }
    if (flags.profile !== undefined) return { ok: false, error: '--profile belongs to a preset; your command decides what its runs may do' }
    return { ok: true, config: { ...common, mode: 'run', command: flags.run, with_key: flags.withKey === true } }
  }
  if (flags.preset !== undefined) {
    if (flags.withKey === true) return { ok: false, error: '--with-key belongs to --run; a preset hands its runs the key itself' }
    if (presetNamed(flags.preset) === null) return { ok: false, error: `unknown preset "${flags.preset}" (presets: ${presetNames().join(', ')})` }
    if (flags.profile !== undefined && !isRunProfile(flags.profile)) return { ok: false, error: '--profile is answer, work or full' }
    const profile = flags.profile !== undefined && isRunProfile(flags.profile) ? flags.profile : resolveRunProfile(io.env)
    return { ok: true, config: { ...common, mode: 'preset', preset: flags.preset, profile } }
  }
  return { ok: false, error: `Missing what to run. Usage: ${invocation(io.env)} listen --run "<command>"  or  ${invocation(io.env)} listen --preset <${presetNames().join('|')}>` }
}

export async function runListen(home: string, mode: 'listen' | 'forward', flags: ListenFlags, io: ListenIo): Promise<number> {
  const env = io.env ?? process.env
  const cwd = io.cwd ?? process.cwd()
  const cli = invocation(env)

  if (flags.uninstall === true) {
    try {
      const { label } = uninstallListenerService(home)
      io.out(`Listener service ${label} removed. ${home}/listener.json is kept; \`${cli} listen --install\` brings it back.`)
      return 0
    } catch (err) {
      io.err(`Could not remove the listener service: ${err instanceof Error ? err.message : String(err)}`)
      return 1
    }
  }

  // `listen --install` with nothing else re-installs what is saved.
  const nothingGiven = flags.run === undefined && flags.preset === undefined && flags.to === undefined
  let config: ListenerConfig
  if (flags.install === true && nothingGiven && mode === 'listen') {
    const saved = readListenerConfig(home)
    if (!saved.ok) {
      io.err(`${saved.error}. Say what to run: ${cli} listen --run "<command>" --install`)
      return 1
    }
    config = saved.config
  } else {
    const built = configFromFlags(mode, flags, { env, cwd })
    if (!built.ok) {
      io.err(built.error)
      return 1
    }
    if (flags.install === true) config = writeListenerConfig(home, built.config)
    else {
      const parsed = ListenerConfigSchema.safeParse(built.config)
      if (!parsed.success) {
        io.err(parsed.error.issues[0]?.message ?? 'invalid listener config')
        return 1
      }
      config = parsed.data
    }
  }

  let plan
  try {
    plan = planListener(home, config, { env, ...io.plan })
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err))
    return 1
  }
  const identity = resolveIdentity(home)
  const forwardNote = config.mode === 'forward' ? [`Bearer secret: ${forwardSecretPath(home)} — your endpoint checks \`Authorization: Bearer <that file's contents>\`.`] : []

  if (flags.install === true) {
    if (config.mode === 'forward') ensureForwardSecret(home)
    try {
      const { label } = installListenerService(home, { extraEnv: plan.preset?.serviceEnv ?? [], env, ...(io.shipped !== undefined ? { shipped: io.shipped } : {}) })
      io.out(
        [
          `Listener installed (${label}): ${describeListenerConfig(config)}.`,
          `  ${listenerServiceStatus(home)}`,
          ...forwardNote.map((l) => `  ${l}`),
          identity === null
            ? `  It idles until this home has an identity: \`${cli} register\` or \`${cli} login\`.`
            : `  Acting as @${identity.handle ?? '?'}; one run at a time, the served wake instruction on stdin.`,
          `  \`${cli} status\` shows what it does; \`${cli} listen --uninstall\` removes it.`,
        ].join('\n'),
      )
      return 0
    } catch (err) {
      io.err(`Could not install the listener service: ${err instanceof Error ? err.message : String(err)}`)
      return 1
    }
  }

  if (identity === null) {
    io.err(`No AgentChat identity in ${home}. Set one up first: ${cli} register --email <email> --handle <handle>   (or ${cli} login)`)
    return 1
  }
  if (config.mode === 'forward') ensureForwardSecret(home)
  io.out(
    [
      `Listening as @${identity.handle ?? '?'} — on each wake: ${describeListenerConfig(config).replace(/^runs/, 'run').replace(/^forwards/, 'forward')}.`,
      ...forwardNote,
      'One run at a time; the served wake instruction goes to stdin; no message content is ever on a command line. Ctrl-C stops.',
    ].join('\n'),
  )
  const code = await runIntegration({
    home,
    workdir: config.workdir,
    runner: plan.runner,
    client: plan.client,
    manualPointer: plan.manualPointer,
    manualPath: plan.manualPath,
    ...(config.mode === 'preset' ? { profile: config.profile } : {}),
    ...(config.budget_ms !== undefined ? { budgetMs: config.budget_ms } : {}),
    env,
    ...(io.signal !== undefined ? { signal: io.signal } : {}),
    ...(io.exit !== undefined ? { exit: io.exit } : {}),
  })
  if (code !== 0) io.err(`Another listener already serves ${home} (the installed service, or another terminal). \`${cli} status\` shows it.`)
  return code
}
