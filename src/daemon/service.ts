import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync, spawn } from 'node:child_process'
import { log } from '../util/log.js'
import { atomicWriteFile } from '../util/fsutil.js'

// ─── Service lifecycle (systemd / launchd / Windows Startup) ─────────────────
//
// `agentchatd start` only runs while the shell is open — no good for a 24/7
// consumer product. `install` registers the daemon as a real background
// service that starts on boot/login and restarts on crash:
//   * Linux (native) → a systemd USER unit + `loginctl enable-linger`.
//   * macOS          → a launchd LaunchAgent with KeepAlive + RunAtLoad.
//   * Windows / WSL2 → a hidden, restart-on-exit VBScript in the user's Startup
//                      folder (no admin). See the Windows section below.
// One service per INTEGRATION (the leader lock already enforces one daemon per
// identity on a box). The caller supplies the label and the env to capture —
// this module has no idea which coding agents exist, which is what keeps two
// integrations' services from ever colliding on a name or clobbering each
// other's unit file. Convention is `agentchatd-<integration>`.

/**
 * Enough to ADDRESS an already-installed service. Removing one or reading its
 * status needs only its name — deliberately a narrower type than install, so
 * `uninstall` and `status` cannot be made to depend on a daemon entry they have
 * no use for.
 */
export interface ServiceRef {
  /** Unit/service name, e.g. `agentchatd-codex`. Must be unique per integration. */
  label: string
  home: string
}

export interface ServiceOpts extends ServiceRef {
  /**
   * Absolute path to the integration's DAEMON bundle — the script this service
   * runs. Required, and deliberately not defaulted.
   *
   * It used to default to `process.argv[1]`, i.e. whichever binary happened to
   * call `install`. That was the CLI, which has no daemon in it, so every
   * installed unit ran a command that exited 1 and then restart-looped forever
   * under `KeepAlive`/`Restart=on-failure` while the CLI cheerfully reported
   * "Always-on is ON". Making the caller name the entry is what stops a service
   * from being installed against a script that cannot serve it.
   *
   * Must also be a STABLE path. A plugin's own bundle lives in a
   * version-scoped cache directory that the next upgrade deletes, so an
   * integration distributed that way copies itself somewhere durable first and
   * passes that copy here.
   */
  entry: string
  /** Host-specific env the service must see because a systemd/launchd service
   *  does NOT inherit the login shell (e.g. CODEX_HOME). PATH is captured
   *  automatically. */
  env?: Record<string, string>
}

export interface Plan {
  label: string // service/unit name
  node: string // absolute node path
  bin: string // absolute daemon entry, supplied by the integration
  home: string
  /** Host env captured from the current shell so the service sees the same
   *  CODEX_HOME / CLAUDE_CONFIG_DIR the user installed under. */
  env: Record<string, string>
}

export function planForTest(opts: ServiceOpts): Plan {
  return plan(opts)
}

function serviceValue(name: string, value: string): string {
  // Every supported service format is line-oriented; CR/LF/NUL would either
  // make an invalid definition or inject a new directive/script statement.
  if (/[\0\r\n]/.test(value)) {
    throw new Error(`invalid control character in service ${name}`)
  }
  return value
}

function serviceLabel(value: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`invalid service label: ${value}`)
  }
  return value
}

function plan(opts: ServiceOpts): Plan {
  const env: Record<string, string> = {}
  // CRITICAL: a systemd/launchd service does NOT inherit the login shell's
  // PATH, so it can't find `claude` / `codex` / `npx` (often in ~/.local/bin
  // or a version-manager dir). Capture the installer's PATH so the service
  // resolves the same binaries the user does. (Without this the daemon exits
  // "claude CLI not found on PATH" and restart-loops.)
  if (process.env['PATH']) env['PATH'] = serviceValue('environment value', process.env['PATH'])
  // Whatever host env the integration says its adapter needs.
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`invalid service environment key: ${k}`)
    if (typeof v === 'string' && v.length > 0) env[k] = serviceValue('environment value', v)
  }
  return {
    label: serviceLabel(opts.label),
    node: serviceValue('Node path', process.execPath),
    bin: serviceValue('entry path', path.resolve(opts.entry)),
    home: serviceValue('home path', path.resolve(opts.home)),
    env,
  }
}

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf-8' })
  const out = [
    typeof r.stdout === 'string' ? r.stdout : '',
    typeof r.stderr === 'string' ? r.stderr : '',
    r.error?.message ?? '',
  ]
    .filter((part) => part.length > 0)
    .join('\n')
    .trim()
  return {
    ok: !r.error && r.status === 0,
    out,
  }
}

