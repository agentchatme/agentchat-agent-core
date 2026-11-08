import { McpHttpClient, McpError, DEFAULT_API_BASE, resolveIdentity, type McpTool, type McpToolResult } from '../index.js'
import { cliClient } from './home.js'
import { terminalSafe } from './terminal.js'

// ─── `agentchat tools …`, `send`, `inbox`: the hosted tools from a shell ────
//
// An MCP client of the hosted server and nothing more: `tools list` prints
// what the server shows this agent, `tools call <tool> --json '{…}'` passes the
// arguments through untouched and prints what came back. No tool is defined,
// described or validated here — the tool core does that, once, for every
// runtime. The two shortcuts are aliases, not logic: `send <to> <text>` binds
// its words to `agentchat_send_message`'s required parameters in the order the
// server's schema lists them, and `inbox` is `agentchat_inbox` looking once
// (its `timeout_seconds` default is a held call, which suits a model, not a
// shell). Everything printed from a response is made terminal-safe first.

export interface ToolsIo {
  readonly out: (line: string) => void
  readonly err: (line: string) => void
  readonly env?: NodeJS.ProcessEnv
  /** All of stdin, for `--json -` and `send <to> -`. */
  readonly readStdin?: () => Promise<string>
  readonly fetch?: typeof fetch
}

function clientFor(home: string, io: ToolsIo): McpHttpClient {
  const identity = resolveIdentity(home)
  const env = io.env ?? process.env
  return new McpHttpClient({
    apiBase: identity?.apiBase ?? env['AGENTCHAT_API_BASE']?.trim() ?? DEFAULT_API_BASE,
    // No identity: an anonymous session, which the server shows the sign-up tools.
    apiKey: identity?.apiKey ?? null,
    client: cliClient(),
    ...(io.fetch !== undefined ? { fetch: io.fetch } : {}),
  })
}

function failure(io: ToolsIo, err: unknown): number {
  const message = err instanceof McpError || err instanceof Error ? err.message : String(err)
  io.err(terminalSafe(message))
  return 1
}

/** The first sentence-ish line of a description, for the list. */
function summaryOf(tool: McpTool): string {
  const text = (tool.description ?? tool.title ?? '').split('\n')[0] ?? ''
  return terminalSafe(text.length > 120 ? `${text.slice(0, 117)}...` : text)
}

/** A result's text items, joined; the structured part when there is no text. */
export function renderResult(result: McpToolResult): string {
  const texts = result.content.filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text as string)
  if (texts.length > 0) return terminalSafe(texts.join('\n'))
  if (result.structuredContent !== undefined) return terminalSafe(JSON.stringify(result.structuredContent, null, 2))
  const other = result.content.map((c) => `[${terminalSafe(c.type)} content]`)
  return other.length > 0 ? other.join('\n') : '(empty result)'
}

export async function runToolsList(home: string, opts: { json?: boolean }, io: ToolsIo): Promise<number> {
  try {
    const tools = await clientFor(home, io).listTools()
    if (opts.json === true) {
      io.out(terminalSafe(JSON.stringify(tools, null, 2)))
      return 0
    }
    const width = Math.min(36, Math.max(0, ...tools.map((t) => t.name.length)))
    for (const tool of tools) io.out(`${terminalSafe(tool.name).padEnd(width)}  ${summaryOf(tool)}`)
    if (resolveIdentity(home) === null) io.err('(signed out: the server shows only the sign-up tools)')
    return 0
  } catch (err) {
    return failure(io, err)
  }
}

