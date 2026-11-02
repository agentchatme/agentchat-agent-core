import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { redactDiagnostic, spawnRun } from '../src/doorbell/spawn-run.js'

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

describe('spawnRun', () => {
  it('exit 0 is ok, and the output is discarded', async () => {
    const outcome = await run(script("process.stdout.write('peer text that must not be kept'); process.exit(0)"))
    expect(outcome).toMatchObject({ state: 'ok', exitCode: 0 })
    expect(JSON.stringify(outcome)).not.toContain('peer text')
  })

  it('non-zero exit before any output is NOT STARTED', async () => {
    const outcome = await run(script('process.exit(3)'))
    expect(outcome).toMatchObject({ state: 'not_started', exitCode: 3 })
    expect(outcome.detail).toMatch(/exit 3 before any output/)
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

  it('non-zero exit after output is FAILED with a bounded, redacted stderr tail', async () => {
    const outcome = await run(
      script(
        "process.stderr.write('auth failed for Bearer ac_" + 'z'.repeat(40) + " and api_key=sk-" + 'q'.repeat(30) + "\\n'); process.exit(1)",
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