/**
 * Write the unit file but do NOT hand it to the OS service manager.
 *
 * `HOME` sandboxes where the unit file lands, but it does not sandbox
 * `launchctl` or `systemctl` — those always address the real user's domain. So
 * a test that exercises `daemon install` registers a REAL service on the
 * developer's machine, pointed at a temp directory that is about to be deleted.
 * That happened, and it left two loaded launchd jobs behind.
 *
 * With this set, everything up to registration still runs and can be asserted
 * on; only the escaping side effect is skipped.
 */
function registrationSkipped(): boolean {
  const v = process.env['AGENTCHAT_SERVICE_DRY_RUN']
  return v !== undefined && v !== '' && v !== '0'
}

// ─── systemd (Linux) ─────────────────────────────────────────────────────────

function systemdUnitPath(label: string): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', `${label}.service`)
}

/** Quote one systemd command/environment word, including specifier escaping. */
export function systemdQuote(value: string): string {
  return (
    '"' +
    value
      .replace(/\\/g, '\\\\')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      .replace(/"/g, '\\"')
      // In a JS replacement string `$$` emits one literal dollar, so four
      // dollars are required to produce systemd's literal-dollar escape `$$`.
      .replace(/\$/g, '$$$$')
      .replace(/%/g, '%%') +
    '"'
  )
}

export function systemdUnit(p: Plan): string {
  const envLines = Object.entries(p.env)
    .map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}`)
    .join('\n')
  return [
    '[Unit]',
    `Description=AgentChat always-on daemon (${p.label})`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${systemdQuote(p.node)} ${systemdQuote(p.bin)} --home ${systemdQuote(p.home)}`,
    ...(envLines ? [envLines] : []),
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

function installSystemd(p: Plan): void {
  const unitPath = systemdUnitPath(p.label)
  fs.mkdirSync(path.dirname(unitPath), { recursive: true })
  atomicWriteFile(unitPath, systemdUnit(p), 0o600)
  log.info(`wrote ${unitPath}`)
  if (registrationSkipped()) return
  run('systemctl', ['--user', 'daemon-reload'])
  // enable-linger keeps user services running with no active login (VPS).
  const linger = run('loginctl', ['enable-linger', os.userInfo().username])
  if (!linger.ok) {
    log.warn(`could not enable-linger (service won't survive logout until you run: sudo loginctl enable-linger ${os.userInfo().username})`)
  }
  const enabled = run('systemctl', ['--user', 'enable', '--now', p.label])
  if (!enabled.ok) throw new Error(`systemctl enable failed: ${enabled.out}`)
  log.info(`service ${p.label} enabled + started`)
}

function uninstallSystemd(label: string): void {
  if (!registrationSkipped()) {
    const disabled = run('systemctl', ['--user', 'disable', '--now', label])
    if (!disabled.ok) {
      const active = run('systemctl', ['--user', 'is-active', label])
      const state = (active.out.split(/\r?\n/, 1)[0] ?? '').trim().toLowerCase()
      // systemctl intentionally exits non-zero for these stopped/not-present
      // states. Anything else is ambiguous, so preserve the unit and daemon
      // bundle rather than stranding a loaded restart policy.
      if (!['inactive', 'failed', 'unknown'].includes(state)) {
        throw new Error(
          `could not stop systemd service ${label}: ${disabled.out || active.out || 'unknown error'}`,
        )
      }
    }
  }
  const unitPath = systemdUnitPath(label)
  if (fs.existsSync(unitPath)) fs.rmSync(unitPath)
  if (!registrationSkipped()) {
    const reload = run('systemctl', ['--user', 'daemon-reload'])
    if (!reload.ok) log.warn(`systemctl daemon-reload failed after uninstall: ${reload.out}`)
  }
  log.info(`service ${label} removed`)
}

function statusSystemd(label: string): string {
  const active = run('systemctl', ['--user', 'is-active', label]).out || 'unknown'
  const enabled = run('systemctl', ['--user', 'is-enabled', label]).out || 'unknown'
  return `systemd ${label}: ${active} (${enabled})`
}

// ─── launchd (macOS) ─────────────────────────────────────────────────────────

function launchdPlistPath(label: string): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${launchdLabel(label)}.plist`)
}
const launchdLabel = (label: string): string => `me.agentchat.${label}`

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function launchdPlist(p: Plan): string {
  const args = [p.node, p.bin, '--home', p.home]
  const argXml = args.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n')
  const envXml = Object.entries(p.env)
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key><string>${xmlEscape(v)}</string>`)
    .join('\n')
  const logPath = path.join(p.home, 'daemon.log')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `  <key>Label</key><string>${xmlEscape(launchdLabel(p.label))}</string>`,
    '  <key>ProgramArguments</key><array>',
    argXml,
    '  </array>',
    ...(envXml ? ['  <key>EnvironmentVariables</key><dict>', envXml, '  </dict>'] : []),
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    `  <key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>`,
    `  <key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>`,
    '</dict></plist>',
    '',
  ].join('\n')
}