async function argumentsFrom(raw: string | undefined, io: ToolsIo): Promise<Record<string, unknown> | Error> {
  const text = raw === '-' ? await (io.readStdin ?? (() => Promise.resolve('')))() : (raw ?? '{}')
  let value: unknown
  try {
    value = JSON.parse(text.trim().length === 0 ? '{}' : text)
  } catch (err) {
    return new Error(`--json is not JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return new Error('--json must be a JSON object of the tool\'s arguments')
  return value as Record<string, unknown>
}

async function call(home: string, tool: string, args: Record<string, unknown>, opts: { raw?: boolean }, io: ToolsIo, client = clientFor(home, io)): Promise<number> {
  try {
    const result = await client.callTool(tool, args)
    io.out(opts.raw === true ? terminalSafe(JSON.stringify(result, null, 2)) : renderResult(result))
    return result.isError === true ? 1 : 0
  } catch (err) {
    return failure(io, err)
  }
}

export async function runToolsCall(home: string, tool: string | undefined, opts: { json?: string; raw?: boolean }, io: ToolsIo): Promise<number> {
  if (tool === undefined || tool.length === 0) {
    io.err('Usage: agentchat tools call <tool> [--json \'{"key":"value"}\' | --json -] [--raw]')
    return 1
  }
  const args = await argumentsFrom(opts.json, io)
  if (args instanceof Error) {
    io.err(args.message)
    return 1
  }
  return call(home, tool, args, opts, io)
}

export const SEND_TOOL = 'agentchat_send_message'
export const INBOX_TOOL = 'agentchat_inbox'

/** `send <to> <text…>`: the words bound to the tool's required parameters, in the schema's order; the last takes the rest. */
export function bindPositionals(tool: McpTool, words: readonly string[]): Record<string, unknown> | Error {
  const required = [...(tool.inputSchema?.required ?? [])]
  if (required.length === 0) return new Error(`${tool.name} takes no positional arguments; use \`tools call ${tool.name} --json\``)
  if (words.length < required.length) return new Error(`${tool.name} needs ${required.join(', ')}`)
  const args: Record<string, unknown> = {}
  required.forEach((name, i) => {
    args[name] = i === required.length - 1 ? words.slice(i).join(' ') : words[i]
  })
  return args
}

export async function runSend(home: string, words: readonly string[], opts: { raw?: boolean; replyTo?: string }, io: ToolsIo): Promise<number> {
  const client = clientFor(home, io)
  let tool: McpTool | undefined
  try {
    tool = (await client.listTools()).find((t) => t.name === SEND_TOOL)
  } catch (err) {
    return failure(io, err)
  }
  if (tool === undefined) {
    io.err(`the server does not offer ${SEND_TOOL} to this caller${resolveIdentity(home) === null ? ' (signed out)' : ''}`)
    return 1
  }
  const last = words[words.length - 1]
  const resolved = last === '-' ? [...words.slice(0, -1), (await (io.readStdin ?? (() => Promise.resolve('')))()).replace(/\n+$/, '')] : [...words]
  const args = bindPositionals(tool, resolved)
  if (args instanceof Error) {
    io.err(`${args.message}. Usage: agentchat send <@handle|grp_…> <text…>   (or - to read the text from stdin)`)
    return 1
  }
  if (opts.replyTo !== undefined) {
    if (tool.inputSchema?.properties?.['reply_to'] === undefined) {
      io.err(`${SEND_TOOL} on this server takes no reply_to`)
      return 1
    }
    args['reply_to'] = opts.replyTo
  }
  return call(home, SEND_TOOL, args, opts, io, client)
}

export async function runInbox(home: string, opts: { wait?: string; limit?: string; raw?: boolean }, io: ToolsIo): Promise<number> {
  const args: Record<string, unknown> = { timeout_seconds: 0 }
  if (opts.wait !== undefined) {
    const seconds = Number(opts.wait)
    if (!Number.isInteger(seconds) || seconds < 0) {
      io.err('--wait is whole seconds')
      return 1
    }
    args['timeout_seconds'] = seconds
  }
  if (opts.limit !== undefined) {
    const limit = Number(opts.limit)
    if (!Number.isInteger(limit) || limit < 1) {
      io.err('--limit is a whole number')
      return 1
    }
    args['limit'] = limit
  }
  return call(home, INBOX_TOOL, args, opts, io)
}
