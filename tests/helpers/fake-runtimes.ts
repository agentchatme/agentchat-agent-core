import * as fs from 'node:fs'
import * as path from 'node:path'

// ─── Fake coding-agent binaries for the preset tests ────────────────────────
//
// Deterministic `claude` / `codex` stand-ins that model only what a preset
// touches — the version probe, the sign-in probe, and one headless run that
// records its argv, stdin, cwd and the AgentChat/runtime variables of its
// environment — so no test reaches a developer's real runtime or sign-in.
//
//   FAKE_RUNTIME_RECORD=<file>     where runs append their record (JSON lines)
//   FAKE_RUNTIME_LOGGED_OUT=1      the sign-in probe says no
//   FAKE_MCP_LIST=<json>           what `mcp list --json` prints (default: agentchat only)
//   FAKE_MCP_LIST_MODE=fail|hang|garbage   how `mcp list` misbehaves instead
//   FAKE_MCP_LIST_PIDS=<file>      `hang`: where the hung listing writes its pid and its child's
//   FAKE_RUNTIME_PROBE_HANG=version|auth   that probe hangs, with a child holding its output pipe
//   FAKE_RUNTIME_PROBE_PIDS=<file> where the hung probe writes its pid and its child's
//   FAKE_MCP_LIST_RECORD=<file>    where `mcp list` appends its argv, cwd and env
//
// A run's record also says what its `--mcp-config` file held at that moment:
// the server names and the file mode (never its contents — it carries a key).

export interface FakeRuntime {
  readonly binDir: string
  readonly recordPath: string
}

export interface FakeRun {
  argv: string[]
  stdin: string
  cwd: string
  env: Record<string, string>
  /** What the run's `--mcp-config` file held when it started (names and mode only), `'unreadable'`, or null without one. */
  mcpConfig: { servers: string[]; mode: number } | 'unreadable' | null
  /** The text of the run's `--append-system-prompt-file` when it started, `'unreadable'`, or null without one. */
  appendedSystemPrompt: string | null
}

export interface FakeMcpList {
  argv: string[]
  cwd: string
  env: Record<string, string>
}

export function readFakeMcpLists(file: string): FakeMcpList[] {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FakeMcpList)
}

function install(root: string, name: string, version: string, authArgs: [string, string], runArg: string): FakeRuntime {
  const binDir = path.join(root, 'fake-bin')
  const recordPath = path.join(root, `fake-${name}-runs.jsonl`)
  fs.mkdirSync(binDir, { recursive: true })
  fs.writeFileSync(
    path.join(binDir, name),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs')",
      'const args = process.argv.slice(2)',
      // A probe that hangs (FAKE_RUNTIME_PROBE_HANG=version|auth), with a child of its own
      // holding the output pipe, as an npm launcher and its native binary do; both pids
      // go to FAKE_RUNTIME_PROBE_PIDS.
      'const hangProbe = (which) => {',
      "  if (process.env.FAKE_RUNTIME_PROBE_HANG !== which) return",
      "  const kid = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: ['ignore', 'inherit', 'inherit'] })",
      "  if (process.env.FAKE_RUNTIME_PROBE_PIDS) fs.writeFileSync(process.env.FAKE_RUNTIME_PROBE_PIDS, JSON.stringify([process.pid, kid.pid]))",
      '  setTimeout(() => {}, 600000)',
      "  throw 'hang'",
      '}',
      'try {',
      `if (args[0] === '--version') { hangProbe('version'); console.log(${JSON.stringify(version)}); process.exit(0) }`,
      `if (args[0] === ${JSON.stringify(authArgs[0])} && args[1] === ${JSON.stringify(authArgs[1])}) {`,
      "  hangProbe('auth')",
      "  if (process.env.FAKE_RUNTIME_LOGGED_OUT === '1') { console.log('{\"loggedIn\":false}'); process.exit(1) }",
      "  console.log('{\"loggedIn\":true}'); process.exit(0)",
      '}',
      "if (args[0] === 'mcp' && args[1] === 'list') {",
      '  const env = {}',
      "  for (const [k, v] of Object.entries(process.env)) if (/^(AGENTCHAT_|CLAUDE|CODEX_)/.test(k)) env[k] = v",
      "  if (process.env.FAKE_MCP_LIST_RECORD) fs.appendFileSync(process.env.FAKE_MCP_LIST_RECORD, JSON.stringify({ argv: args, cwd: process.cwd(), env }) + '\\n')",
      "  const mode = process.env.FAKE_MCP_LIST_MODE",
      "  if (mode === 'fail') { console.error('config error'); process.exit(1) }",
      // A hung listing with a child of its own holding the output pipe, as the npm
      // launcher and the native binary do: both pids go to FAKE_MCP_LIST_PIDS.
      "  if (mode === 'hang') {",
      "    const kid = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: ['ignore', 'inherit', 'inherit'] })",
      "    if (process.env.FAKE_MCP_LIST_PIDS) fs.writeFileSync(process.env.FAKE_MCP_LIST_PIDS, JSON.stringify([process.pid, kid.pid]))",
      '    setTimeout(() => {}, 600000)',
      '    return',
      '  }',
      "  if (mode === 'garbage') { console.log('not json'); process.exit(0) }",
      "  console.log(process.env.FAKE_MCP_LIST || JSON.stringify([{ name: 'agentchat', enabled: true }]))",
      '  process.exit(0)',
      '}',
      `if (args[0] === ${JSON.stringify(runArg)}) {`,
      "  const stdin = fs.readFileSync(0, 'utf8')",
      '  const env = {}',
      "  for (const [k, v] of Object.entries(process.env)) if (/^(AGENTCHAT_|CLAUDE|CODEX_)/.test(k)) env[k] = v",
      "  const at = args.indexOf('--mcp-config')",
      '  let mcpConfig = null',
      "  if (at >= 0) { try { const file = args[at + 1]; mcpConfig = { servers: Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers || {}), mode: fs.statSync(file).mode & 0o777 } } catch { mcpConfig = 'unreadable' } }",
      "  const sp = args.indexOf('--append-system-prompt-file')",
      "  let appendedSystemPrompt = null",
      "  if (sp >= 0) { try { appendedSystemPrompt = fs.readFileSync(args[sp + 1], 'utf8') } catch { appendedSystemPrompt = 'unreadable' } }",
      '  const record = { argv: args, stdin, cwd: process.cwd(), env, mcpConfig, appendedSystemPrompt }',
      "  if (process.env.FAKE_RUNTIME_RECORD) fs.appendFileSync(process.env.FAKE_RUNTIME_RECORD, JSON.stringify(record) + '\\n')",
      "  process.stdout.write('model output that must be discarded\\n')",
      '  process.exit(0)',
      '}',
      `console.error('unsupported fake ${name} command: ' + args.join(' '))`,
      'process.exit(2)',
      "} catch (e) { if (e !== 'hang') throw e }",
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  // Windows resolves bare commands through PATHEXT rather than shebangs.
  fs.writeFileSync(path.join(binDir, `${name}.cmd`), `@echo off\r\nnode "%~dp0${name}" %*\r\n`)
  return { binDir, recordPath }
}

export const installFakeClaude = (root: string): FakeRuntime => install(root, 'claude', '2.1.316 (Claude Code)', ['auth', 'status'], '-p')
export const installFakeCodex = (root: string): FakeRuntime => install(root, 'codex', 'codex-cli 0.154.0', ['login', 'status'], 'exec')

export function readFakeRuns(fake: FakeRuntime): FakeRun[] {
  if (!fs.existsSync(fake.recordPath)) return []
  return fs
    .readFileSync(fake.recordPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FakeRun)
}
