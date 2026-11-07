import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { atomicCopyFile, atomicWriteFile, renameWithRetry } from '../src/util/fsutil.js'

// ─── Atomic replacement cannot be redirected, and rides out Windows locks ───
//
// The tmp file used to be `.<name>.<pid>.tmp`: a name anyone with write access
// to the directory could predict and prepare as a symlink, which the write
// then followed. It is now random, created exclusively (`wx`), and its mode is
// set on the descriptor.

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-fsutil-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const posix = process.platform !== 'win32'

describe('atomicWriteFile', () => {
  it.skipIf(!posix)('a symlink planted at the old predictable tmp name is not followed: the victim is untouched', () => {
    const target = path.join(dir, 'SKILL.md')
    const victim = path.join(dir, 'victim.txt')
    fs.writeFileSync(victim, 'precious\n')
    fs.symlinkSync(victim, path.join(dir, `.SKILL.md.${process.pid}.tmp`))
    atomicWriteFile(target, 'the manual\n', 0o644)
    expect(fs.readFileSync(victim, 'utf-8')).toBe('precious\n')
    expect(fs.readFileSync(target, 'utf-8')).toBe('the manual\n')
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(false)
    // Nothing of ours left behind; the planted link is not ours to remove.
    expect(fs.readdirSync(dir).sort()).toEqual([`.SKILL.md.${process.pid}.tmp`, 'SKILL.md', 'victim.txt'].sort())
  })

  it.skipIf(!posix)('a symlink planted at the target itself is replaced, not written through', () => {
    const target = path.join(dir, 'credentials')
    const victim = path.join(dir, 'victim.txt')
    fs.writeFileSync(victim, 'precious\n')
    fs.symlinkSync(victim, target)
    atomicWriteFile(target, '{}\n', 0o600)
    expect(fs.readFileSync(victim, 'utf-8')).toBe('precious\n')
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(false)
  })

  it.skipIf(!posix)('the mode is exact whatever the umask, set on the descriptor', () => {
    const file = path.join(dir, 'f')
    const old = process.umask(0o077)
    try {
      atomicWriteFile(file, 'x', 0o644)
    } finally {
      process.umask(old)
    }
    expect(fs.statSync(file).mode & 0o777).toBe(0o644)
  })

  it('writes bytes exactly, and two writes in a row leave no tmp file', () => {
    const file = path.join(dir, 'bin')
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x0d, 0x0a, 0x00, 0xff])
    atomicWriteFile(file, bytes, 0o600)
    atomicWriteFile(file, bytes, 0o600)
    expect(Buffer.compare(fs.readFileSync(file), Buffer.from(bytes))).toBe(0)
    expect(fs.readdirSync(dir)).toEqual(['bin'])
  })
})

describe('atomicCopyFile', () => {
  it.skipIf(!posix)('the same: a planted predictable tmp symlink is not followed', () => {
    const source = path.join(dir, 'daemon.src')
    const target = path.join(dir, 'daemon.mjs')
    const victim = path.join(dir, 'victim.txt')
    fs.writeFileSync(source, '// daemon\n')
    fs.writeFileSync(victim, 'precious\n')
    fs.symlinkSync(victim, path.join(dir, `.daemon.mjs.${process.pid}.tmp`))
    atomicCopyFile(source, target, 0o755)
    expect(fs.readFileSync(victim, 'utf-8')).toBe('precious\n')
    expect(fs.readFileSync(target, 'utf-8')).toBe('// daemon\n')
    expect(fs.statSync(target).mode & 0o777).toBe(0o755)
  })
})

describe('renameWithRetry (Windows: a file held open by a scanner or an editor)', () => {
  const failing = (codes: string[]): { calls: number; rename: (a: string, b: string) => void } => {
    const state = { calls: 0, rename: (_a: string, _b: string): void => undefined }
    state.rename = () => {
      const code = codes[state.calls]
      state.calls += 1
      if (code !== undefined) throw Object.assign(new Error(`${code}: operation not permitted, rename`), { code })
    }
    return state
  }

  it('retries a transient EPERM / EBUSY / EACCES and succeeds', () => {
    const r = failing(['EPERM', 'EBUSY', 'EACCES'])
    renameWithRetry('a', 'b', { rename: r.rename, retry: true, delayMs: 1 })
    expect(r.calls).toBe(4)
  })

  it('gives up after its attempts (~100 ms by default) with the last error', () => {
    const r = failing(Array(20).fill('EBUSY'))
    expect(() => renameWithRetry('a', 'b', { rename: r.rename, retry: true, delayMs: 1 })).toThrow(/EBUSY/)
    expect(r.calls).toBe(6)
  })

  it('does not retry an error that is not transient', () => {
    const r = failing(['ENOENT'])
    expect(() => renameWithRetry('a', 'b', { rename: r.rename, retry: true, delayMs: 1 })).toThrow(/ENOENT/)
    expect(r.calls).toBe(1)
  })

  it('retries only on Windows unless asked', () => {
    const r = failing(['EPERM'])
    if (process.platform === 'win32') {
      renameWithRetry('a', 'b', { rename: r.rename, delayMs: 1 })
      expect(r.calls).toBe(2)
    } else {
      expect(() => renameWithRetry('a', 'b', { rename: r.rename, delayMs: 1 })).toThrow(/EPERM/)
      expect(r.calls).toBe(1)
    }
  })
})
