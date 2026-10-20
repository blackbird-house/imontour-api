import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from '../../src/db/client.js'
import { createTestSchema, stopTestDatabase } from '../helpers/db.js'

describe('runMigrations', () => {
  let ctx: Awaited<ReturnType<typeof createTestSchema>>

  beforeAll(async () => {
    ctx = await createTestSchema({ migrate: false })
  })

  afterAll(async () => {
    await ctx.drop()
    await stopTestDatabase()
  })

  it('applies 001_trips.sql once and is idempotent', async () => {
    expect(await runMigrations(ctx.db, ctx.schema)).toEqual(['001_trips.sql'])
    expect(await runMigrations(ctx.db, ctx.schema)).toEqual([])
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
    await expect(runMigrations(ctx.db, 'x"; drop schema public; --')).rejects.toThrow(/invalid schema/i)
  })
})
