import type { Trip, TripSummary } from '../schemas/trip.js'

const MAX_PLACE_NAMES = 3

/**
 * Builds the list-view summary of a trip. Pure: never reorders or derives
 * anything. startDay/endDay are the lexicographic min/max (valid yyyy-MM-dd
 * strings sort chronologically) over every destination's non-null
 * startDay/endDay respectively.
 */
export function summarize(
  t: Pick<Trip, 'id' | 'name' | 'updatedAt' | 'destinations'>,
): TripSummary {
  let startDay: string | null = null
  let endDay: string | null = null
  for (const d of t.destinations) {
    const s = d.timing.startDay
    const e = d.timing.endDay
    if (s != null && (startDay === null || s < startDay)) startDay = s
    if (e != null && (endDay === null || e > endDay)) endDay = e
  }
  return {
    id: t.id,
    name: t.name,
    destinationCount: t.destinations.length,
    placeNames: t.destinations.slice(0, MAX_PLACE_NAMES).map((d) => d.place.displayName),
    startDay,
    endDay,
    updatedAt: t.updatedAt,
  }
}
