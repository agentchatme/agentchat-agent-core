import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { redactDiagnostic, spawnRun } from '../src/integration/spawn-run.js'
import { until } from './helpers/server-double.js'

// ─── One headless run: bounded, classified, output discarded ────────────────

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-spawn-run-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

function script(body: string): string {
  const file = path.join(dir, `script-${Math.random().toString(16).slice(2)}.cjs`)
  fs.writeFileSync(file, body)
  return file
}

const run = (file: string, extra: Partial<Parameters<typeof spawnRun>[0]> = {}) =>
  spawnRun({
    command: process.execPath,
    args: [file],
    cwd: dir,
    env: { ...process.env },
    stdin: null,
    budgetMs: 10_000,
    ...extra,
  })

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('spawnRun', () => {
  it('exit 0 is ok, and the output is discarded', async () => {
    const outcome = await run(script("process.stdout.write('peer text that must not be kept'); process.exit(0)"))
    expect(outcome).toMatchObject({ state: 'ok', exitCode: 0 })
    expect(JSON.stringify(outcome)).not.toContain('peer text')
  })

  it('non-zero exit with nothing on stdout is NOT STARTED', async () => {
    const outcome = await run(script('process.exit(3)'))
    expect(outcome).toMatchObject({ state: 'not_started', exitCode: 3 })
    expect(outcome.detail).toMatch(/exit 3 with nothing on stdout/)
  })

  it('a signed-out CLI that complains on stderr and exits is NOT STARTED, and the complaint rides along redacted', async () => {
    // README § Verify step 8: `claude auth logout`, DM again → `run not_started`.
    // stderr is not output the runtime produced for the task; it is the reason
    // the runtime did not get going.
    const outcome = await run(script("process.stderr.write('Not logged in. Bearer ac_" + 'z'.repeat(40) + " is invalid\\n'); process.exit(1)"))
    expect(outcome).toMatchObject({ state: 'not_started', exitCode: 1 })
    expect(outcome.detail).toMatch(/exit 1 with nothing on stdout: Not logged in/)
    expect(outcome.detail).not.toMatch(/ac_z{8,}/)
    expect(outcome.detail).toContain('[redacted')
  })

  it('a missing binary is NOT STARTED', async () => {
    const outcome = await spawnRun({
      command: path.join(dir, 'no-such-runtime'),
      args: [],
      cwd: dir,
      env: { ...process.env },
      stdin: null,
      budgetMs: 10_000,
    })
    expect(outcome.state).toBe('not_started')
  })

  it('non-zero exit after output on stdout is FAILED with a bounded, redacted stderr tail', async () => {
    const outcome = await run(
      script(
        "process.stdout.write('started\\n'); process.stderr.write('auth failed for Bearer ac_" +
          'z'.repeat(40) +
          " and api_key=sk-" +
          'q'.repeat(30) +
          "\\n'); process.exit(1)",
      ),
    )
    expect(outcome).toMatchObject({ state: 'failed', exitCode: 1 })
    expect(outcome.detail).toContain('exit 1')
    expect(outcome.detail).not.toMatch(/ac_z{8,}/)
    expect(outcome.detail).not.toMatch(/sk-q{8,}/)
    expect(outcome.detail).toContain('[redacted')
  })

  it('a run past its budget is killed and TIMED OUT', async () => {
    const started = Date.now()
    const outcome = await run(script("process.stdout.write('started\\n'); setInterval(() => {}, 1000)"), { budgetMs: 300, graceMs: 300 })
    expect(outcome.state).toBe('timed_out')
    expect(outcome.detail).toMatch(/budget/)
    expect(Date.now() - started).toBeLessThan(5_000)
  }, 10_000)

  it('aborting the signal SIGTERMs the whole process group — a grandchild too — and the run is FAILED as interrupted', async () => {
    // The daemon's shutdown path: the run is a detached group leader; the
    // runtime it starts may itself spawn (an MCP helper, a shell). All of it
    // must be gone before the daemon exits, or the restarted daemon runs beside
    // an orphan.
    const pidFile = path.join(dir, 'grandchild.pid')
    const child = script(
      [
        "const { spawn } = require('node:child_process')",
        "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid))`,
        "process.stdout.write('started\\n')",
        'setInterval(() => {}, 1000)',
      ].join('\n'),
    )
    const controller = new AbortController()
    const pending = run(child, { signal: controller.signal, graceMs: 1_000 })
    await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf-8').length > 0)
    const grandchild = Number(fs.readFileSync(pidFile, 'utf-8'))
    expect(alive(grandchild)).toBe(true)

    const started = Date.now()
    controller.abort()
    const outcome = await pending
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toMatch(/interrupted/)
    expect(Date.now() - started).toBeLessThan(3_000)
    await until(() => !alive(grandchild), 2_000)
  }, 10_000)

  it('a signal that is already aborted starts nothing', async () => {
    const outcome = await run(script("process.stdout.write('must not run'); process.exit(0)"), { signal: AbortSignal.abort() })
    expect(outcome.state).toBe('not_started')
    expect(outcome.detail).toMatch(/interrupted before/)
  })

  it('writes the prompt to stdin and closes it', async () => {
    const outcome = await run(
      script("let d=''; process.stdin.on('data', c => d += c); process.stdin.on('end', () => { process.exit(d === 'THE PROMPT' ? 0 : 9) })"),
      { stdin: 'THE PROMPT' },
    )
    expect(outcome.state).toBe('ok')
  })

  it('runs in the given cwd with the given env', async () => {
    const outcome = await run(
      script("process.exit(process.cwd() === process.env.EXPECT_CWD && process.env.AGENTCHAT_PROBE === 'yes' ? 0 : 7)"),
      { env: { ...process.env, EXPECT_CWD: fs.realpathSync(dir), AGENTCHAT_PROBE: 'yes' } },
    )
    expect(outcome.state).toBe('ok')
  })
})

