import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { integration as kit } from 'agentchatme'
import { atomicWriteFile, renameWithRetry } from '../src/util/fsutil.js'

// ─── util/fsutil is the synchronous twin of the kit's writer ────────────────
//
// The SDK kit (`integration` in `agentchatme`) has `writeAtomic` and
// `renameWithRetry`, async only; every caller of agent-core's copies is
// synchronous (service installers, credential and state writes, the status
// file from the receive loop's event handlers, a preset's `runner()`). So the
// copy stays — on two conditions, both kept here:
//
// 1. The day the kit exports a synchronous form, the first test fails and
//    says what to do: delete util/fsutil's copy and switch to the kit.
// 2. Until then the two behave the same: both run through the same cases and
//    must end in the same files, modes, errors and attempt counts.

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})

describe('the exit: the kit has no synchronous writer yet', () => {
  it('fails once agentchatme exports writeAtomicSync or renameWithRetrySync — then delete util/fsutil’s copy and switch to the kit', () => {
    const exported = Object.keys(kit)
    for (const name of ['writeAtomicSync', 'renameWithRetrySync']) {
      expect(
        exported.includes(name),
        `agentchatme's integration kit now exports ${name}: delete src/util/fsutil.ts's copy (atomicWriteFile, renameWithRetry, and atomicCopyFile's rename) and call the kit instead`,
      ).toBe(false)
    }
    // Under any other name, too: a synchronous file writer or rename in the kit is the cue.
    const syncWriters = exported.filter((k) => /sync$/i.test(k) && /write|rename|atomic|file/i.test(k))
    expect(syncWriters, `agentchatme's integration kit now exports ${syncWriters.join(', ')}: delete src/util/fsutil.ts's copy and call the kit instead`).toEqual([])
    // What the copy is the twin of is still there.
    expect(typeof kit.writeAtomic).toBe('function')
    expect(typeof kit.renameWithRetry).toBe('function')
  })
})

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-core-parity-'))
})
afterEach(() => {
  vi.mocked(fs.renameSync).mockReset()
  try {
    fs.chmodSync(dir, 0o700)
  } catch {
    /* restored for cleanup only */
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

const posix = process.platform !== 'win32'
const root = typeof process.getuid === 'function' && process.getuid() === 0

interface Outcome {
  readonly error: string | null
  readonly files: Record<string, { bytes: string; mode: number } | 'dir'>
}

/** What a directory holds after a write: names, contents, modes (permission bits on POSIX only). */
function snapshot(base: string): Record<string, { bytes: string; mode: number } | 'dir'> {
  const out: Record<string, { bytes: string; mode: number } | 'dir'> = {}
  for (const entry of fs.readdirSync(base, { withFileTypes: true, recursive: true })) {
    const full = path.join(entry.parentPath ?? entry.path, entry.name)
    const rel = path.relative(base, full).split(path.sep).join('/')
    if (entry.isDirectory()) {
      out[`${rel}/`] = 'dir'
      if (posix) out[`${rel}/ (mode)`] = { bytes: '', mode: fs.statSync(full).mode & 0o777 }
      continue
    }
    out[rel] = { bytes: fs.readFileSync(full).toString('hex'), mode: posix ? fs.statSync(full).mode & 0o777 : 0 }
  }
  return out
}

/** Run `scenario` against a fresh directory for each writer and return both outcomes. */
async function both(
  setup: (base: string) => void,
  write: (base: string) => { file: string; data: string | Uint8Array; mode?: number },
  after?: (base: string) => void,
): Promise<{ local: Outcome; kit: Outcome }> {
  const run = async (name: 'local' | 'kit'): Promise<Outcome> => {
    const base = path.join(dir, name)
    fs.mkdirSync(base)
    setup(base)
    const { file, data, mode } = write(base)
    let error: string | null = null
    try {
      if (name === 'local') atomicWriteFile(file, data, mode)
      else await kit.writeAtomic(file, data, mode === undefined ? {} : { mode })
    } catch (err) {
      error = (err as NodeJS.ErrnoException).code ?? 'error'
    }
    after?.(base)
    return { error, files: snapshot(base) }
  }
  return { local: await run('local'), kit: await run('kit') }
}

describe('atomicWriteFile behaves as kit.writeAtomic', () => {
  it('a new file with a mode: same bytes, same mode, no temp file', async () => {
    const r = await both(() => {}, (b) => ({ file: path.join(b, 'credentials.json'), data: '{"a":1}\n', mode: 0o600 }))
    expect(r.local).toEqual(r.kit)
    expect(r.local.error).toBeNull()
    expect(Object.keys(r.local.files)).toEqual(['credentials.json'])
  })

  it.skipIf(!posix)('a mode the umask would narrow is set exactly, whatever the umask', async () => {
    const previous = process.umask(0o077)
    try {
      const r = await both(() => {}, (b) => ({ file: path.join(b, 'SKILL.md'), data: 'manual', mode: 0o664 }))
      expect(r.local).toEqual(r.kit)
      expect(r.local.files['SKILL.md']).toMatchObject({ mode: 0o664 })
    } finally {
      process.umask(previous)
    }
  })

  it('a new file without a mode: the umask’s default, as a plain write', async () => {
    const r = await both(() => {}, (b) => ({ file: path.join(b, 'status.json'), data: 'x' }))
    expect(r.local).toEqual(r.kit)
  })

  it('an existing file is replaced, and its mode is set exactly', async () => {
    const r = await both(
      (b) => {
        fs.writeFileSync(path.join(b, 'unit.service'), 'old\n')
        if (posix) fs.chmodSync(path.join(b, 'unit.service'), 0o644)
      },
      (b) => ({ file: path.join(b, 'unit.service'), data: 'new\n', mode: 0o600 }),
    )
    expect(r.local).toEqual(r.kit)
    expect(r.local.files['unit.service']).toMatchObject({ bytes: Buffer.from('new\n').toString('hex') })
  })

  it('bytes are written as given', async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255])
    const r = await both(() => {}, (b) => ({ file: path.join(b, 'blob.bin'), data: bytes, mode: 0o600 }))
    expect(r.local).toEqual(r.kit)
  })

  it('a missing directory is created owner-only (0700)', async () => {
    const r = await both(() => {}, (b) => ({ file: path.join(b, 'deep', 'nest', 'file.json'), data: '{}', mode: 0o600 }))
    expect(r.local).toEqual(r.kit)
  })

  it.skipIf(!posix || root)('a directory that cannot be written: both refuse, the old file untouched, no temp file', async () => {
    const r = await both(
      (b) => {
        fs.writeFileSync(path.join(b, 'keep.json'), 'old')
        fs.chmodSync(b, 0o500)
      },
      (b) => ({ file: path.join(b, 'keep.json'), data: 'new', mode: 0o600 }),
      (b) => fs.chmodSync(b, 0o700),
    )
    expect(r.local).toEqual(r.kit)
    expect(r.local.error).toBe('EACCES')
    expect(r.local.files['keep.json']).toMatchObject({ bytes: Buffer.from('old').toString('hex') })
  })

  it('a directory where the file should be: both refuse, and leave no temp file', async () => {
    const r = await both((b) => fs.mkdirSync(path.join(b, 'taken')), (b) => ({ file: path.join(b, 'taken'), data: 'x', mode: 0o600 }))
    expect(r.local.error).not.toBeNull()
    expect(r.kit.error).not.toBeNull()
    expect(r.local.files).toEqual(r.kit.files)
  })

  it('a rename that fails once with EBUSY ends the same way (retried on Windows, not elsewhere)', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    const busy = () => Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' })
    const localFile = path.join(dir, 'local.json')
    const kitFile = path.join(dir, 'kit.json')
    let localError: string | null = null
    let kitError: string | null = null
    let first = true
    vi.mocked(fs.renameSync).mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (first) {
        first = false
        throw busy()
      }
      actual.renameSync(from, to)
    }) as typeof fs.renameSync)
    try {
      atomicWriteFile(localFile, 'x', 0o600)
    } catch (err) {
      localError = (err as NodeJS.ErrnoException).code ?? 'error'
    }
    let kitFirst = true
    try {
      await kit.writeAtomic(kitFile, 'x', {
        mode: 0o600,
        rename: async (from: string, to: string) => {
          if (kitFirst) {
            kitFirst = false
            throw busy()
          }
          await fs.promises.rename(from, to)
        },
      })
    } catch (err) {
      kitError = (err as NodeJS.ErrnoException).code ?? 'error'
    }
    expect(localError).toBe(kitError)
    expect(localError).toBe(process.platform === 'win32' ? null : 'EBUSY')
    expect(fs.existsSync(localFile)).toBe(fs.existsSync(kitFile))
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('the temp file has the same shape beside the target: .<name>.<12 hex>.tmp', async () => {
    const target = path.join(dir, 'texts.json')
    const names: string[] = []
    vi.mocked(fs.renameSync).mockImplementationOnce(((from: fs.PathLike) => {
      names.push(path.basename(String(from)))
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }) as typeof fs.renameSync)
    expect(() => atomicWriteFile(target, 'x')).toThrow()
    await expect(
      kit.writeAtomic(target, 'x', {
        rename: async (from: string) => {
          names.push(path.basename(from))
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        },
      }),
    ).rejects.toThrow()
    expect(names).toHaveLength(2)
    for (const name of names) expect(name).toMatch(/^\.texts\.json\.[0-9a-f]{12}\.tmp$/)
    expect(fs.readdirSync(dir)).toEqual([])
  })
})

