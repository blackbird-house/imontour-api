import type { Db } from '../db/client.js'
import type { Identity } from '../auth/verifier.js'
import type { UpdateUser, User } from '../schemas/user.js'

export interface UserRepo {
  get(id: string): Promise<User | null>
  /** Applies only the fields present (`null` clears). Null when the user does not exist. */
  update(id: string, patch: UpdateUser): Promise<User | null>
  /**
   * Hard-deletes the user; trips and identities cascade. Returns the identities
   * that were linked (so the caller can clean up at the provider), or null when
   * the user does not exist.
   */
  remove(id: string): Promise<Identity[] | null>
}

type UserRow = {
  id: string
  display_name: string | null
  email: string | null
  locale: string | null
  created_at: Date
  updated_at: Date
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    locale: row.locale,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

export function createUserRepo(db: Db, schema: string): UserRepo {
  const s = db(schema)

  async function get(id: string): Promise<User | null> {
    const rows = await db<UserRow[]>`
      select id, display_name, email, locale, created_at, updated_at from ${s}.users where id = ${id}`
    return rows[0] ? toUser(rows[0]) : null
  }

  return {
    get,

    async update(id, patch) {
      const changes: Record<string, string | null> = {}
      if (patch.displayName !== undefined) changes.display_name = patch.displayName
      if (patch.locale !== undefined) changes.locale = patch.locale
      if (Object.keys(changes).length === 0) return get(id)
      const rows = await db<UserRow[]>`
        update ${s}.users set ${db(changes)}, updated_at = now() where id = ${id}
        returning id, display_name, email, locale, created_at, updated_at`
      return rows[0] ? toUser(rows[0]) : null
    },

    async remove(id) {
      return db.begin(async (tx) => {
        const identities = await tx<{ issuer: string; subject: string }[]>`
          select issuer, subject from ${s}.identities where user_id = ${id}`
        const gone = await tx`delete from ${s}.users where id = ${id} returning id`
        if (gone.length === 0) return null
        return identities.map(({ issuer, subject }) => ({ issuer, subject }))
      })
    },
  }
}