describe('redactDiagnostic', () => {
  it('strips terminal escapes and key shapes, and bounds the tail', () => {
    const noisy = '\u001B[31merror\u001B[0m Authorization: Bearer ' + 'A'.repeat(40) + ' ' + 'x'.repeat(2_000)
    const out = redactDiagnostic(noisy, 100)
    expect(out.length).toBeLessThanOrEqual(100)
    expect(out).not.toContain('\u001B')
    expect(redactDiagnostic('key ac_' + 'b'.repeat(32))).toBe('key [redacted AgentChat key]')
  })
})


describe('spawnRun — onStarted', () => {
  it('fires once the process has spawned, before it ends', async () => {
    const events: string[] = []
    const outcome = await spawnRun({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("x")'],
      cwd: process.cwd(),
      env: process.env,
      stdin: null,
      budgetMs: 10_000,
      onStarted: () => events.push('started'),
    })
    expect(outcome.state).toBe('ok')
    expect(events).toEqual(['started'])
  })

  it('a binary that does not exist is not_started; onStarted stays silent where the spawn itself fails', async () => {
    const events: string[] = []
    const outcome = await spawnRun({
      command: 'agentchat-no-such-binary-' + process.pid,
      args: [],
      cwd: process.cwd(),
      env: process.env,
      stdin: null,
      budgetMs: 10_000,
      onStarted: () => events.push('started'),
    })
    expect(outcome.state).toBe('not_started')
    // `onStarted` means the child process spawned. On Windows cross-spawn runs
    // the command through cmd.exe, so the shim spawns and only then reports the
    // missing binary (exit 1, nothing on stdout): `onStarted` fires there, and
    // the invoker takes the invite's record back on `not_started`
    // (`settleInvite`). Elsewhere the spawn fails outright and nothing fires.
    expect(events).toEqual(process.platform === 'win32' ? ['started'] : [])
  })
})
