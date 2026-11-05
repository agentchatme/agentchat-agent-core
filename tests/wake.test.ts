import { describe, expect, it } from 'vitest'
import { WakeCoalescer } from '../src/integration/wake.js'
import { FakeClock } from './helpers/fake-clock.js'

// ─── One run per burst, and a retry ladder that never climbs past the sooner ─
//
// A wake is the signal (a `message.new` frame, a `wake` frame, a connect);
// the coalescer turns a burst of them into one firing.

function coalescer(clock: FakeClock, debounceMs = 2_000) {
  const fires: number[] = []
  const c = new WakeCoalescer({
    onFire: () => fires.push(clock.now()),
    debounceMs,
    now: () => clock.now(),
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (h) => clock.clearTimeout(h),
  })
  return { c, fires }
}

describe('WakeCoalescer', () => {
  it('a burst of wakes inside the window fires exactly once', () => {
    const clock = new FakeClock()
    const { c, fires } = coalescer(clock)
    c.wake()
    clock.advance(500)
    c.wake()
    c.wake()
    clock.advance(1_000)
    c.wake()
    expect(fires).toEqual([])
    clock.advance(500)
    expect(fires).toEqual([2_000])
    expect(c.wakes).toBe(4)
    expect(c.absorbed).toBe(3)
    expect(c.fires).toBe(1)
  })

  it('a wake after the window arms a new one', () => {
    const clock = new FakeClock()
    const { c, fires } = coalescer(clock)
    c.wake()
    clock.advance(2_000)
    c.wake()
    clock.advance(2_000)
    expect(fires).toEqual([2_000, 4_000])
  })

  it('wakeAfter keeps the SOONER pending deadline', () => {
    // The Hermes lesson: two failed cycles inside one outage climbed to the
    // 300 s rung and replaced the pending 60 s retry. The sooner wins.
    const clock = new FakeClock()
    const { c, fires } = coalescer(clock, 0)
    c.wakeAfter(60_000)
    c.wakeAfter(300_000)
    expect(c.delayedPending).toBe(true)
    expect(c.delayedDue).toBe(60_000)
    clock.advance(60_000)
    expect(fires).toEqual([60_000])
    expect(c.delayedPending).toBe(false)
  })

  it('a later wakeAfter with an EARLIER deadline replaces the pending one', () => {
    const clock = new FakeClock()
    const { c, fires } = coalescer(clock, 0)
    c.wakeAfter(300_000)
    c.wakeAfter(60_000)
    expect(c.delayedDue).toBe(60_000)
    clock.advance(60_000)
    expect(fires).toEqual([60_000])
    clock.advance(300_000)
    expect(fires).toEqual([60_000]) // the 300 s timer was cancelled, not kept
  })

  it('an immediate wake during a pending retry still fires on its own schedule', () => {
    const clock = new FakeClock()
    const { c, fires } = coalescer(clock, 2_000)
    c.wakeAfter(60_000)
    c.wake()
    clock.advance(2_000)
    expect(fires).toEqual([2_000])
    clock.advance(58_000) // the delayed wake lands at 60 s and arms its own 2 s window
    expect(fires).toEqual([2_000])
    clock.advance(2_000)
    expect(fires).toEqual([2_000, 62_000])
  })

  it('cancelDelayed drops only the pending retry; the debounce and later wakes still work', () => {
    const clock = new FakeClock()
    const { c, fires } = coalescer(clock, 2_000)
    expect(c.cancelDelayed()).toBe(false) // nothing pending
    c.wakeAfter(60_000)
    c.wake()
    expect(c.cancelDelayed()).toBe(true)
    expect(c.delayedPending).toBe(false)
    expect(c.delayedDue).toBeNull()
    clock.advance(2_000)
    expect(fires).toEqual([2_000]) // the debounced wake was not touched
    clock.advance(120_000)
    expect(fires).toEqual([2_000]) // the retry never fires
    c.wakeAfter(60_000) // and a later retry can be scheduled again
    clock.advance(62_000)
    expect(fires).toEqual([2_000, 184_000])
  })

  it('stop cancels everything and ignores later wakes', () => {
    const clock = new FakeClock()
    const { c, fires } = coalescer(clock)
    c.wake()
    c.wakeAfter(60_000)
    c.stop()
    c.wake()
    clock.advance(120_000)
    expect(fires).toEqual([])
  })

  it('rejects a negative debounce', () => {
    expect(() => new WakeCoalescer({ onFire: () => {}, debounceMs: -1 })).toThrow(RangeError)
  })
})
