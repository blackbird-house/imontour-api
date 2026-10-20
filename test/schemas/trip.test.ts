import { describe, expect, it } from 'vitest'
import {
  createTripBodySchema,
  renameSchema,
  tripInputSchema,
  tripSchema,
} from '../../src/schemas/trip.js'

const destId = '3f6c1d1e-8a1b-4c3e-9d2a-1b2c3d4e5f60'
const tripId = '9b2f4a7c-5d1e-4f8a-8c3b-0a1b2c3d4e5f'

function dest(overrides: Record<string, unknown> = {}) {
  return {
    id: destId,
    rawInput: 'Tokyo in April',
    color: 'coral',
    place: {
      displayName: 'Tokyo',
      type: 'city',
      latitude: 35.68,
      longitude: 139.69,
      geocodeSourceID: null,
      countryCode: 'JP',
    },
    timing: {
      mode: 'explicitDates',
      startDay: '2026-04-01',
      endDay: '2026-04-05',
      durationDays: 5,
      targetYear: null,
      targetMonth: null,
      isPlaceholder: false,
    },
    ...overrides,
  }
}

function trip(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: 1, name: 'Japan', destinations: [dest()], ...overrides }
}

function withTiming(t: Record<string, unknown>) {
  const d = dest()
  return trip({ destinations: [{ ...d, timing: { ...d.timing, ...t } }] })
}

function withPlace(p: Record<string, unknown>) {
  const d = dest()
  return trip({ destinations: [{ ...d, place: { ...d.place, ...p } }] })
}

