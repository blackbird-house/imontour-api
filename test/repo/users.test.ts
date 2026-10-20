import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createUserResolver } from '../../src/auth/resolver.js'
import { createTripRepo } from '../../src/repo/trips.js'
import { createUserRepo, type UserRepo } from '../../src/repo/users.js'
import { createTestSchema, stopTestDatabase } from '../helpers/db.js'

const ISSUER = 'https://issuer.test/auth/v1'

describe('user repository', () => {
  let ctx: Awaited<ReturnType<typeof createTestSchema>>
  let users: UserRepo
  let provision: (email?: string) => Promise<string>

  beforeAll(async () => {
    ctx = await createTestSchema()
    users = createUserRepo(ctx.db, ctx.schema)
    const resolve = createUserResolver(ctx.db, ctx.schema)
    provision = (email) => resolve({ issuer: ISSUER, subject: randomUUID(), email })
  })

  afterAll(async () => {
    await ctx.drop()
    await stopTestDatabase()
  })

  it('gets a profile with ISO timestamps, and null for an unknown user', async () => {
    const id = await provision('a@example.com')
    const user = await users.get(id)
    expect(user).toEqual({
      id,
      displayName: null,
      email: 'a@example.com',
      locale: null,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
      updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    })
    expect(await users.get(randomUUID())).toBeNull()
  })

  it('updates only the fields present and bumps updatedAt', async () => {
    const id = await provision()
    const before = (await users.get(id))!
    await new Promise((r) => setTimeout(r, 5))
    const named = await users.update(id, { displayName: 'Ana' })
    expect(named).toMatchObject({ displayName: 'Ana', locale: null })
    expect(named!.updatedAt > before.updatedAt).toBe(true)
    expect(named!.createdAt).toBe(before.createdAt)
    expect(await users.update(id, { locale: 'pt-BR' })).toMatchObject({ displayName: 'Ana', locale: 'pt-BR' })
  })

  it('clears a field with null', async () => {
    const id = await provision()
    await users.update(id, { displayName: 'Ana', locale: 'en' })
    expect(await users.update(id, { displayName: null })).toMatchObject({ displayName: null, locale: 'en' })
  })

  it('returns null when updating an unknown user, and the profile for an empty patch', async () => {
    expect(await users.update(randomUUID(), { displayName: 'x' })).toBeNull()
    const id = await provision()
    expect(await users.update(id, {})).toEqual(await users.get(id))
  })

  it('remove hard-deletes the user, its identities and its trips, returning the identities', async () => {
    const subject = randomUUID()
    const id = await createUserResolver(ctx.db, ctx.schema)({ issuer: ISSUER, subject })
    const trips = createTripRepo(ctx.db, ctx.schema)
    const trip = await trips.create(id, { schemaVersion: 1, name: 'doomed', destinations: [] })
    const other = await provision()
    const otherTrip = await trips.create(other, { schemaVersion: 1, name: 'safe', destinations: [] })

    expect(await users.remove(id)).toEqual([{ issuer: ISSUER, subject }])

    expect(await users.get(id)).toBeNull()
    expect(await trips.get(id, trip.id)).toBeNull()
    const left = await ctx.db`select 1 from ${ctx.db(ctx.schema)}.identities where user_id = ${id}`
    expect(left).toHaveLength(0)
    expect(await trips.get(other, otherTrip.id)).toEqual(otherTrip)
    expect(await users.get(other)).not.toBeNull()
  })

  it('remove returns null for an unknown user', async () => {
    expect(await users.remove(randomUUID())).toBeNull()
  })

  it('refuses trips for a user that does not exist (foreign key)', async () => {
    const trips = createTripRepo(ctx.db, ctx.schema)
    await expect(trips.create(randomUUID(), { schemaVersion: 1, name: 'x', destinations: [] })).rejects.toMatchObject({
      code: '23503',
    })
  })
})
