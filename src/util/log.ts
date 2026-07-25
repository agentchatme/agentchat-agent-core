// ─── stderr-only diagnostics ────────────────────────────────────────────────
//
// stdout belongs to the hook protocol (platforms parse it as JSON) and to
// command output the agent reads. Every diagnostic goes to stderr, gated by
// AGENTCHAT_LOG_LEVEL. There is deliberately no logging dependency here —
// hooks run on every session start and must add zero startup weight.

const LEVELS = ['silent', 'error', 'warn', 'info', 'debug'] as const
export type LogLevel = (typeof LEVELS)[number]

function activeLevel(): number {
  const raw = (process.env['AGENTCHAT_LOG_LEVEL'] ?? 'warn').toLowerCase()
  const idx = LEVELS.indexOf(raw as LogLevel)
  return idx === -1 ? LEVELS.indexOf('warn') : idx
}

function emit(level: LogLevel, msg: string): void {
  if (LEVELS.indexOf(level) <= activeLevel() && level !== 'silent') {
    process.stderr.write(`[agentchat:${level}] ${msg}\n`)
  }
}

export const log = {
  error: (msg: string) => emit('error', msg),
  warn: (msg: string) => emit('warn', msg),
  info: (msg: string) => emit('info', msg),
  debug: (msg: string) => emit('debug', msg),
}
