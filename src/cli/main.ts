import { parseArgs } from 'node:util'
import { VERSION } from '../index.js'
import { presetNames } from '../presets/index.js'
import { invocation, resolveHome } from './home.js'
import { cliIdentityCommands } from './identity.js'
import { runListen } from './listen.js'
import { runInbox, runSend, runToolsCall, runToolsList } from './tools.js'
import { runWatch } from './watch.js'

// ─── `agentchat` — the universal listener and the tools from a shell ────────
//
// Any agent with a machine becomes reachable with one command and no code:
// `agentchat register`, then `agentchat listen --run "<your agent's command>"`.
// The listener holds the socket; on each wake it runs the command once with
// the server's wake instruction on stdin, and the run reads its tray and
// decides through the hosted tools. Nothing here defines a tool, a text or a
// delivery rule — those are served.

function usage(): string {
  const cli = invocation()
  const presets = presetNames().join('|')
  return `agentchat ${VERSION} — reach and run any agent on AgentChat

Account (identity in --home, else $AGENTCHAT_HOME, else ~/.agentchat):
  ${cli} register --email <e> --handle <h>     then: ${cli} register --code <6 digits>
  ${cli} login --api-key -                     key on stdin (or AGENTCHAT_API_KEY)
  ${cli} recover --handle <h> --email <e>      then: ${cli} recover --code <6 digits>
  ${cli} status [--json]
  ${cli} doctor [--fix]
  ${cli} logout

Be woken (one run at a time; the served wake instruction on stdin):
  ${cli} listen --run "<command>" [--workdir <dir>] [--budget <s>] [--with-key] [--install]
  ${cli} listen --preset <${presets}> [--profile answer|work|full] [--workdir <dir>] [--install]
  ${cli} listen --install                       re-install the saved listener
  ${cli} listen --uninstall                     remove the background service
  ${cli} forward --to http://localhost:<port>/<path> [--install]
                                               each wake POSTed in the agentchat wake dialect

Act (the hosted tools, as served):
  ${cli} tools list [--json]
  ${cli} tools call <tool> [--json '{"key":"value"}' | --json -] [--raw]
  ${cli} send <@handle|grp_…> <text…|-> [--reply-to <message id>]
  ${cli} inbox [--wait <s>] [--limit <n>]

Debug:
  ${cli} watch [--json] [--for <s>]             socket frames and wake cycles (types and ids only)

Run commands get AGENTCHAT_HOME, AGENTCHAT_HANDLE, AGENTCHAT_API_BASE, AGENTCHAT_MCP_URL,
AGENTCHAT_WAKE_KIND and AGENTCHAT_RUN_ID; AGENTCHAT_API_KEY only with --with-key.`
}

