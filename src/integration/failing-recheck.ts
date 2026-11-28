// ─── The re-check while runs fail ───────────────────────────────────────────
//
// The listener report's `runs_failing` is decided after a run: the recheck
// after a failed run, or the runtime check after one. Nothing else re-decides
// it, and a run starts only when a message arrives, so a failure that ends
// on its own (a usage limit that resets, the runtime signed in again) would
// read as failing until someone writes. While it lasts, the integration
// therefore looks again on its own, on a growing gap: 30 minutes, 1 hour,
// 2 hours, then every 4 hours (`RUNS_FAILING_RECHECK_MS`, the last gap
// repeating). This is the clock; what a re-check does is the integration's.
//
// One timer at a time, armed only after the previous re-check has ended,
// measured from that moment: a timer that fires late (a machine that slept,
// a clock that jumped) is one re-check, never a burst of the ones it missed.
// The timers are unref'd: they never keep the process alive.

/** The gaps between re-checks while the listener report says `runs_failing`; the last repeats. */
export const RUNS_FAILING_RECHECK_MS: readonly number[] = [30 * 60_000, 60 * 60_000, 2 * 60 * 60_000, 4 * 60 * 60_000]

export type RecheckTimerHandle = ReturnType<typeof setTimeout>

/** What the schedule waits with (a fake clock in tests). */
export interface RecheckTimers {
  setTimeout(fn: () => void, ms: number): RecheckTimerHandle
  clearTimeout(handle: RecheckTimerHandle): void
}

const REAL_TIMERS: RecheckTimers = {
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms)
    timer.unref?.()
    return timer
  },
  clearTimeout: (handle) => clearTimeout(handle),
}

export interface RecheckScheduleOptions {
  /**
   * One re-check. `episode` names the episode it belongs to: its answer
   * counts only while `current(episode)` (a run that completed meanwhile, or
   * a stop, ended it). Never throws; a throw is caught and the schedule goes on.
   */
  readonly recheck: (episode: number) => Promise<void>
  /** The gaps (`RUNS_FAILING_RECHECK_MS`); at least one, each positive. */
  readonly gapsMs?: readonly number[]
  readonly timers?: RecheckTimers
}

/** Re-checks on a growing gap while an episode lasts: `start()` begins one, `stop()` ends it. */
export class RecheckSchedule {
  private readonly gapsMs: readonly number[]
  private readonly timers: RecheckTimers
  /** Bumped by every start and stop: a re-check under way from an older episode is stale. */
  private episode = 0
  private active = false
  /** Re-checks armed in this episode so far: which gap comes next. */
  private step = 0
  private timer: RecheckTimerHandle | null = null
  private dueInMs: number | null = null
  private running: Promise<void> | null = null

  constructor(private readonly options: RecheckScheduleOptions) {
    const gaps = options.gapsMs ?? RUNS_FAILING_RECHECK_MS
    if (gaps.length === 0 || gaps.some((ms) => !Number.isFinite(ms) || ms <= 0)) throw new TypeError('RecheckSchedule: gapsMs must be one or more positive numbers')
    this.gapsMs = [...gaps]
    this.timers = options.timers ?? REAL_TIMERS
  }

  /** Whether an episode is under way. */
  get armed(): boolean {
    return this.active
  }

  /** The gap the armed timer waits, or null while none is armed (no episode, or a re-check under way). */
  get nextInMs(): number | null {
    return this.dueInMs
  }

  /** The gap the next timer will wait (the one armed after a re-check under way ends). */
  upcomingGapMs(): number {
    return this.gapsMs[Math.min(this.step, this.gapsMs.length - 1)] as number
  }

  /**
   * Begin an episode at the first gap. One under way keeps its place: a
   * change of reason within an episode is not a new one. Returns whether
   * this started one.
   */
  start(): boolean {
    if (this.active) return false
    this.active = true
    this.episode += 1
    this.step = 0
    this.arm()
    return true
  }

  /** End the episode: the timer cleared, no re-check after this (one under way finishes, stale). Idempotent. */
  stop(): void {
    if (!this.active) return
    this.active = false
    this.episode += 1
    this.clear()
  }

  /** Whether `episode` is still the one under way. */
  current(episode: number): boolean {
    return this.active && this.episode === episode
  }

  /** Resolves when no re-check is under way. */
  async done(): Promise<void> {
    while (this.running !== null) await this.running
  }

  private arm(): void {
    const gap = this.upcomingGapMs()
    this.step += 1
    this.dueInMs = gap
    this.timer = this.timers.setTimeout(() => this.fire(), gap)
  }

  private clear(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer)
    this.timer = null
    this.dueInMs = null
  }

  private fire(): void {
    this.timer = null
    this.dueInMs = null
    if (!this.active) return
    const episode = this.episode
    const run = (async () => {
      try {
        await this.options.recheck(episode)
      } catch {
        /* the re-check never throws; one that did must not end the schedule */
      }
    })()
    this.running = run
    void run.finally(() => {
      if (this.running === run) this.running = null
      // Measured from now, not from when it was due: one re-check per due time, never a catch-up burst.
      if (this.current(episode)) this.arm()
    })
  }
}
