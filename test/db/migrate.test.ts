import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, runMigrations } from '../../src/db/client.js'
import { createTestSchema, insertUser, stopTestDatabase } from '../helpers/db.js'
import { TEST_ISSUER } from '../helpers/tokens.js'

const ISSUER = 'https://issuer.test/auth/v1'

describe('runMigrations', () => {
  let ctx: Awaited<ReturnType<typeof createTestSchema>>

  beforeAll(async () => {
    ctx = await createTestSchema({ migrate: false })
  })

  afterAll(async () => {
    await ctx.drop()
    await stopTestDatabase()
  })

  it('applies every migration once and is idempotent', async () => {
    expect(await runMigrations(ctx.db, ctx.schema, { authIssuer: ISSUER })).toEqual(['001_trips.sql', '002_users.sql'])
    expect(await runMigrations(ctx.db, ctx.schema, { authIssuer: ISSUER })).toEqual([])
  })

  it('creates trips with PK (user_id, id)', async () => {
    const rows = await ctx.db<{ attname: string }[]>`
      select a.attname
      from pg_index i
      join pg_class c on c.oid = i.indrelid
      join pg_namespace n on n.oid = c.relnamespace
      join lateral unnest(i.indkey) with ordinality as k(attnum, ord) on true
      join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
      where i.indisprimary and n.nspname = ${ctx.schema} and c.relname = 'trips'
      order by k.ord`
    expect(rows.map((r) => r.attname)).toEqual(['user_id', 'id'])
  })

  it('creates the (user_id, updated_at desc, id desc) index', async () => {
    const rows = await ctx.db<{ indexdef: string }[]>`
      select indexdef from pg_indexes
      where schemaname = ${ctx.schema} and tablename = 'trips' and indexname not like '%pkey'`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.indexdef).toMatch(/\(user_id, updated_at DESC, id DESC\)/)
  })

  it('rejects unsafe schema names', async () => {
    await expect(runMigrations(ctx.db, 'x"; drop schema public; --', { authIssuer: ISSUER })).rejects.toThrow(
      /invalid schema/i,
    )
  })
})

describe('002_users.sql', () => {
  let ctx: Awaited<ReturnType<typeof createTestSchema>>
  const q = () => ctx.db(ctx.schema)

  beforeAll(async () => {
    ctx = await createTestSchema({ migrate: false })
  })

  afterAll(async () => {
    await ctx.drop()
    await stopTestDatabase()
  })

  it('refuses to run without an auth issuer', async () => {
    await expect(runMigrations(ctx.db, ctx.schema)).rejects.toThrow(/auth issuer/i)
    // 001 was applied in its own transaction before 002 failed.
    const [{ n }] = await ctx.db<{ n: number }[]>`select count(*)::int as n from ${q()}.schema_migrations`
    expect(n).toBe(1)
  })

  it('backfills one user and one identity per distinct trips.user_id, keeping the id', async () => {
    const a = randomUUID()
    const b = randomUUID()
    const trip = (user: string) => ctx.db`
      insert into ${q()}.trips (user_id, id, schema_version, revision, destinations, created_at, updated_at)
      values (${user}, ${randomUUID()}, 1, 1, '[]'::jsonb, now(), now())`
    await trip(a)
    await trip(a)
    await trip(b)

    // The issuer is quoted, so a quote in it cannot break out of the literal.
    const issuer = "https://issuer.test/o'brien"
    expect(await runMigrations(ctx.db, ctx.schema, { authIssuer: issuer })).toEqual(['002_users.sql'])

    const users = await ctx.db<{ id: string }[]>`select id from ${q()}.users order by id`
    expect(users.map((u) => u.id)).toEqual([a, b].sort())
    const identities = await ctx.db<{ issuer: string; subject: string; user_id: string }[]>`
      select issuer, subject, user_id from ${q()}.identities order by user_id`
    expect(identities).toEqual([a, b].sort().map((id) => ({ issuer, subject: id, user_id: id })))
  })
})

// Each test below builds its own rows on a freshly migrated schema, so none
// depends on what an earlier test left behind or on row order.
describe('002_users.sql constraints', () => {
  let ctx: Awaited<ReturnType<typeof createTestSchema>>
  const q = () => ctx.db(ctx.schema)

  beforeAll(async () => {
    ctx = await createTestSchema()
  })

  afterAll(async () => {
    await ctx.drop()
    await stopTestDatabase()
  })

  const insertTrip = (user: string) => ctx.db`
    insert into ${q()}.trips (user_id, id, schema_version, revision, destinations, created_at, updated_at)
    values (${user}, ${randomUUID()}, 1, 1, '[]'::jsonb, now(), now())`

  it('adds the trips -> users foreign key with cascade', async () => {
    await expect(insertTrip(randomUUID())).rejects.toMatchObject({ code: '23503' })

    const id = await insertUser(ctx.db, ctx.schema)
    await ctx.db`insert into ${q()}.identities (issuer, subject, user_id) values (${TEST_ISSUER}, ${randomUUID()}, ${id})`
    await insertTrip(id)

    await ctx.db`delete from ${q()}.users where id = ${id}`
    expect(await ctx.db`select 1 from ${q()}.trips where user_id = ${id}`).toHaveLength(0)
    expect(await ctx.db`select 1 from ${q()}.identities where user_id = ${id}`).toHaveLength(0)
  })

  it('keys identities by (issuer, subject)', async () => {
    const first = await insertUser(ctx.db, ctx.schema)
    const second = await insertUser(ctx.db, ctx.schema)
    const subject = randomUUID()
    await ctx.db`insert into ${q()}.identities (issuer, subject, user_id) values (${TEST_ISSUER}, ${subject}, ${first})`

    const dup = ctx.db`insert into ${q()}.identities (issuer, subject, user_id) values (${TEST_ISSUER}, ${subject}, ${second})`
    await expect(dup).rejects.toMatchObject({ code: '23505' })
  })
})

describe('createDb', () => {
  it('sets a 10 s connect timeout and keeps prepare off, without connecting', async () => {
    const db = createDb('postgres://u:p@db.invalid:5432/app')
    try {
      expect(db.options.connect_timeout).toBe(10)
      expect(db.options.prepare).toBe(false)
    } finally {
      await db.end({ timeout: 0 })
    }
  })
})
