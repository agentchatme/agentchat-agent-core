// ─── Wake coalescing — one run per burst, not per frame ─────────────────────
//
// A `message.new` frame, a `wake` frame, a (re)connect: each is a WAKE — a
// hint that something may be waiting, never the carrier of what is waiting.
// A group burst arrives as many frames within a second; the first wake arms a
// short timer, every wake inside the window is absorbed, and the timer fires
// exactly once. Whoever fires then starts ONE run, and the run reads the whole
// tray through the hosted tools — so nothing a later frame announced is
// missed. The tray is the truth, the wake is not.
//
// `wakeAfter` serves the local retry ladder: when a run could not start or did
// not complete, the integration schedules another wake later instead of
// dropping the backlog. The server's own ladder only rings webhooks; a
// connected socket gets no re-ring, so the integration carries that duty
// itself. When a delayed wake is already pending the SOONER deadline wins — a
// later retry never pushes an earlier one back. (Learned on the Hermes
// integration: two failed cycles inside one outage once climbed the ladder to
// 300 s and replaced the pending 60 s retry.) `cancelDelayed` drops a pending
// retry once nothing is owed: a stale re-wake once fired 4.5 min after a
// successful run and started a run on an empty tray (Codex live-fire, leg 10).

export const DEFAULT_WAKE_DEBOUNCE_MS = 2_000

export type TimerHandle = ReturnType<typeof setTimeout>

export interface WakeCoalescerOptions {
  readonly onFire: () => void
  readonly debounceMs?: number
  /** Clock and timers are injectable so tests never wait on real time. */
  readonly now?: () => number
  readonly setTimeout?: (fn: () => void, ms: number) => TimerHandle
  readonly clearTimeout?: (handle: TimerHandle) => void
}

export class WakeCoalescer {
  private readonly onFire: () => void
  private readonly debounceMs: number
  private readonly now: () => number
  private readonly _setTimeout: (fn: () => void, ms: number) => TimerHandle
  private readonly _clearTimeout: (handle: TimerHandle) => void

  private timer: TimerHandle | null = null
  private delayed: TimerHandle | null = null
  private delayedDeadline: number | null = null
  private stopped = false

  wakes = 0
  absorbed = 0
  fires = 0

  constructor(options: WakeCoalescerOptions) {
    const debounce = options.debounceMs ?? DEFAULT_WAKE_DEBOUNCE_MS
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

  /** True while a retry wake is scheduled and has not fired. */
  get delayedPending(): boolean {
    return this.delayed !== null
  }

  /** Epoch ms of the pending retry wake, or null. */
  get delayedDue(): number | null {
    return this.delayedDeadline
  }

  /** A wake: arm the timer if none is armed; otherwise absorb. */
  wake(): void {
    if (this.stopped) return
    this.wakes += 1
    if (this.timer !== null) {
      this.absorbed += 1
      return
    }
    this.timer = this._setTimeout(() => this.fire(), this.debounceMs)
  }

  /** A delayed wake (retry ladder). The sooner pending deadline is kept. */
  wakeAfter(delayMs: number): void {
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
      this.wake()
    }, delay)
  }

  /**
   * Drop a pending retry wake, if there is one; returns whether there was.
   * The debounce timer and later wakes are unaffected. For when nothing is
   * owed any more — a run read the whole tray, or the tray was found empty —
   * so the retry would only ring for a backlog that is already handled.
   */
  cancelDelayed(): boolean {
    if (this.delayed === null) return false
    this._clearTimeout(this.delayed)
    this.delayed = null
    this.delayedDeadline = null
    return true
  }

  /** Cancel everything; later wakes are ignored. */
  stop(): void {
    this.stopped = true
    if (this.timer !== null) {
      this._clearTimeout(this.timer)
      this.timer = null
    }
    this.cancelDelayed()
  }

  private fire(): void {
    this.timer = null
    if (this.stopped) return
    this.fires += 1
    try {
      this.onFire()
    } catch {
      // The callback belongs to the invoker; a failure there must not kill
      // the timer machinery. The next wake re-arms as usual.
    }
  }
}
