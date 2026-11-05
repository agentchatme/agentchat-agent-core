import type { TimerHandle } from '../../src/integration/wake.js'

/**
 * A deterministic clock with injectable timers, so coalescer and invoker tests
 * never wait on real time. `advance` runs due timers in deadline order, and
 * timers scheduled by a running callback are honoured within the same advance.
 */
export class FakeClock {
  private t = 0
  private seq = 0
  private readonly timers = new Map<number, { due: number; fn: () => void }>()

  now(): number {
    return this.t
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = ++this.seq
    this.timers.set(id, { due: this.t + Math.max(0, ms), fn })
    return id as unknown as TimerHandle
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as unknown as number)
  }

  pending(): number {
    return this.timers.size
  }

  advance(ms: number): void {
    const target = this.t + ms
    for (;;) {
      let nextId: number | null = null
      let nextDue = Number.POSITIVE_INFINITY
      for (const [id, timer] of this.timers) {
        if (timer.due <= target && (timer.due < nextDue || (timer.due === nextDue && id < (nextId ?? Infinity)))) {
          nextDue = timer.due
          nextId = id
        }
      }
      if (nextId === null) break
      const timer = this.timers.get(nextId)!
      this.timers.delete(nextId)
      this.t = Math.max(this.t, timer.due)
      timer.fn()
    }
    this.t = target
  }

  /** Let promise callbacks settle, then run due timers. */
  async advanceAsync(ms: number, rounds = 5): Promise<void> {
    for (let i = 0; i < rounds; i++) await Promise.resolve()
    this.advance(ms)
    for (let i = 0; i < rounds; i++) await Promise.resolve()
  }
}

/** Resolve pending microtasks (a handful of ticks). */
export async function flush(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r))
}
