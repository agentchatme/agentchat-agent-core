import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { atomicWriteFile, renameWithRetry } from '../src/util/fsutil.js'

// ─── The properties of the atomic write that a passing test must prove ──────
//
// The temp name is predictable here on purpose (randomBytes stubbed), so a
// name planted in advance — a symlink pointing at a victim — is exactly the
// name the writer picks. `wx` must refuse it; a plain `w` would follow it.

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync), renameSync: vi.fn(actual.renameSync) }
})

const posix = process.platform !== 'win32'
let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-core-fsutil-tmp-'))
})
afterEach(() => {
  vi.mocked(crypto.randomBytes).mockReset()
  vi.mocked(fs.fsyncSync).mockReset()
  vi.mocked(fs.renameSync).mockReset()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('atomicWriteFile', () => {
  it.skipIf(!posix)('refuses a temp name planted in advance (a symlink to a victim) instead of following it', () => {
    const fixed = Buffer.from('a1b2c3d4e5f6', 'hex')
    vi.mocked(crypto.randomBytes).mockImplementation((() => fixed) as never)
    const victim = path.join(dir, 'victim.txt')
    fs.writeFileSync(victim, 'do not touch\n')
    fs.symlinkSync(victim, path.join(dir, '.credentials.json.a1b2c3d4e5f6.tmp'))
    expect(() => atomicWriteFile(path.join(dir, 'credentials.json'), '{"secret":1}\n', 0o600)).toThrow(/EEXIST/)
    expect(fs.readFileSync(victim, 'utf-8')).toBe('do not touch\n')
    expect(fs.existsSync(path.join(dir, 'credentials.json'))).toBe(false)
  })

  it('flushes the temp file before it is renamed over the target', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    const order: string[] = []
    vi.mocked(fs.fsyncSync).mockImplementation(((fd: number) => {
      order.push('fsync')
      actual.fsyncSync(fd)
    }) as never)
    vi.mocked(fs.renameSync).mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      order.push('rename')
      actual.renameSync(from, to)
    }) as never)
    atomicWriteFile(path.join(dir, 'state.json'), '{}\n', 0o600)
    expect(order).toEqual(['fsync', 'rename'])
    expect(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8')).toBe('{}\n')
  })
})

describe('renameWithRetry', () => {
  it('waits about 20 ms between attempts at its default delay (about 100 ms over six attempts)', () => {
    let attempts = 0
    const started = Date.now()
    expect(() =>
      renameWithRetry('a', 'b', {
        retry: true,
        rename: () => {
          attempts += 1
          throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
        },
      }),
    ).toThrow(/EBUSY/)
    const elapsed = Date.now() - started
    expect(attempts).toBe(6)
    expect(elapsed).toBeGreaterThanOrEqual(90)
    expect(elapsed).toBeLessThan(2_000)
  })
})
