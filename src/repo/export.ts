import type { Db } from '../db/client.js'

export type UserExport = {
  user: {
    id: string
    displayName: string | null
    email: string | null
    locale: string | null
    createdAt: string
    updatedAt: string
  }
  identities: { issuer: string; subject: string; createdAt: string }[]
  trips: {
    id: string
    name: string | null
    schemaVersion: number
    revision: number
    destinations: unknown
    createdAt: string
    updatedAt: string
  }[]
}

/** Everything we hold about a person, for answering a data-access request. Operator use only. */
export interface ExportRepo {
  /** Every user whose email matches (case-insensitive), with identities and full trip documents. Empty when none. */
  findByEmail(email: string): Promise<UserExport[]>
}

type UserRow = {
  id: string
  display_name: string | null
  email: string | null
  locale: string | null
  created_at: Date
  updated_at: Date
}
type IdentityRow = { issuer: string; subject: string; created_at: Date }
type TripRow = {
  id: string
  name: string | null
  schema_version: number
  revision: number
  destinations: unknown
  created_at: Date
  updated_at: Date
}

export function createExportRepo(db: Db, schema: string): ExportRepo {
  const s = db(schema)
  return {
    async findByEmail(email) {
      const users = await db<UserRow[]>`
        select id, display_name, email, locale, created_at, updated_at
        from ${s}.users where lower(email) = lower(${email}) order by created_at`
      return Promise.all(
        users.map(async (u) => {
          const identities = await db<IdentityRow[]>`
            select issuer, subject, created_at from ${s}.identities where user_id = ${u.id} order by created_at`
          const trips = await db<TripRow[]>`
            select id, name, schema_version, revision, destinations, created_at, updated_at
            from ${s}.trips where user_id = ${u.id} order by created_at, id`
          return {
            user: {
              id: u.id,
              displayName: u.display_name,
              email: u.email,
              locale: u.locale,
              createdAt: u.created_at.toISOString(),
              updatedAt: u.updated_at.toISOString(),
            },
            identities: identities.map((i) => ({
              issuer: i.issuer,
              subject: i.subject,
              createdAt: i.created_at.toISOString(),
            })),
            trips: trips.map((t) => ({
              id: t.id,
              name: t.name,
              schemaVersion: t.schema_version,
              revision: t.revision,
              destinations: t.destinations,
              createdAt: t.created_at.toISOString(),
              updatedAt: t.updated_at.toISOString(),
            })),
          }
        }),
      )
    },
  }
}
