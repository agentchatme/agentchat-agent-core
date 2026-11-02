import { describe, expect, it } from 'vitest'
import { KnockCoalescer } from '../src/doorbell/knock.js'
import { FakeClock } from './helpers/fake-clock.js'

// ─── One run per burst, and a retry ladder that never climbs past the sooner ─

function coalescer(clock: FakeClock, debounceMs = 2_000) {
  const fires: number[] = []
  const c = new KnockCoalescer({
    onFire: () => fires.push(clock.now()),
    debounceMs,
    now: () => clock.now(),
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (h) => clock.clearTimeout(h),
  })
  return { c, fires }
}

describe('KnockCoalescer', () => {
  it('a burst of knocks inside the window fires exactly once', () => {
    const clock = new FakeClock()
    const { c, fires } = coalescer(clock)
    c.knock()
    clock.advance(500)
    c.knock()
    c.knock()
    clock.advance(1_000)
    c.knock()
    expect(fires).toEqual([])
    clock.advance(500)
    expect(fires).toEqual([2_000])
    expect(c.knocks).toBe(4)
    expect(c.absorbed).toBe(3)
    expect(c.fires).toBe(1)
  })

  it('a knock after the window arms a new one', () => {
    const clock = new FakeClock()
    const { c, fires } = coalescer(clock)
    c.knock()
    clock.advance(2_000)
    c.knock()
    clock.advance(2_000)
    expect(fires).toEqual([2_000, 4_000])
  })

  it('knockAfter keeps the SOONER pending deadline', () => {
    // The Hermes lesson: two failed cycles inside one outage climbed to the
    // 300 s rung and replaced the pending 60 s retry. The sooner wins.
    const clock = new FakeClock()
    const { c, fires } = coalescer(clock, 0)
    c.knockAfter(60_000)
    c.knockAfter(300_000)
    expect(c.delayedPending).toBe(true)
    expect(c.delayedDue).toBe(60_000)
    clock.advance(60_000)
    expect(fires).toEqual([60_000])
    expect(c.delayedPending).toBe(false)
  })

  it('a later knockAfter with an EARLIER deadline replaces the pending one', () => {
    const clock = new FakeClock()
    const { c, fires } = coalescer(clock, 0)
    c.knockAfter(300_000)
    c.knockAfter(60_000)
    expect(c.delayedDue).toBe(60_000)
    clock.advance(60_000)
    expect(fires).toEqual([60_000])
    clock.advance(300_000)
    expect(fires).toEqual([60_000]) // the 300 s timer was cancelled, not kept
  })

  it('an immediate knock during a pending retry still fires on its own schedule', () => {
    const clock = new FakeClock()
    const { c, fires } = coalescer(clock, 2_000)
    c.knockAfter(60_000)
    c.knock()
    clock.advance(2_000)
    expect(fires).toEqual([2_000])
    clock.advance(58_000) // the delayed knock lands at 60 s and arms its own 2 s window
    expect(fires).toEqual([2_000])
    clock.advance(2_000)
    expect(fires).toEqual([2_000, 62_000])
  })

  it('stop cancels everything and ignores later knocks', () => {
    const clock = new FakeClock()
    const { c, fires } = coalescer(clock)
    c.knock()
    c.knockAfter(60_000)
    c.stop()
    c.knock()
    clock.advance(120_000)
    expect(fires).toEqual([])
  })

  it('rejects a negative debounce', () => {
    expect(() => new KnockCoalescer({ onFire: () => {}, debounceMs: -1 })).toThrow(RangeError)
  })
})
