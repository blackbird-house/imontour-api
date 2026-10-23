import { randomUUID } from 'node:crypto'
import type { Db } from '../db/client.js'
import { summarize } from '../domain/summary.js'
import type { Cursor } from '../http/cursor.js'
import type { Destination, Trip, TripInput, TripSummary } from '../schemas/trip.js'

export type WriteResult = { kind: 'ok'; trip: Trip } | { kind: 'stale'; currentRevision: number } | { kind: 'missing' }

export interface TripRepo {
  list(
    userId: string,
    opts: { limit: number; cursor?: Cursor },
  ): Promise<{ items: TripSummary[]; nextCursor: Cursor | null }>
  get(userId: string, id: string): Promise<Trip | null>
  create(userId: string, input: TripInput): Promise<Trip>
  replace(userId: string, id: string, expectedRevision: number, input: TripInput): Promise<WriteResult>
  rename(userId: string, id: string, name: string | null, expectedRevision?: number): Promise<WriteResult>
  remove(userId: string, id: string): Promise<boolean>
}

export class DuplicateTripError extends Error {
  constructor(message = 'Trip already exists') {
    super(message)
    this.name = 'DuplicateTripError'
  }
}

type TripRow = {
  id: string
  name: string | null
  schema_version: number
  revision: number
  destinations: Destination[]
  updated_at: Date
}

type SummaryRow = Pick<TripRow, 'id' | 'name' | 'destinations' | 'updated_at'>

const UNIQUE_VIOLATION = '23505'

function toTrip(row: TripRow): Trip {
  return {
    schemaVersion: row.schema_version as Trip['schemaVersion'],
    id: row.id,
    name: row.name,
    revision: row.revision,
    updatedAt: row.updated_at.toISOString(),
    destinations: row.destinations,
  }
}

export function createTripRepo(db: Db, schema: string): TripRepo {
  const schemaId = db(schema)

  async function currentRevision(userId: string, id: string): Promise<number | null> {
    const rows = await db<{ revision: number }[]>`
      select revision from ${schemaId}.trips where user_id = ${userId} and id = ${id}`
    return rows[0]?.revision ?? null
  }

  async function staleOrMissing(userId: string, id: string): Promise<WriteResult> {
    const revision = await currentRevision(userId, id)
    return revision === null ? { kind: 'missing' } : { kind: 'stale', currentRevision: revision }
  }

  return {
    async list(userId, { limit, cursor }) {
      const keyset = cursor ? db`and (updated_at, id) < (${new Date(cursor.updatedAt)}, ${cursor.id})` : db``
      const rows = await db<SummaryRow[]>`
        select id, name, destinations, updated_at
        from ${schemaId}.trips
        where user_id = ${userId} ${keyset}
        order by updated_at desc, id desc
        limit ${limit + 1}`
      const page = rows.slice(0, limit)
      const items = page.map((r) =>
        summarize({
          id: r.id,
          name: r.name,
          destinations: r.destinations,
          updatedAt: r.updated_at.toISOString(),
        }),
      )
      const last = page[page.length - 1]
      const nextCursor = rows.length > limit && last ? { updatedAt: last.updated_at.toISOString(), id: last.id } : null
      return { items, nextCursor }
    },

    async get(userId, id) {
      const rows = await db<TripRow[]>`
        select id, name, schema_version, revision, destinations, updated_at
        from ${schemaId}.trips where user_id = ${userId} and id = ${id}`
      return rows[0] ? toTrip(rows[0]) : null
    },

    async create(userId, input) {
      const id = input.id ?? randomUUID()
      const now = new Date()
      try {
        // `as never` (here and in replace): postgres.js types db.json() too narrowly for
        // our typed objects; a typing gap in the library, the value is plain JSON.
        const rows = await db<TripRow[]>`
          insert into ${schemaId}.trips
            (user_id, id, name, schema_version, revision, destinations, created_at, updated_at)
          values
            (${userId}, ${id}, ${input.name ?? null}, ${input.schemaVersion}, 1,
             ${db.json(input.destinations as never)}, ${now}, ${now})
          returning id, name, schema_version, revision, destinations, updated_at`
        return toTrip(rows[0]!)
      } catch (err) {
        if ((err as { code?: string }).code === UNIQUE_VIOLATION) throw new DuplicateTripError()
        throw err
      }
    },

    async replace(userId, id, expectedRevision, input) {
      // `as never`: see create().
      const rows = await db<TripRow[]>`
        update ${schemaId}.trips
        set name = ${input.name ?? null},
            schema_version = ${input.schemaVersion},
            destinations = ${db.json(input.destinations as never)},
            revision = revision + 1,
            updated_at = ${new Date()}
        where user_id = ${userId} and id = ${id} and revision = ${expectedRevision}
        returning id, name, schema_version, revision, destinations, updated_at`
      if (rows[0]) return { kind: 'ok', trip: toTrip(rows[0]) }
      return staleOrMissing(userId, id)
    },

    async rename(userId, id, name, expectedRevision) {
      const guard = expectedRevision === undefined ? db`` : db`and revision = ${expectedRevision}`
      const rows = await db<TripRow[]>`
        update ${schemaId}.trips
        set name = ${name},
            revision = revision + 1,
            updated_at = ${new Date()}
        where user_id = ${userId} and id = ${id} ${guard}
        returning id, name, schema_version, revision, destinations, updated_at`
      if (rows[0]) return { kind: 'ok', trip: toTrip(rows[0]) }
      return staleOrMissing(userId, id)
    },

    async remove(userId, id) {
      const rows = await db`delete from ${schemaId}.trips where user_id = ${userId} and id = ${id} returning id`
      return rows.length > 0
    },
  }
}