describe('renameWithRetry behaves as kit.renameWithRetry', () => {
  /** A rename that fails with each code in `codes` in turn, then succeeds. */
  function scripted(codes: readonly (string | undefined)[]): { attempts: () => number; next: () => void } {
    let n = 0
    return {
      attempts: () => n,
      next: () => {
        const code = codes[n++]
        if (n <= codes.length) throw Object.assign(new Error(code ?? 'no code'), code === undefined ? {} : { code })
      },
    }
  }

  async function outcome(codes: readonly (string | undefined)[], retry: boolean | undefined) {
    const local = scripted(codes)
    let localError: string | null = null
    try {
      renameWithRetry('a', 'b', { rename: local.next, delayMs: 0, ...(retry === undefined ? {} : { retry }) })
    } catch (err) {
      localError = (err as Error).message
    }
    const kitRun = scripted(codes)
    let kitError: string | null = null
    try {
      await kit.renameWithRetry('a', 'b', { rename: async () => kitRun.next(), ...(retry === undefined ? {} : { retry }) })
    } catch (err) {
      kitError = (err as Error).message
    }
    return { local: { attempts: local.attempts(), error: localError }, kit: { attempts: kitRun.attempts(), error: kitError } }
  }

  const cases: Array<[string, readonly (string | undefined)[], boolean | undefined]> = [
    ['EBUSY, EPERM, EACCES, then success (Windows retry)', ['EBUSY', 'EPERM', 'EACCES'], true],
    ['five transient failures, then success: the sixth attempt lands', ['EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EBUSY'], true],
    ['six transient failures: gives up with the last error', ['EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EBUSY'], true],
    ['a non-transient error is not retried', ['ENOENT'], true],
    ['an error with no code is not retried', [undefined], true],
    ['retry off: one attempt', ['EBUSY'], false],
    ['the platform default (retry on Windows only)', ['EPERM', 'EPERM'], undefined],
  ]
  for (const [name, codes, retry] of cases) {
    it(name, async () => {
      const r = await outcome(codes, retry)
      expect(r.local).toEqual(r.kit)
    })
  }
})