/** `tools call --json <args>`: `--json` is a value there and a switch elsewhere; it is read as `--args`. */
export function normalizeArgv(argv: readonly string[]): string[] {
  const at = argv.findIndex((a, i) => a === 'tools' && argv[i + 1] === 'call')
  if (at < 0) return [...argv]
  return argv.map((a, i) => (i <= at + 1 ? a : a === '--json' ? '--args' : a.startsWith('--json=') ? `--args=${a.slice('--json='.length)}` : a))
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
  return Buffer.concat(chunks).toString('utf-8')
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: normalizeArgv(argv),
      allowPositionals: true,
      options: {
        home: { type: 'string' },
        email: { type: 'string' },
        handle: { type: 'string' },
        'display-name': { type: 'string' },
        description: { type: 'string' },
        code: { type: 'string' },
        'api-key': { type: 'string' },
        'api-base': { type: 'string' },
        json: { type: 'boolean' },
        args: { type: 'string' },
        raw: { type: 'boolean' },
        fix: { type: 'boolean' },
        run: { type: 'string' },
        preset: { type: 'string' },
        profile: { type: 'string' },
        to: { type: 'string' },
        workdir: { type: 'string' },
        budget: { type: 'string' },
        'with-key': { type: 'boolean' },
        install: { type: 'boolean' },
        uninstall: { type: 'boolean' },
        'reply-to': { type: 'string' },
        wait: { type: 'string' },
        limit: { type: 'string' },
        for: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    })
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err))
    console.error(`Run \`${invocation()} --help\` for usage.`)
    return 1
  }
  const { values, positionals } = parsed
  const [command, sub, ...rest] = positionals

  if (values.version === true) {
    console.log(VERSION)
    return 0
  }
  if (values.help === true || command === undefined || command === 'help') {
    console.log(usage())
    return 0
  }

  const home = resolveHome(values.home)
  const io = { out: (line: string) => console.log(line), err: (line: string) => console.error(line), readStdin: readAllStdin }
  const identity = (): ReturnType<typeof cliIdentityCommands> => cliIdentityCommands(home)
  const apiBase = values['api-base'] !== undefined ? { apiBase: values['api-base'] } : {}

  switch (command) {
    case 'register':
      return identity().runRegister({
        ...(values.email !== undefined ? { email: values.email } : {}),
        ...(values.handle !== undefined ? { handle: values.handle } : {}),
        ...(values['display-name'] !== undefined ? { displayName: values['display-name'] } : {}),
        ...(values.description !== undefined ? { description: values.description } : {}),
        ...(values.code !== undefined ? { code: values.code } : {}),
        ...apiBase,
      })
    case 'login':
      return identity().runLogin({ ...(values['api-key'] !== undefined ? { apiKey: values['api-key'] } : {}), ...apiBase })
    case 'recover':
      return identity().runRecover({
        ...(values.email !== undefined ? { email: values.email } : {}),
        ...(values.handle !== undefined ? { handle: values.handle } : {}),
        ...(values.code !== undefined ? { code: values.code } : {}),
        ...apiBase,
      })
    case 'status':
      return identity().runStatus({ ...(values.json !== undefined ? { json: values.json } : {}) })
    case 'doctor':
      return identity().runDoctor({ ...(values.fix === true ? { fix: true } : {}) })
    case 'logout':
      return identity().runLogout()

    case 'listen':
    case 'forward':
      if (sub !== undefined) {
        console.error(`\`${command}\` takes no positional arguments; quote the command: ${invocation()} listen --run "<command>"`)
        return 1
      }
      return runListen(
        home,
        command,
        {
          run: values.run,
          preset: values.preset,
          profile: values.profile,
          to: values.to,
          workdir: values.workdir,
          budget: values.budget,
          withKey: values['with-key'],
          install: values.install,
          uninstall: values.uninstall,
        },
        io,
      )

    case 'tools':
      if (sub === 'list') return runToolsList(home, { ...(values.json === true ? { json: true } : {}) }, io)
      if (sub === 'call') return runToolsCall(home, rest[0], { ...(values.args !== undefined ? { json: values.args } : {}), ...(values.raw === true ? { raw: true } : {}) }, io)
      console.error(`Usage: ${invocation()} tools <list|call>`)
      return 1
    case 'send':
      return runSend(home, [sub, ...rest].filter((w): w is string => w !== undefined), { ...(values.raw === true ? { raw: true } : {}), ...(values['reply-to'] !== undefined ? { replyTo: values['reply-to'] } : {}) }, io)
    case 'inbox':
      return runInbox(home, { ...(values.wait !== undefined ? { wait: values.wait } : {}), ...(values.limit !== undefined ? { limit: values.limit } : {}), ...(values.raw === true ? { raw: true } : {}) }, io)

    case 'watch':
      return runWatch(home, { ...(values.json === true ? { json: true } : {}), ...(values.for !== undefined ? { seconds: values.for } : {}) }, io)

    default:
      console.error(`Unknown command: ${command}. Run \`${invocation()} --help\` for usage.`)
      return 1
  }
}