function installLaunchd(p: Plan): void {
  const plistPath = launchdPlistPath(p.label)
  fs.mkdirSync(path.dirname(plistPath), { recursive: true })
  atomicWriteFile(plistPath, launchdPlist(p), 0o600)
  log.info(`wrote ${plistPath}`)
  if (registrationSkipped()) return
  run('launchctl', ['unload', plistPath]) // idempotent: clear a prior load
  const loaded = run('launchctl', ['load', '-w', plistPath])
  if (!loaded.ok) throw new Error(`launchctl load failed: ${loaded.out}`)
  log.info(`service ${launchdLabel(p.label)} loaded + started`)
}

function uninstallLaunchd(label: string): void {
  const plistPath = launchdPlistPath(label)
  if (!registrationSkipped()) {
    run('launchctl', ['unload', '-w', plistPath])
    let loaded = run('launchctl', ['list', launchdLabel(label)])
    if (loaded.ok) {
      // A missing/stale plist can leave a loaded job that unload-by-path
      // cannot address. Remove by label, then prove it is gone.
      run('launchctl', ['remove', launchdLabel(label)])
      loaded = run('launchctl', ['list', launchdLabel(label)])
    }
    if (loaded.ok) {
      throw new Error(`could not stop launchd service ${launchdLabel(label)}`)
    }
    if (
      loaded.out &&
      !/could not find service|not found|no such process|unknown service/i.test(loaded.out)
    ) {
      throw new Error(
        `could not verify launchd service removal for ${launchdLabel(label)}: ${loaded.out}`,
      )
    }
  }
  if (fs.existsSync(plistPath)) fs.rmSync(plistPath)
  log.info(`service ${launchdLabel(label)} removed`)
}

function statusLaunchd(label: string): string {
  const r = run('launchctl', ['list', launchdLabel(label)])
  return `launchd ${launchdLabel(label)}: ${r.ok ? 'loaded' : 'not loaded'}`
}

// ─── Windows + WSL (Startup-folder launcher, no admin) ───────────────────────
//
// Windows has no systemd/launchd. For "runs whenever you're logged in" — the
// consumer case, no admin needed — we drop a hidden, restart-on-exit VBScript
// into the user's Startup folder. Two hosts land here:
//   * native Windows → the .vbs runs `node <daemon> start …` directly.
//   * WSL2           → the daemon lives in Linux, but the WSL VM shuts down when
//                      the last terminal closes, so a Linux service can't stay
//                      up. Instead the launcher goes in the WINDOWS Startup
//                      folder (reached from WSL via /mnt/c) and runs
//                      `wsl.exe -e bash <script>`, which boots the VM at Windows
//                      login and runs the daemon inside it.
// A "master" copy under ~/.agentchat/daemon is the installed-marker; the copy in
// Startup is the enabled state (disable removes it, keeps the master — same
// toggle semantics as systemd enable/disable).
//
// The file mechanics + generators are unit-tested and verified on a real
// windows-latest CI runner. The live runtime (hidden loop, WSL boot, process
// kill) still needs a real user machine — called out in the release notes.

