import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  installService,
  launchdPlist,
  parseServiceHome,
  planForTest,
  serviceLabelFor,
  serviceStatus,
  setServiceCommandRunnerForTests,
  setServiceHostOsForTests,
  systemdUnit,
  uninstallService,
  type ServiceCommandRunner,
} from '../src/daemon/service.js'

// ─── One service label per identity home; never touch another home's job ────
//
// Live-fire E5: the label was global per integration while the unit file
// followed HOME and the identity home followed CLAUDE_CONFIG_DIR / CODEX_HOME.
// In a sandbox, `daemon status` reported the machine's real service as
// loaded, and `uninstall` there would have `launchctl remove`d it.
//
// Every test here runs with AGENTCHAT_SERVICE_DRY_RUN=1 and a temp HOME. The
// few that exercise the loaded-job guard answer launchctl/systemctl with a
// FAKE runner; the real service manager is never reached.

const BASE = 'agentchatd-testkit'
const posixServiceOs = process.platform === 'darwin' || process.platform === 'linux'

let tmp: string
let saved: { HOME?: string; USERPROFILE?: string; DRY?: string }

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-service-'))
  saved = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'], DRY: process.env['AGENTCHAT_SERVICE_DRY_RUN'] }
  process.env['HOME'] = path.join(tmp, 'home')
  process.env['USERPROFILE'] = path.join(tmp, 'home')
  process.env['AGENTCHAT_SERVICE_DRY_RUN'] = '1'
  fs.mkdirSync(path.join(tmp, 'home'), { recursive: true })
})

