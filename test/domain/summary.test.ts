import { describe, expect, it } from 'vitest'
import { summarize } from '../../src/domain/summary.js'
import type { Destination } from '../../src/schemas/trip.js'

const tripId = '9b2f4a7c-5d1e-4f8a-8c3b-0a1b2c3d4e5f'
const updatedAt = '2026-10-20T09:00:00Z'

function dest(
  name: string,
  timing: Record<string, unknown> = {},
  i = 0,
): Destination {
  return {
    id: `3f6c1d1e-8a1b-4c3e-9d2a-1b2c3d4e5f6${i}`,
    rawInput: name,
    color: 'coral',
    place: { displayName: name, type: 'city', latitude: 0, longitude: 0 },
    timing: { mode: 'explicitDates', isPlaceholder: false, ...timing },
  } as Destination
}

function trip(destinations: Destination[], name: string | null = 'Trip') {
  return { id: tripId, name, updatedAt, destinations }
}

describe('summarize', () => {
  it('handles no destinations', () => {
    expect(summarize(trip([]))).toEqual({
      id: tripId,
      name: 'Trip',
      destinationCount: 0,
      placeNames: [],
      startDay: null,
      endDay: null,
      updatedAt,
    })
  })

  it('copies a null name', () => {
    expect(summarize(trip([], null)).name).toBeNull()
  })

  it('uses the first three place names in array order', () => {
    const s = summarize(trip([dest('A', {}, 1), dest('B', {}, 2), dest('C', {}, 3), dest('D', {}, 4)]))
    expect(s.placeNames).toEqual(['A', 'B', 'C'])
    expect(s.destinationCount).toBe(4)
  })

  it('takes min start and max end across destinations, not array order', () => {
    const s = summarize(
      trip([
        dest('A', { startDay: '2026-06-10', endDay: '2026-06-12' }, 1),
        dest('B', { startDay: '2026-04-01', endDay: '2026-04-03' }, 2),
      ]),
    )
    expect(s.startDay).toBe('2026-04-01')
    expect(s.endDay).toBe('2026-06-12')
  })

  it('uses only the days that are present', () => {
    const s = summarize(
      trip([
        dest('A', {}, 1),
        dest('B', { startDay: '2026-05-01', endDay: null }, 2),
        dest('C', { startDay: '2026-03-01', endDay: '2026-03-09' }, 3),
      ]),
    )
    expect(s.startDay).toBe('2026-03-01')
    expect(s.endDay).toBe('2026-03-09')
  })

  it('counts a destination with only startDay', () => {
    const s = summarize(trip([dest('A', { startDay: '2026-05-01' }, 1)]))
    expect(s.startDay).toBe('2026-05-01')
    expect(s.endDay).toBeNull()
  })

  it('returns null days when none are set; duration and fuzzy month contribute nothing', () => {
    const s = summarize(
      trip([
        dest('A', { mode: 'durationOnly', durationDays: 5 }, 1),
        dest('B', { mode: 'fuzzyMonth', targetYear: 2026, targetMonth: 7 }, 2),
      ]),
    )
    expect(s.startDay).toBeNull()
    expect(s.endDay).toBeNull()
  })
})