export function isWslFromVersion(version: string): boolean {
  return /microsoft|wsl/i.test(version)
}
function isWsl(): boolean {
  if (process.platform !== 'linux') return false
  try {
    return isWslFromVersion(fs.readFileSync('/proc/version', 'utf-8'))
  } catch {
    return false
  }
}
type WinMode = 'win32' | 'wsl'
function winMode(): WinMode | null {
  if (process.platform === 'win32') return 'win32'
  if (isWsl()) return 'wsl'
  return null
}

function winMasterDir(): string {
  return path.join(os.homedir(), '.agentchat', 'daemon')
}
function winStartupDir(mode: WinMode): string {
  if (mode === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
  }
  // WSL: translate the Windows %APPDATA% into a /mnt/c path.
  const appdata = run('cmd.exe', ['/c', 'echo %APPDATA%']).out.split(/\r?\n/).pop()?.trim() ?? ''
  const base = run('wslpath', ['-u', appdata]).out.trim()
  if (!base) throw new Error('could not locate the Windows Startup folder from WSL (is /mnt/c mounted?)')
  return path.join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
}

const vbsEscape = (s: string): string => s.replace(/"/g, '""')
const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** Hidden, restart-on-exit VBScript launcher. `command` is the full command
 *  line; `env` is set on the launcher process (native Windows only). */
export function launcherVbs(command: string, env: Record<string, string>): string {
  const envLines = Object.entries(env).map(
    ([k, v]) => `sh.Environment("Process").Item("${vbsEscape(k)}") = "${vbsEscape(v)}"`,
  )
  return (
    [
      "' AgentChat always-on launcher — runs hidden, restarts on exit.",
      'Set sh = CreateObject("WScript.Shell")',
      ...envLines,
      'Do',
      `  sh.Run "${vbsEscape(command)}", 0, True`,
      '  WScript.Sleep 5000',
      'Loop',
    ].join('\r\n') + '\r\n'
  )
}

/** Native-Windows launch command. */
export function winCommandNative(p: Plan): string {
  return `"${p.node}" "${p.bin}" --home "${p.home}"`
}

/** The bash script WSL runs — a login-shell env plus the daemon. */
export function wslScriptContent(p: Plan): string {
  const exports = Object.entries(p.env).map(([k, v]) => `export ${k}=${shQuote(v)}`)
  return (
    ['#!/bin/bash', ...exports, `exec ${shQuote(p.node)} ${shQuote(p.bin)} --home ${shQuote(p.home)}`].join(
      '\n',
    ) + '\n'
  )
}

function startDetached(cmd: string, args: string[]): void {
  // Escape hatch for tests/headless installs: write the Startup entry but don't
  // actually launch the loop now (it still starts at next login).
  if (process.env['AGENTCHATD_SERVICE_NO_START'] === '1') return
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  } catch (err) {
    log.warn(`could not start the launcher now (it starts at next login): ${String(err)}`)
  }
}
function winPathFromWsl(linuxPath: string): string {
  return run('wslpath', ['-w', linuxPath]).out.trim() || linuxPath
}
function killLauncher(label: string, mode: WinMode): { ok: boolean; out: string } {
  // Best-effort: stop the running wscript launcher, matched by our .vbs name.
  const ps = `Get-CimInstance Win32_Process -Filter "Name='wscript.exe'" | Where-Object { $_.CommandLine -like '*${label}.vbs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`
  return run(mode === 'win32' ? 'powershell' : 'powershell.exe', ['-NoProfile', '-Command', ps])
}

