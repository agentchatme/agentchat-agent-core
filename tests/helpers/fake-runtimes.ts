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

export interface FakeRuntime {
  readonly binDir: string
  readonly recordPath: string
}

export interface FakeRun {
  argv: string[]
  stdin: string
  cwd: string
  env: Record<string, string>
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
      `if (args[0] === '--version') { console.log(${JSON.stringify(version)}); process.exit(0) }`,
      `if (args[0] === ${JSON.stringify(authArgs[0])} && args[1] === ${JSON.stringify(authArgs[1])}) {`,
      "  if (process.env.FAKE_RUNTIME_LOGGED_OUT === '1') { console.log('{\"loggedIn\":false}'); process.exit(1) }",
      "  console.log('{\"loggedIn\":true}'); process.exit(0)",
      '}',
      `if (args[0] === ${JSON.stringify(runArg)}) {`,
      "  const stdin = fs.readFileSync(0, 'utf8')",
      '  const env = {}',
      "  for (const [k, v] of Object.entries(process.env)) if (/^(AGENTCHAT_|CLAUDE|CODEX_)/.test(k)) env[k] = v",
      '  const record = { argv: args, stdin, cwd: process.cwd(), env }',
      "  if (process.env.FAKE_RUNTIME_RECORD) fs.appendFileSync(process.env.FAKE_RUNTIME_RECORD, JSON.stringify(record) + '\\n')",
      "  process.stdout.write('model output that must be discarded\\n')",
      '  process.exit(0)',
      '}',
      `console.error('unsupported fake ${name} command: ' + args.join(' '))`,
      'process.exit(2)',
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
