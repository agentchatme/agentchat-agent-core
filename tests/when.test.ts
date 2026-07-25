import { describe, expect, it } from 'vitest'
import { relativeAge, absoluteUtc, relativeWhen, formatWhen } from '../src/util/when.js'

// The daemon carries a byte-identical copy at daemon/src/when.ts (same
// deliberate duplication as wire.ts); these tests pin the shared logic.

const T = Date.parse('2026-07-24T14:32:10.000Z')

describe('relativeAge', () => {
  it('buckets durations into coarse human ages', () => {
    expect(relativeAge(10 * 1000)).toBe('just now')
    expect(relativeAge(75 * 1000)).toBe('1 minute ago')
    expect(relativeAge(3 * 60 * 1000)).toBe('3 minutes ago')
    expect(relativeAge(75 * 60 * 1000)).toBe('1 hour ago')
    expect(relativeAge(2 * 60 * 60 * 1000)).toBe('2 hours ago')
    expect(relativeAge(30 * 60 * 60 * 1000)).toBe('1 day ago')
    expect(relativeAge(3 * 24 * 60 * 60 * 1000)).toBe('3 days ago')
  })
})

describe('absoluteUtc', () => {
  it('renders minute-precision UTC with an explicit zone', () => {
    expect(absoluteUtc(T)).toBe('2026-07-24 14:32 UTC')
  })
})

describe('relativeWhen', () => {
  it('is relative-only and injectable for determinism', () => {
    expect(relativeWhen('2026-07-24T14:32:10.000Z', T + 3 * 60 * 1000)).toBe('3 minutes ago')
  })
  it('clamps clock skew (future stamp) to "just now"', () => {
    expect(relativeWhen('2026-07-24T14:32:10.000Z', T - 5000)).toBe('just now')
  })
  it('returns empty string for a missing/unparseable stamp so callers can omit it', () => {
    expect(relativeWhen(undefined, T)).toBe('')
    expect(relativeWhen('not-a-date', T)).toBe('')
  })
})

describe('formatWhen', () => {
  it('combines relative age and absolute UTC', () => {
    expect(formatWhen('2026-07-24T14:32:10.000Z', T + 3 * 60 * 1000)).toBe(
      '3 minutes ago (2026-07-24 14:32 UTC)',
    )
  })
  it('degrades to a readable phrase when the stamp is absent', () => {
    expect(formatWhen(undefined, T)).toBe('at an unknown time')
    expect(formatWhen('garbage', T)).toBe('at an unknown time')
  })
})