function installWindows(p: Plan, mode: WinMode): void {
  const master = winMasterDir()
  fs.mkdirSync(master, { recursive: true })
  const masterVbs = path.join(master, `${p.label}.vbs`)
  if (mode === 'win32') {
    atomicWriteFile(masterVbs, launcherVbs(winCommandNative(p), p.env), 0o600)
  } else {
    const scriptPath = path.join(master, `${p.label}.sh`)
    atomicWriteFile(scriptPath, wslScriptContent(p), 0o700)
    const distro = serviceValue('WSL distro', process.env['WSL_DISTRO_NAME'] ?? '')
    if (!distro) throw new Error('WSL_DISTRO_NAME is not set — cannot target the right WSL distro')
    atomicWriteFile(
      masterVbs,
      launcherVbs(`wsl.exe -d "${distro}" -e bash "${scriptPath}"`, {}),
      0o600,
    )
  }
  log.info(`wrote ${masterVbs}`)
  enableWindows(p.label, mode)
  log.info(`service ${p.label} installed (starts at login)`)
}
function enableWindows(label: string, mode: WinMode): void {
  const masterVbs = path.join(winMasterDir(), `${label}.vbs`)
  if (!fs.existsSync(masterVbs)) throw new Error(`no ${label} daemon installed — run install first`)
  const startup = winStartupDir(mode)
  fs.mkdirSync(startup, { recursive: true })
  const startupVbs = path.join(startup, `${label}.vbs`)
  fs.copyFileSync(masterVbs, startupVbs)
  if (registrationSkipped()) return
  if (mode === 'win32') startDetached('wscript.exe', [startupVbs])
  else startDetached('cmd.exe', ['/c', 'start', '', '/b', 'wscript.exe', winPathFromWsl(startupVbs)])
}
function disableWindows(label: string, mode: WinMode): void {
  const startupVbs = path.join(winStartupDir(mode), `${label}.vbs`)
  if (fs.existsSync(startupVbs)) fs.rmSync(startupVbs)
  if (!registrationSkipped()) {
    const killed = killLauncher(label, mode)
    if (!killed.ok) {
      throw new Error(`could not stop Windows launcher ${label}: ${killed.out || 'unknown error'}`)
    }
  }
}
function uninstallWindows(label: string, mode: WinMode): void {
  // If stopping cannot be verified, preserve the master scripts and durable
  // daemon. The caller can retry without leaving a hidden restart loop pointed
  // at a deleted executable.
  disableWindows(label, mode)
  for (const f of [`${label}.vbs`, `${label}.sh`]) {
    const m = path.join(winMasterDir(), f)
    if (fs.existsSync(m)) fs.rmSync(m)
  }
}
function statusWindows(label: string, mode: WinMode): string {
  const installed = fs.existsSync(path.join(winMasterDir(), `${label}.vbs`))
  let enabled = false
  try {
    enabled = fs.existsSync(path.join(winStartupDir(mode), `${label}.vbs`))
  } catch {
    /* startup dir unresolved */
  }
  const host = mode === 'wsl' ? 'wsl' : 'windows'
  return `${host} ${label}: ${installed ? (enabled ? 'enabled' : 'installed (disabled)') : 'not installed'}`
}

// ─── platform dispatch ───────────────────────────────────────────────────────

export function installService(opts: ServiceOpts): void {
  const p = plan(opts)
  if (!p.bin) throw new Error('no daemon entrypoint given (ServiceOpts.entry)')
  const wm = winMode()
  if (wm) return installWindows(p, wm)
  if (process.platform === 'linux') return installSystemd(p) // native Linux (not WSL)
  if (process.platform === 'darwin') return installLaunchd(p)
  throw new Error(`service install is not supported on ${process.platform} — run \`agentchatd start\` under your own supervisor`)
}

export function uninstallService(opts: ServiceRef): void {
  const label = serviceLabel(opts.label)
  const wm = winMode()
  if (wm) return uninstallWindows(label, wm)
  if (process.platform === 'linux') return uninstallSystemd(label)
  if (process.platform === 'darwin') return uninstallLaunchd(label)
  throw new Error(`service uninstall is not supported on ${process.platform}`)
}

export function serviceStatus(opts: ServiceRef): string {
  const label = serviceLabel(opts.label)
  const wm = winMode()
  if (wm) return statusWindows(label, wm)
  if (process.platform === 'linux') return statusSystemd(label)
  if (process.platform === 'darwin') return statusLaunchd(label)
  return `service management not supported on ${process.platform}`
}

