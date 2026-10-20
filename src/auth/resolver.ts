import { randomUUID } from 'node:crypto'
import type { Db } from '../db/client.js'
import type { Identity } from './verifier.js'

/** Maps a verified identity to our own user id, creating the user on first sight. */
export type ResolveUser = (identity: Identity) => Promise<string>

/**
 * Find-or-create through `identities`. The common case is one indexed read. A
 * first login takes a transaction-scoped advisory lock keyed by the identity, so
 * concurrent first requests for the same (issuer, subject) create exactly one
 * user, and the losers pick up the winner's row. Different identities never wait
 * on each other. The primary key on `identities` is the backstop.
 */
export function createUserResolver(db: Db, schema: string): ResolveUser {
  const users = db(schema)

  return async (identity) => {
    const { issuer, subject } = identity
    const found = await db<{ user_id: string }[]>`
      select user_id from ${users}.identities where issuer = ${issuer} and subject = ${subject}`
    if (found[0]) return found[0].user_id

    return db.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${`${issuer}\n${subject}`}))`
      const raced = await tx<{ user_id: string }[]>`
        select user_id from ${users}.identities where issuer = ${issuer} and subject = ${subject}`
      if (raced[0]) return raced[0].user_id
      const id = randomUUID()
      await tx`insert into ${users}.users (id, email) values (${id}, ${identity.email ?? null})`
      await tx`insert into ${users}.identities (issuer, subject, user_id)
               values (${issuer}, ${subject}, ${id})`
      return id
    })
  }
}
