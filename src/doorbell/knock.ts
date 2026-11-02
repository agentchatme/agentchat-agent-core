// ─── Knock coalescing — one run per burst, not per frame ────────────────────
//
// A `message.new` frame is a knock: a hint that something is waiting, never
// the carrier of what is waiting (the main line's rule 2). A group burst
// arrives as many frames within a second; the first knock arms a short timer,
// every knock inside the window is absorbed, and the timer fires exactly once.
// Whoever fires then starts ONE run, and the run reads the whole tray through
// the hosted tools — so nothing a later frame announced is missed. The tray is
// the truth, the knock is not.
//
// `knockAfter` serves the local retry ladder: when a run could not start or
// did not complete, the doorbell schedules another knock later instead of
// dropping the backlog. The server's own ladder only rings webhooks; a
// connected socket gets no re-ring, so the doorbell carries that duty itself.
// When a delayed knock is already pending the SOONER deadline wins — a later
// retry never pushes an earlier one back. (Learned on the Hermes doorbell: two
// failed cycles inside one outage once climbed the ladder to 300 s and
// replaced the pending 60 s retry.)

export const DEFAULT_KNOCK_DEBOUNCE_MS = 2_000

export type TimerHandle = ReturnType<typeof setTimeout>

export interface KnockCoalescerOptions {
  readonly onFire: () => void
  readonly debounceMs?: number
  /** Clock and timers are injectable so tests never wait on real time. */
  readonly now?: () => number
  readonly setTimeout?: (fn: () => void, ms: number) => TimerHandle
  readonly clearTimeout?: (handle: TimerHandle) => void
}

export class KnockCoalescer {
  private readonly onFire: () => void
  private readonly debounceMs: number
  private readonly now: () => number
  private readonly _setTimeout: (fn: () => void, ms: number) => TimerHandle
  private readonly _clearTimeout: (handle: TimerHandle) => void

  private timer: TimerHandle | null = null
  private delayed: TimerHandle | null = null
  private delayedDeadline: number | null = null
  private stopped = false

  knocks = 0
  absorbed = 0
  fires = 0

  constructor(options: KnockCoalescerOptions) {
    const debounce = options.debounceMs ?? DEFAULT_KNOCK_DEBOUNCE_MS
    if (!(debounce >= 0)) throw new RangeError('debounceMs must be >= 0')
    this.onFire = options.onFire
    this.debounceMs = debounce
    this.now = options.now ?? Date.now
    this._setTimeout = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this._clearTimeout = options.clearTimeout ?? ((handle) => clearTimeout(handle))
  }

  /** True while a debounce timer is armed. */
  get armed(): boolean {
    return this.timer !== null
  }

  /** True while a retry knock is scheduled and has not fired. */
  get delayedPending(): boolean {
    return this.delayed !== null
  }

  /** Epoch ms of the pending retry knock, or null. */
  get delayedDue(): number | null {
    return this.delayedDeadline
  }

  /** A knock: arm the timer if none is armed; otherwise absorb. */
  knock(): void {
    if (this.stopped) return
    this.knocks += 1
    if (this.timer !== null) {
      this.absorbed += 1
      return
    }
    this.timer = this._setTimeout(() => this.fire(), this.debounceMs)
  }

  /** A delayed knock (retry ladder). The sooner pending deadline is kept. */
  knockAfter(delayMs: number): void {
    if (this.stopped) return
    const delay = Math.max(0, delayMs)
    const deadline = this.now() + delay
    if (this.delayed !== null) {
      if (this.delayedDeadline !== null && this.delayedDeadline <= deadline) {
        return // an earlier retry is already on its way; keep it
      }
      this._clearTimeout(this.delayed)
    }
    this.delayedDeadline = deadline
    this.delayed = this._setTimeout(() => {
      this.delayed = null
      this.delayedDeadline = null
      this.knock()
    }, delay)
  }

  /** Cancel everything; later knocks are ignored. */
  stop(): void {
    this.stopped = true
    if (this.timer !== null) {
      this._clearTimeout(this.timer)
      this.timer = null
    }
    if (this.delayed !== null) {
      this._clearTimeout(this.delayed)
      this.delayed = null
      this.delayedDeadline = null
    }
  }

  private fire(): void {
    this.timer = null
    if (this.stopped) return
    this.fires += 1
    try {
      this.onFire()
    } catch {
      // The callback belongs to the invoker; a failure there must not kill
      // the timer machinery. The next knock re-arms as usual.
    }
  }
}