/** Pure on-disk check used by integration self-healing and doctor. */
export function serviceDefinitionCurrent(opts: ServiceOpts): boolean {
  try {
    const p = plan(opts)
    const wm = winMode()
    if (wm === 'win32') {
      const file = path.join(winMasterDir(), `${p.label}.vbs`)
      return fs.existsSync(file) && fs.readFileSync(file, 'utf-8') === launcherVbs(winCommandNative(p), p.env)
    }
    if (wm === 'wsl') {
      const script = path.join(winMasterDir(), `${p.label}.sh`)
      const vbs = path.join(winMasterDir(), `${p.label}.vbs`)
      const distro = serviceValue('WSL distro', process.env['WSL_DISTRO_NAME'] ?? '')
      if (!distro) return false
      return (
        fs.existsSync(script) &&
        fs.existsSync(vbs) &&
        fs.readFileSync(script, 'utf-8') === wslScriptContent(p) &&
        fs.readFileSync(vbs, 'utf-8') ===
          launcherVbs(`wsl.exe -d "${distro}" -e bash "${script}"`, {})
      )
    }
    if (process.platform === 'linux') {
      const file = systemdUnitPath(p.label)
      return fs.existsSync(file) && fs.readFileSync(file, 'utf-8') === systemdUnit(p)
    }
    if (process.platform === 'darwin') {
      const file = launchdPlistPath(p.label)
      return fs.existsSync(file) && fs.readFileSync(file, 'utf-8') === launchdPlist(p)
    }
    return false
  } catch {
    return false
  }
}

// ─── enable / disable (the away-replies opt-out) ─────────────────────────────
//
// Toggle the service's run-state WITHOUT uninstalling — so a user who wants
// "reply only while I'm in a session" flips the daemon off, and back on later,
// with one word. The unit/plist file stays on disk either way, so re-enabling
// is instant. `install` already leaves it enabled (always-on by default);
// these just turn that on and off after the fact.

function unitInstalled(label: string): boolean {
  if (winMode()) return fs.existsSync(path.join(winMasterDir(), `${label}.vbs`))
  if (process.platform === 'linux') return fs.existsSync(systemdUnitPath(label))
  if (process.platform === 'darwin') return fs.existsSync(launchdPlistPath(label))
  return false
}

export function serviceInstalled(opts: ServiceRef): boolean {
  return unitInstalled(serviceLabel(opts.label))
}

export function disableService(opts: ServiceOpts): void {
  const label = serviceLabel(opts.label)
  if (!unitInstalled(label)) {
    throw new Error(`no ${opts.label} daemon installed — nothing to disable (run install first)`)
  }
  const wm = winMode()
  if (wm) {
    disableWindows(label, wm) // drop the Startup copy, keep the master
  } else if (process.platform === 'linux') {
    // Stops it AND removes the start-on-boot link; the unit file stays.
    if (!registrationSkipped()) {
      const disabled = run('systemctl', ['--user', 'disable', '--now', label])
      if (!disabled.ok) throw new Error(`could not disable ${label}: ${disabled.out}`)
    }
  } else if (process.platform === 'darwin') {
    if (!registrationSkipped()) {
      const disabled = run('launchctl', ['unload', launchdPlistPath(label)])
      if (!disabled.ok) throw new Error(`could not disable ${label}: ${disabled.out}`)
    }
  } else {
    throw new Error(`not supported on ${process.platform}`)
  }
  log.info(`daemon ${label} disabled — session-only until you re-enable`)
}

export function enableService(opts: ServiceOpts): void {
  const label = serviceLabel(opts.label)
  if (!unitInstalled(label)) {
    throw new Error(`no ${opts.label} daemon installed — run install first`)
  }
  const wm = winMode()
  if (wm) {
    enableWindows(label, wm) // copy the master back into Startup + start now
  } else if (process.platform === 'linux') {
    if (!registrationSkipped()) {
      const enabled = run('systemctl', ['--user', 'enable', '--now', label])
      if (!enabled.ok) throw new Error(`could not enable ${label}: ${enabled.out}`)
    }
  } else if (process.platform === 'darwin') {
    if (!registrationSkipped()) {
      const enabled = run('launchctl', ['load', '-w', launchdPlistPath(label)])
      if (!enabled.ok) throw new Error(`could not enable ${label}: ${enabled.out}`)
    }
  } else {
    throw new Error(`not supported on ${process.platform}`)
  }
  log.info(`daemon ${label} enabled — always-on while this machine is up`)
}