describe('tripInputSchema', () => {
  it('accepts the spec example trip', () => {
    expect(tripInputSchema.safeParse(trip({ id: tripId })).success).toBe(true)
  })

  it('keeps unknown color, place type and timing mode unchanged', () => {
    const d = dest({ color: 'chartreuse' })
    const body = trip({
      destinations: [
        {
          ...d,
          place: { ...d.place, type: 'island' },
          timing: { ...d.timing, mode: 'sabbatical' },
        },
      ],
    })
    const out = tripInputSchema.parse(body)
    expect(out.destinations[0]?.color).toBe('chartreuse')
    expect(out.destinations[0]?.place.type).toBe('island')
    expect(out.destinations[0]?.timing.mode).toBe('sabbatical')
  })

  it.each(['2026-02-30', '2026-4-1', '2026-04-01T00:00'])('rejects startDay %s', (day) => {
    expect(tripInputSchema.safeParse(withTiming({ startDay: day })).success).toBe(false)
  })

  it('rejects an invalid endDay', () => {
    expect(tripInputSchema.safeParse(withTiming({ endDay: '2026-13-01' })).success).toBe(false)
  })

  it('accepts a leap day and rejects a non-leap one', () => {
    expect(tripInputSchema.safeParse(withTiming({ startDay: '2028-02-29' })).success).toBe(true)
    expect(tripInputSchema.safeParse(withTiming({ startDay: '2027-02-29' })).success).toBe(false)
  })

  it('rejects out-of-range coordinates', () => {
    expect(tripInputSchema.safeParse(withPlace({ latitude: 91 })).success).toBe(false)
    expect(tripInputSchema.safeParse(withPlace({ longitude: -181 })).success).toBe(false)
    expect(tripInputSchema.safeParse(withPlace({ latitude: -90, longitude: 180 })).success).toBe(true)
  })

  it('rejects bad durationDays and targetMonth', () => {
    expect(tripInputSchema.safeParse(withTiming({ durationDays: 0 })).success).toBe(false)
    expect(tripInputSchema.safeParse(withTiming({ durationDays: 1.5 })).success).toBe(false)
    expect(tripInputSchema.safeParse(withTiming({ targetMonth: 13 })).success).toBe(false)
    expect(tripInputSchema.safeParse(withTiming({ targetMonth: 0 })).success).toBe(false)
    expect(tripInputSchema.safeParse(withTiming({ targetMonth: 12, targetYear: 2027 })).success).toBe(true)
  })

  it('rejects empty color, place type and mode', () => {
    expect(tripInputSchema.safeParse(trip({ destinations: [dest({ color: '' })] })).success).toBe(false)
    expect(tripInputSchema.safeParse(withPlace({ type: '' })).success).toBe(false)
    expect(tripInputSchema.safeParse(withTiming({ mode: '' })).success).toBe(false)
  })

  it('requires isPlaceholder and a uuid destination id; allows empty rawInput', () => {
    const d = dest()
    const { isPlaceholder: _omit, ...timing } = d.timing
    void _omit
    expect(tripInputSchema.safeParse(trip({ destinations: [{ ...d, timing }] })).success).toBe(false)
    expect(tripInputSchema.safeParse(trip({ destinations: [dest({ id: 'nope' })] })).success).toBe(false)
    expect(tripInputSchema.safeParse(trip({ destinations: [dest({ rawInput: '' })] })).success).toBe(true)
  })

  it('accepts optional fields absent', () => {
    const d = dest()
    const timing = { mode: 'durationOnly', isPlaceholder: true }
    const place = { displayName: 'X', type: 'city', latitude: 0, longitude: 0 }
    expect(tripInputSchema.safeParse(trip({ destinations: [{ ...d, place, timing }] })).success).toBe(true)
  })

  it('limits destinations to 200 and allows 0', () => {
    const many = (n: number) => Array.from({ length: n }, () => dest())
    expect(tripInputSchema.safeParse(trip({ destinations: many(201) })).success).toBe(false)
    expect(tripInputSchema.safeParse(trip({ destinations: many(200) })).success).toBe(true)
    expect(tripInputSchema.safeParse(trip({ destinations: [] })).success).toBe(true)
  })

  it('rejects schemaVersion 2 and defaults an absent one to 1', () => {
    expect(tripInputSchema.safeParse(trip({ schemaVersion: 2 })).success).toBe(false)
    const { schemaVersion: _sv, ...noVersion } = trip()
    void _sv
    expect(tripInputSchema.parse(noVersion).schemaVersion).toBe(1)
  })

  it('strips unknown keys at top level and inside a destination', () => {
    const out = tripInputSchema.parse(trip({ foo: 1, revision: 9, updatedAt: 'x', destinations: [dest({ foo: 2 })] }))
    expect(out).not.toHaveProperty('foo')
    expect(out).not.toHaveProperty('revision')
    expect(out).not.toHaveProperty('updatedAt')
    expect(out.destinations[0]).not.toHaveProperty('foo')
  })

  it('keeps name as empty string or null, and allows it absent', () => {
    expect(tripInputSchema.parse(trip({ name: '' })).name).toBe('')
    expect(tripInputSchema.parse(trip({ name: null })).name).toBeNull()
    const { name: _n, ...noName } = trip()
    void _n
    expect(tripInputSchema.safeParse(noName).success).toBe(true)
  })
})

describe('other schemas', () => {
  it('tripSchema requires id, revision >= 1 and updatedAt', () => {
    const ok = { ...trip(), id: tripId, revision: 1, updatedAt: '2026-10-20T09:00:00Z' }
    expect(tripSchema.safeParse(ok).success).toBe(true)
    expect(tripSchema.safeParse({ ...ok, revision: 0 }).success).toBe(false)
    expect(tripSchema.safeParse({ ...ok, id: undefined }).success).toBe(false)
  })

  it('renameSchema requires the name key', () => {
    expect(renameSchema.safeParse({}).success).toBe(false)
    expect(renameSchema.safeParse({ name: null }).success).toBe(true)
    expect(renameSchema.safeParse({ name: 'x' }).success).toBe(true)
  })

  it('createTripBodySchema makes destinations optional and keeps the 200 limit', () => {
    expect(createTripBodySchema.safeParse({}).success).toBe(true)
    expect(createTripBodySchema.safeParse({ name: null }).success).toBe(true)
    expect(createTripBodySchema.parse({ id: tripId, name: 'Trip' })).toMatchObject({ id: tripId, schemaVersion: 1 })
    expect(createTripBodySchema.safeParse({ destinations: Array.from({ length: 201 }, () => dest()) }).success).toBe(false)
    expect(createTripBodySchema.safeParse({ schemaVersion: 2 }).success).toBe(false)
    expect(createTripBodySchema.safeParse({ destinations: null }).success).toBe(false)
  })
})
