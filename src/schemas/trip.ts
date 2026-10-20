import { z } from '@hono/zod-openapi'

export const CURRENT_SCHEMA_VERSION = 1
export const MAX_DESTINATIONS = 200

function isRealDay(value: string): boolean {
  const [y, m, d] = value.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

/** A UTF-16 surrogate without its pair (with the `u` flag a valid pair is one non-surrogate code point). */
const LONE_SURROGATE = /\p{Cs}/u

/**
 * Any string Postgres can store: no NUL (rejected by text and jsonb) and no
 * unpaired surrogate (rejected by jsonb, silently replaced in text). Used for
 * every client-supplied string so such input is a 422, never a 500.
 */
export const text = z.string().refine((s) => !s.includes('\u0000') && !LONE_SURROGATE.test(s), 'Contains a NUL or unpaired surrogate')

/** yyyy-MM-dd calendar day with no time or zone. */
export const dayString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a day formatted yyyy-MM-dd')
  .refine(isRealDay, 'Not a real calendar day')
  .openapi({ description: 'Calendar day, yyyy-MM-dd, no time or zone.', example: '2026-04-01' })

export const placeSchema = z
  .object({
    displayName: text.openapi({ example: 'Tokyo' }),
    type: text.min(1).openapi({
      description: 'Known values: city, country, region. Any non-empty string is accepted.',
      example: 'city',
    }),
    latitude: z.number().min(-90).max(90).openapi({ example: 35.68 }),
    longitude: z.number().min(-180).max(180).openapi({ example: 139.69 }),
    geocodeSourceID: text.nullish(),
    countryCode: text.nullish().openapi({ example: 'JP' }),
  })
  .openapi('Place')

export const timingSchema = z
  .object({
    mode: text.min(1).openapi({
      description: 'Known values: explicitDates, durationOnly, fuzzyMonth. Any non-empty string is accepted.',
      example: 'explicitDates',
    }),
    startDay: dayString.nullish(),
    endDay: dayString.nullish(),
    durationDays: z.number().int().min(1).nullish().openapi({ example: 5 }),
    targetYear: z.number().int().nullish(),
    targetMonth: z.number().int().min(1).max(12).nullish(),
    isPlaceholder: z.boolean(),
  })
  .openapi('Timing')

export const destinationSchema = z
  .object({
    id: z.uuid(),
    rawInput: text,
    color: text.min(1).openapi({
      description: 'Palette color name. Known values: coral, amber, lime, teal, sky, indigo, violet, rose. Any non-empty string is accepted.',
      example: 'coral',
    }),
    place: placeSchema,
    timing: timingSchema,
  })
  .openapi('Destination')

const nameField = text.nullish().openapi({ description: 'Trip name. May be empty or null.' })

export const tripInputSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION).default(CURRENT_SCHEMA_VERSION),
    id: z.uuid().optional(),
    name: nameField,
    destinations: z.array(destinationSchema).max(MAX_DESTINATIONS),
  })
  .openapi('TripInput')

export const newTripNameOnlySchema = z
  .object({ name: nameField })
  .openapi('NewTripNameOnly')

export const tripSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    id: z.uuid(),
    name: z.string().nullable(),
    revision: z.number().int().min(1),
    updatedAt: z.iso.datetime().openapi({ example: '2026-10-20T09:00:00Z' }),
    destinations: z.array(destinationSchema),
  })
  .openapi('Trip')

export const tripSummarySchema = z
  .object({
    id: z.uuid(),
    name: z.string().nullable(),
    destinationCount: z.number().int().min(0),
    placeNames: z.array(z.string()),
    startDay: dayString.nullable(),
    endDay: dayString.nullable(),
    updatedAt: z.iso.datetime(),
  })
  .openapi('TripSummary')

export const tripListSchema = z
  .object({
    items: z.array(tripSummarySchema),
    nextCursor: z.string().nullable(),
  })
  .openapi('TripList')

export const renameSchema = z
  .object({ name: text.nullable() })
  .openapi('Rename')

export const errorSchema = z
  .object({ error: z.object({ code: z.string(), message: z.string() }) })
  .openapi('Error')

export type Trip = z.infer<typeof tripSchema>
export type TripInput = z.infer<typeof tripInputSchema>
export type TripSummary = z.infer<typeof tripSummarySchema>
export type Destination = z.infer<typeof destinationSchema>
