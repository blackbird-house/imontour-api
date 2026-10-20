import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createUserResolver, type ResolveUser } from '../../src/auth/resolver.js'
import { createTestSchema, stopTestDatabase } from '../helpers/db.js'

const ISSUER = 'https://issuer.test/auth/v1'

describe('user resolver', () => {
  let ctx: Awaited<ReturnType<typeof createTestSchema>>
  let resolve: ResolveUser
  const q = () => ctx.db(ctx.schema)
  const count = async (table: 'users' | 'identities') =>
    (await ctx.db<{ n: number }[]>`select count(*)::int as n from ${q()}.${ctx.db(table)}`)[0]!.n

  beforeAll(async () => {
    ctx = await createTestSchema()
    resolve = createUserResolver(ctx.db, ctx.schema)
  })

  afterAll(async () => {
    await ctx.drop()
    await stopTestDatabase()
  })

  it('provisions a user on first sight, copying the email', async () => {
    const subject = randomUUID()
    const id = await resolve({ issuer: ISSUER, subject, email: 'a@example.com' })
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(id).not.toBe(subject)
    const [user] = await ctx.db<{ email: string | null; display_name: string | null }[]>`
      select email, display_name from ${q()}.users where id = ${id}`
    expect(user).toEqual({ email: 'a@example.com', display_name: null })
  })

  it('resolves the same identity to the same user, without creating more rows', async () => {
    const identity = { issuer: ISSUER, subject: randomUUID() }
    const first = await resolve(identity)
    const users = await count('users')
    const identities = await count('identities')
    expect(await resolve(identity)).toBe(first)
    // A later token with a different email does not change or duplicate anything.
    expect(await resolve({ ...identity, email: 'new@example.com' })).toBe(first)
    expect(await count('users')).toBe(users)
    expect(await count('identities')).toBe(identities)
  })

  it('gives different users to different subjects and to the same subject under another issuer', async () => {
    const subject = randomUUID()
    const a = await resolve({ issuer: ISSUER, subject })
    const b = await resolve({ issuer: ISSUER, subject: randomUUID() })
    const c = await resolve({ issuer: 'https://other.test', subject })
    expect(new Set([a, b, c]).size).toBe(3)
  })

  it('never links accounts by email', async () => {
    const a = await resolve({ issuer: ISSUER, subject: randomUUID(), email: 'same@example.com' })
    const b = await resolve({ issuer: 'https://other.test', subject: randomUUID(), email: 'same@example.com' })
    expect(a).not.toBe(b)
  })

  it('creates exactly one user for many concurrent first requests', async () => {
    const identity = { issuer: ISSUER, subject: randomUUID() }
    const users = await count('users')
    const ids = await Promise.all(Array.from({ length: 12 }, () => resolve(identity)))
    expect(new Set(ids).size).toBe(1)
    expect(await count('users')).toBe(users + 1)
    const rows =
      await ctx.db`select 1 from ${q()}.identities where issuer = ${identity.issuer} and subject = ${identity.subject}`
    expect(rows).toHaveLength(1)
  })

  it('handles concurrent first requests for different identities independently', async () => {
    const identities = Array.from({ length: 6 }, () => ({ issuer: ISSUER, subject: randomUUID() }))
    const users = await count('users')
    const ids = await Promise.all(identities.flatMap((i) => [resolve(i), resolve(i)]))
    expect(new Set(ids).size).toBe(6)
    expect(await count('users')).toBe(users + 6)
  })

  it('stores subjects with quotes and unicode verbatim', async () => {
    const identity = { issuer: ISSUER, subject: `o'brien "ü" 🌍\n` }
    const id = await resolve(identity)
    expect(await resolve(identity)).toBe(id)
  })
})
