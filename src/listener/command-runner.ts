import * as fs from 'node:fs'
import { hostedMcpUrl } from '../integration/mcp-probe.js'
import type { RunOutcome, RunPreflight, RunRequest, RunRunner, RunnerIdentity } from '../integration/runner.js'
import { spawnRun } from '../integration/spawn-run.js'
import { log } from '../util/log.js'

// ─── The owner's command, once per wake ─────────────────────────────────────
//
// `agentchat listen --run "<command>"`: on each wake the listener runs the
// command line its OWNER configured, through the platform shell, in the
// owner's working directory. The run's prompt — the served wake instruction —
// is written to its stdin and closed. Nothing derived from a wake or a message
// ever reaches the command line: wakes carry no content, and the prompt is
// the server's text, on stdin.
//
// The run learns who it acts as from its environment, never its argv:
//
//   AGENTCHAT_HOME       the identity home (`credentials` holds the key; the
//                        stdio MCP server and the SDKs' examples read it)
//   AGENTCHAT_HANDLE     `@handle`
//   AGENTCHAT_API_BASE   the API it talks to
//   AGENTCHAT_MCP_URL    the hosted tool server
//   AGENTCHAT_WAKE_KIND  `wake` | `invite`
//   AGENTCHAT_RUN_ID     unique per run
//   AGENTCHAT_API_KEY    only when the owner asked for it (`--with-key`);
//                        otherwise an inherited one is REMOVED, so a key in
//                        the listener's own environment never leaks into a
//                        run by accident.
//
// The output is discarded, as for every run (`spawnRun`).

export const RUN_ENV = {
  home: 'AGENTCHAT_HOME',
  handle: 'AGENTCHAT_HANDLE',
  apiBase: 'AGENTCHAT_API_BASE',
  mcpUrl: 'AGENTCHAT_MCP_URL',
  wakeKind: 'AGENTCHAT_WAKE_KIND',
  runId: 'AGENTCHAT_RUN_ID',
  apiKey: 'AGENTCHAT_API_KEY',
} as const

export interface CommandRunnerOptions {
  /** The owner's command line, run through the platform shell. */
  readonly command: string
  readonly identity: RunnerIdentity
  /** Put the key in the run's environment (`AGENTCHAT_API_KEY`). Off by default. */
  readonly withKey?: boolean
  /** The environment runs inherit (defaults to `process.env`). */
  readonly env?: NodeJS.ProcessEnv
}

/** The environment one run of the owner's command gets. Pure; exported for tests. */
export function commandRunEnv(options: CommandRunnerOptions, request: Pick<RunRequest, 'kind' | 'runId'>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) }
  delete env[RUN_ENV.apiKey]
  env[RUN_ENV.home] = options.identity.home
  env[RUN_ENV.handle] = `@${options.identity.handle}`
  env[RUN_ENV.apiBase] = options.identity.apiBase
  env[RUN_ENV.mcpUrl] = hostedMcpUrl(options.identity.apiBase)
  env[RUN_ENV.wakeKind] = request.kind
  env[RUN_ENV.runId] = request.runId
  if (options.withKey === true) env[RUN_ENV.apiKey] = options.identity.apiKey
  return env
}

export class CommandRunner implements RunRunner {
  readonly name = 'command'

  constructor(private readonly options: CommandRunnerOptions) {
    if (options.command.trim().length === 0) throw new Error('the run command is empty')
  }

  async preflight(): Promise<RunPreflight> {
    const workdir = this.options.identity.workdir
    try {
      if (!fs.statSync(workdir).isDirectory()) return { ok: false, detail: `the working directory ${workdir} is not a directory` }
    } catch {
      return { ok: false, detail: `the working directory ${workdir} does not exist` }
    }
    return { ok: true }
  }

  async start(request: RunRequest): Promise<RunOutcome> {
    log.debug(`run ${request.runId} (${request.kind}): the owner's command, prompt on stdin`)
    return spawnRun({
      command: this.options.command,
      args: [],
      shell: true,
      cwd: this.options.identity.workdir,
      env: commandRunEnv(this.options, request),
      stdin: request.prompt,
      budgetMs: request.budgetMs,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.onStarted ? { onStarted: request.onStarted } : {}),
    })
  }
}