afterEach(() => {
  setServiceCommandRunnerForTests(null)
  setServiceHostOsForTests(null)
  delete process.env['AGENTCHATD_SERVICE_NO_START']
  delete process.env['WSL_DISTRO_NAME']
  for (const [k, v] of [['HOME', saved.HOME], ['USERPROFILE', saved.USERPROFILE], ['AGENTCHAT_SERVICE_DRY_RUN', saved.DRY]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** The definition file a label writes on this platform. */
function definitionPath(label: string): string {
  return process.platform === 'darwin'
    ? path.join(tmp, 'home', 'Library', 'LaunchAgents', `me.agentchat.${label}.plist`)
    : path.join(tmp, 'home', '.config', 'systemd', 'user', `${label}.service`)
}

function definitionFor(label: string, home: string): string {
  const p = planForTest({ label, home, entry: path.join(home, 'bin', 'daemon.mjs') })
  return process.platform === 'darwin' ? launchdPlist(p) : systemdUnit(p)
}

function writeDefinition(label: string, home: string): string {
  const file = definitionPath(label)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, definitionFor(label, home))
  return file
}

/** A fake service manager that reports one loaded job serving `servedHome`, and records every call. */
function fakeManager(label: string, servedHome: string): { calls: string[]; runner: ServiceCommandRunner } {
  const calls: string[] = []
  const unitFile = path.join(tmp, 'loaded-elsewhere.service')
  fs.writeFileSync(unitFile, definitionFor(label, servedHome))
  const runner: ServiceCommandRunner = (cmd, args) => {
    calls.push(`${cmd} ${args.join(' ')}`)
    if (cmd === 'launchctl' && args[0] === 'print') {
      return {
        ok: true,
        out: [
          `gui/501/me.agentchat.${label} = {`,
          '\tactive count = 1',
          `\tpath = /Users/someone/Library/LaunchAgents/me.agentchat.${label}.plist`,
          '\tstate = running',
          '\targuments = {',
          '\t\t/usr/local/bin/node',
          `\t\t${servedHome}/bin/agentchat-daemon.mjs`,
          '\t\t--home',
          `\t\t${servedHome}`,
          '\t}',
          '}',
        ].join('\n'),
      }
    }
    if (cmd === 'systemctl' && args.includes('show')) return { ok: true, out: `LoadState=loaded\nFragmentPath=${unitFile}` }
    return { ok: true, out: '' }
  }
  return { calls, runner }
}

describe('serviceLabelFor', () => {
  it('the default identity home keeps the plain label, so existing installs keep working', () => {
    expect(serviceLabelFor(BASE, '/u/.claude/agentchat', '/u/.claude/agentchat')).toBe(BASE)
    expect(serviceLabelFor(BASE, '/u/.claude/./agentchat/', '/u/.claude/agentchat')).toBe(BASE)
  })

  it('a relocated identity home gets a short stable hash suffix, distinct per home', () => {
    const a = serviceLabelFor(BASE, '/tmp/sandbox-a/agentchat', '/u/.claude/agentchat')
    const b = serviceLabelFor(BASE, '/tmp/sandbox-b/agentchat', '/u/.claude/agentchat')
    expect(a).toMatch(new RegExp(`^${BASE}-[0-9a-f]{8}$`))
    expect(b).toMatch(new RegExp(`^${BASE}-[0-9a-f]{8}$`))
    expect(a).not.toBe(b)
    expect(serviceLabelFor(BASE, '/tmp/sandbox-a/agentchat', '/u/.claude/agentchat')).toBe(a) // stable
  })
})

describe('parseServiceHome', () => {
  const home = '/Users/a b/odd $dir %x/"q"/agentchat'

  it('reads --home from a plist this module writes', () => {
    const p = planForTest({ label: BASE, home, entry: '/x/daemon.mjs' })
    expect(parseServiceHome(launchdPlist(p), 'plist')).toBe(path.resolve(home))
  })

  it('reads --home from a systemd unit this module writes (quotes, $, % escaped)', () => {
    const p = planForTest({ label: BASE, home, entry: '/x/daemon.mjs' })
    expect(parseServiceHome(systemdUnit(p), 'systemd')).toBe(path.resolve(home))
  })

  it('reads --home from `launchctl print` and `launchctl list <label>` output', () => {
    const printed = ['gui/501/me.agentchat.x = {', '\targuments = {', '\t\t/n/node', '\t\t/h/bin/d.mjs', '\t\t--home', '\t\t/Users/s/.claude/agentchat', '\t}', '}'].join('\n')
    expect(parseServiceHome(printed, 'launchctl')).toBe('/Users/s/.claude/agentchat')
    const listed = ['{', '\t"ProgramArguments" = (', '\t\t"/n/node";', '\t\t"/h/bin/d.mjs";', '\t\t"--home";', '\t\t"/Users/s/.codex/agentchat";', '\t);', '};'].join('\n')
    expect(parseServiceHome(listed, 'launchctl')).toBe('/Users/s/.codex/agentchat')
  })

  it('null when there is no --home', () => {
    expect(parseServiceHome('<plist><dict></dict></plist>', 'plist')).toBeNull()
    expect(parseServiceHome('[Service]\nExecStart=/bin/true', 'systemd')).toBeNull()
  })
})

describe.skipIf(!posixServiceOs)('the ownership guard', () => {
  const ours = (): string => path.join(tmp, 'config', 'agentchat')
  const theirs = '/Users/someone/.claude/agentchat'

  it('uninstall refuses a definition at this label that serves another home, and leaves it in place', () => {
    const file = writeDefinition(BASE, theirs)
    expect(() => uninstallService({ label: BASE, home: ours() })).toThrow(/refusing to remove .* serves \/Users\/someone\/\.claude\/agentchat, not this config/)
    expect(fs.existsSync(file)).toBe(true)
  })

  it('uninstall removes a definition that serves this home', () => {
    const file = writeDefinition(BASE, ours())
    uninstallService({ label: BASE, home: ours() })
    expect(fs.existsSync(file)).toBe(false)
  })

  it('install refuses to overwrite another home’s definition', () => {
    const file = writeDefinition(BASE, theirs)
    const before = fs.readFileSync(file, 'utf-8')
    expect(() => installService({ label: BASE, home: ours(), entry: path.join(ours(), 'bin', 'd.mjs') })).toThrow(/refusing to replace/)
    expect(fs.readFileSync(file, 'utf-8')).toBe(before)
  })

  it('a LOADED job under this label that serves another home is refused before anything is stopped (fake service manager)', () => {
    // The live-fire shape: a sandbox HOME, the plain label, and the machine's
    // real job loaded under it. Nothing on disk in the sandbox.
    const fake = fakeManager(BASE, theirs)
    setServiceCommandRunnerForTests(fake.runner)
    delete process.env['AGENTCHAT_SERVICE_DRY_RUN'] // safe: every command goes to the fake
    expect(() => uninstallService({ label: BASE, home: ours() })).toThrow(/refusing to remove the loaded (launchd job|systemd unit)/)
    expect(() => installService({ label: BASE, home: ours(), entry: path.join(ours(), 'bin', 'd.mjs') })).toThrow(/refusing to replace/)
    // Only reads reached the manager: no unload, remove, disable, load, enable.
    expect(fake.calls.length).toBeGreaterThan(0)
    for (const call of fake.calls) expect(call).toMatch(/^(launchctl print|launchctl list|systemctl --user show)/)
    expect(fs.existsSync(definitionPath(BASE))).toBe(false)
  })

  it('status says the loaded job is another config’s instead of calling it ours (fake service manager)', () => {
    const fake = fakeManager(BASE, theirs)
    setServiceCommandRunnerForTests(fake.runner)
    delete process.env['AGENTCHAT_SERVICE_DRY_RUN']
    expect(serviceStatus({ label: BASE, home: ours() })).toContain(`but it serves ${theirs}, not this config`)
  })

  it('under AGENTCHAT_SERVICE_DRY_RUN status does not query the service manager at all', () => {
    setServiceCommandRunnerForTests(() => {
      throw new Error('the service manager was queried under dry run')
    })
    expect(serviceStatus({ label: BASE, home: ours() })).toMatch(/not queried \(AGENTCHAT_SERVICE_DRY_RUN\) — definition not written/)
    writeDefinition(BASE, ours())
    expect(serviceStatus({ label: BASE, home: ours() })).toContain('definition written at')
  })

  it('install retires a superseded plain-label definition that serves THIS home, and leaves another home’s alone', () => {
    const relocated = serviceLabelFor(BASE, ours(), path.join(tmp, 'home', '.claude', 'agentchat'))
    const legacy = writeDefinition(BASE, ours())
    installService({ label: relocated, home: ours(), entry: path.join(ours(), 'bin', 'd.mjs'), supersedes: [BASE] })
    expect(fs.existsSync(legacy)).toBe(false)
    expect(fs.existsSync(definitionPath(relocated))).toBe(true)

    const foreign = writeDefinition(BASE, theirs)
    installService({ label: relocated, home: ours(), entry: path.join(ours(), 'bin', 'd.mjs'), supersedes: [BASE] })
    expect(fs.existsSync(foreign)).toBe(true)
  })
})


// ─── An upgrade restarts the running daemon ─────────────────────────────────
//
// This release changes the daemon, so every upgrade hits this. `systemctl
// --user enable --now` leaves an already-running unit on the OLD bundle until
// the next boot, and a second Windows Startup launcher starts a second daemon
// that loses the leader lock and loops. Pinned here as command sequences
// against a fake service manager, on any CI runner (platform seam).

describe('install (re)starts the daemon it just wrote', () => {
  /** Records every command; answers nothing loaded (an upgrade from a unit that serves this home, or a fresh install). */
  function recorder(answers: Record<string, string> = {}): { calls: string[]; runner: ServiceCommandRunner } {
    const calls: string[] = []
    const runner: ServiceCommandRunner = (cmd, args) => {
      const line = `${cmd} ${args.join(' ')}`
      calls.push(line)
      for (const [prefix, out] of Object.entries(answers)) if (line.startsWith(prefix)) return { ok: true, out }
      return { ok: true, out: '' }
    }
    return { calls, runner }
  }
  const home = (): string => path.join(tmp, 'home', '.example', 'agentchat')
  const entry = (): string => path.join(home(), 'bin', 'd.mjs')

  it('Linux: enables the unit, then RESTARTS it — never `enable --now`, which keeps a running unit on the old bundle', () => {
    setServiceHostOsForTests('linux')
    const fake = recorder()
    setServiceCommandRunnerForTests(fake.runner)
    delete process.env['AGENTCHAT_SERVICE_DRY_RUN']
    installService({ label: BASE, home: home(), entry: entry() })
    const systemctl = fake.calls.filter((c) => c.startsWith('systemctl'))
    expect(systemctl.at(-2)).toBe(`systemctl --user enable ${BASE}`)
    expect(systemctl.at(-1)).toBe(`systemctl --user restart ${BASE}`)
    expect(fake.calls.some((c) => c.includes('enable --now'))).toBe(false)
    expect(fake.calls.indexOf('systemctl --user daemon-reload')).toBeLessThan(fake.calls.indexOf(`systemctl --user enable ${BASE}`))
    expect(fs.existsSync(path.join(tmp, 'home', '.config', 'systemd', 'user', `${BASE}.service`))).toBe(true)
  })

  it('Windows: stops the running launcher and the daemon in the leader lock BEFORE the new launcher starts', () => {
    setServiceHostOsForTests('win32')
    process.env['AGENTCHATD_SERVICE_NO_START'] = '1' // never spawn wscript from a test
    const fake = recorder()
    setServiceCommandRunnerForTests(fake.runner)
    delete process.env['AGENTCHAT_SERVICE_DRY_RUN']
    fs.mkdirSync(home(), { recursive: true })
    // The leader lock as a daemon writes it (a lease: the bare pid first, then its JSON).
    fs.writeFileSync(path.join(home(), 'daemon.lock'), `4242\n${JSON.stringify({ pid: 4242, token: 't', host: 'h', renewed_at: Date.now() })}\n`)
    installService({ label: BASE, home: home(), entry: entry() })
    const launcherKill = fake.calls.findIndex((c) => c.startsWith('powershell ') && c.includes(`${BASE}.vbs`) && c.includes('Stop-Process'))
    const daemonKill = fake.calls.indexOf('taskkill /PID 4242 /T /F')
    expect(launcherKill).toBeGreaterThanOrEqual(0)
    expect(daemonKill).toBeGreaterThan(launcherKill)
    expect(fs.existsSync(path.join(tmp, 'home', 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${BASE}.vbs`))).toBe(true)
  })

  it('Windows, fresh install (no leader lock): stops no daemon', () => {
    setServiceHostOsForTests('win32')
    process.env['AGENTCHATD_SERVICE_NO_START'] = '1'
    const fake = recorder()
    setServiceCommandRunnerForTests(fake.runner)
    delete process.env['AGENTCHAT_SERVICE_DRY_RUN']
    installService({ label: BASE, home: home(), entry: entry() })
    expect(fake.calls.some((c) => c.startsWith('taskkill'))).toBe(false)
  })

  it('WSL: the same, with the daemon in the leader lock signalled from the Linux side', () => {
    setServiceHostOsForTests('wsl')
    process.env['AGENTCHATD_SERVICE_NO_START'] = '1'
    process.env['WSL_DISTRO_NAME'] = 'Ubuntu'
    const startup = path.join(tmp, 'mnt-appdata')
    const fake = recorder({ 'cmd.exe /c echo %APPDATA%': 'C:\\Users\\me\\AppData\\Roaming\r\n', 'wslpath -u': `${startup}\n` })
    setServiceCommandRunnerForTests(fake.runner)
    delete process.env['AGENTCHAT_SERVICE_DRY_RUN']
    fs.mkdirSync(home(), { recursive: true })
    fs.writeFileSync(path.join(home(), 'daemon.lock'), `777\n${JSON.stringify({ pid: 777, token: 't', host: 'h', renewed_at: Date.now() })}\n`)
    installService({ label: BASE, home: home(), entry: entry() })
    const launcherKill = fake.calls.findIndex((c) => c.startsWith('powershell.exe ') && c.includes('Stop-Process'))
    const daemonKill = fake.calls.indexOf('kill -TERM 777')
    expect(launcherKill).toBeGreaterThanOrEqual(0)
    expect(daemonKill).toBeGreaterThan(launcherKill)
    expect(fs.existsSync(path.join(startup, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${BASE}.vbs`))).toBe(true)
  })
})
