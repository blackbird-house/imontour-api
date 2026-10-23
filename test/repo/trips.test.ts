import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTripRepo, DuplicateTripError, type TripRepo } from '../../src/repo/trips.js'
import type { Destination, TripInput } from '../../src/schemas/trip.js'
import { createTestSchema, insertUser, stopTestDatabase } from '../helpers/db.js'

const USER_A = randomUUID()
const USER_B = randomUUID()

function dest(over: Partial<Destination> = {}): Destination {
  return {
    id: randomUUID(),
    rawInput: 'tokyo',
    color: 'coral',
    place: { displayName: 'Tokyo', type: 'city', latitude: 35.68, longitude: 139.69 },
    timing: { mode: 'explicitDates', startDay: '2026-04-01', endDay: '2026-04-05', isPlaceholder: false },
    ...over,
  }
}

function input(over: Partial<TripInput> = {}): TripInput {
  return { schemaVersion: 1, name: 'Trip', destinations: [dest()], ...over }
}

describe('trip repository', () => {
  let ctx: Awaited<ReturnType<typeof createTestSchema>>
  let repo: TripRepo

  beforeAll(async () => {
    ctx = await createTestSchema()
    repo = createTripRepo(ctx.db, ctx.schema)
    // trips.user_id references users.id.
    await insertUser(ctx.db, ctx.schema, USER_A)
    await insertUser(ctx.db, ctx.schema, USER_B)
  })

  afterAll(async () => {
    await ctx.drop()
    await stopTestDatabase()
  })

  it('create then get round-trips destinations incl. unknown color/type/mode and order', async () => {
    const destinations = [
      dest({ color: 'chartreuse-9000', rawInput: 'b' }),
      dest({
        rawInput: 'a',
        place: { displayName: 'Atlantis', type: 'lost-city', latitude: 0, longitude: -1.5, countryCode: null },
        timing: { mode: 'quantum', isPlaceholder: true, targetYear: 2030, targetMonth: 12, durationDays: 3 },
      }),
    ]
    const created = await repo.create(USER_A, input({ destinations }))
    expect(created.revision).toBe(1)
    const got = await repo.get(USER_A, created.id)
    expect(got).toEqual(created)
    expect(got?.destinations).toEqual(destinations)
    expect(got?.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
  })

  it('uses a provided id and stores schemaVersion', async () => {
    const id = randomUUID()
    const created = await repo.create(USER_A, input({ id }))
    expect(created.id).toBe(id)
    expect(created.schemaVersion).toBe(1)
  })

  it('same user creating the same id twice throws DuplicateTripError; other user may reuse it', async () => {
    const id = randomUUID()
    await repo.create(USER_A, input({ id }))
    await expect(repo.create(USER_A, input({ id }))).rejects.toBeInstanceOf(DuplicateTripError)
    const other = await repo.create(USER_B, input({ id }))
    expect(other.id).toBe(id)
  })

  it('get returns null for a missing id', async () => {
    expect(await repo.get(USER_A, randomUUID())).toBeNull()
  })

  it('replace bumps revision to 2 and replaces content; path id wins over body id', async () => {
    const created = await repo.create(USER_A, input({ name: 'old' }))
    const newDests = [dest({ rawInput: 'new' })]
    const res = await repo.replace(
      USER_A,
      created.id,
      1,
      input({ id: randomUUID(), name: 'new', destinations: newDests }),
    )
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') return
    expect(res.trip.id).toBe(created.id)
    expect(res.trip.revision).toBe(2)
    expect(res.trip.name).toBe('new')
    expect(res.trip.destinations).toEqual(newDests)
    expect(await repo.get(USER_A, created.id)).toEqual(res.trip)
  })

  it('replace with wrong revision is stale and leaves the row unchanged', async () => {
    const created = await repo.create(USER_A, input({ name: 'keep' }))
    const res = await repo.replace(USER_A, created.id, 5, input({ name: 'nope' }))
    expect(res).toEqual({ kind: 'stale', currentRevision: 1 })
    expect(await repo.get(USER_A, created.id)).toEqual(created)
  })

  it('replace of a missing id is missing', async () => {
    expect(await repo.replace(USER_A, randomUUID(), 1, input())).toEqual({ kind: 'missing' })
  })

  it('race: two replaces with the same expected revision yield one ok and one stale', async () => {
    const created = await repo.create(USER_A, input())
    const results = await Promise.all([
      repo.replace(USER_A, created.id, 1, input({ name: 'one' })),
      repo.replace(USER_A, created.id, 1, input({ name: 'two' })),
    ])
    const winners = results.filter((r) => r.kind === 'ok')
    expect(winners).toHaveLength(1)
    expect(results.filter((r) => r.kind === 'stale')).toEqual([{ kind: 'stale', currentRevision: 2 }])
    const stored = await repo.get(USER_A, created.id)
    expect(stored?.revision).toBe(2)
    expect(stored?.name).toBe(winners[0]!.kind === 'ok' ? winners[0]!.trip.name : undefined)
  })

  it('rename without expectedRevision applies to any current revision, bumping it and updatedAt', async () => {
    const created = await repo.create(USER_A, input({ name: 'a' }))
    const replaced = await repo.replace(USER_A, created.id, 1, input({ name: 'a2' }))
    expect(replaced.kind).toBe('ok')
    if (replaced.kind !== 'ok') return
    expect(replaced.trip.revision).toBe(2)
    await new Promise((r) => setTimeout(r, 5))
    const res = await repo.rename(USER_A, created.id, 'b')
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') return
    expect(res.trip.name).toBe('b')
    expect(res.trip.revision).toBe(3)
    expect(res.trip.updatedAt > replaced.trip.updatedAt).toBe(true)
    expect(res.trip.destinations).toEqual(replaced.trip.destinations)
  })

  it('rename honors expectedRevision when given', async () => {
    const created = await repo.create(USER_A, input())
    expect(await repo.rename(USER_A, created.id, 'x', 9)).toEqual({ kind: 'stale', currentRevision: 1 })
    const ok = await repo.rename(USER_A, created.id, 'x', 1)
    expect(ok.kind).toBe('ok')
    expect(await repo.rename(USER_A, randomUUID(), 'x', 1)).toEqual({ kind: 'missing' })
    expect(await repo.rename(USER_A, randomUUID(), 'x')).toEqual({ kind: 'missing' })
  })

  it('rename can set the name to null', async () => {
    const created = await repo.create(USER_A, input({ name: 'a' }))
    const res = await repo.rename(USER_A, created.id, null)
    expect(res.kind === 'ok' && res.trip.name).toBeNull()
  })

  it('remove deletes and reports whether a row existed', async () => {
    const created = await repo.create(USER_A, input())
    expect(await repo.remove(USER_A, created.id)).toBe(true)
    expect(await repo.remove(USER_A, created.id)).toBe(false)
    expect(await repo.get(USER_A, created.id)).toBeNull()
  })

  it("another user's trip behaves as missing", async () => {
    const created = await repo.create(USER_A, input({ name: 'private' }))
    expect(await repo.get(USER_B, created.id)).toBeNull()
    expect(await repo.replace(USER_B, created.id, 1, input())).toEqual({ kind: 'missing' })
    expect(await repo.rename(USER_B, created.id, 'x')).toEqual({ kind: 'missing' })
    expect(await repo.remove(USER_B, created.id)).toBe(false)
    expect(await repo.get(USER_A, created.id)).toEqual(created)
  })

  it('round-trips awkward strings exactly', async () => {
    const raw = 'say "hi"\nnew\\line \\n 東京 🗼'
    for (const name of ['', '東京 🗼', raw]) {
      const created = await repo.create(
        USER_A,
        input({
          name,
          destinations: [dest({ rawInput: raw, place: { displayName: raw, type: 'city', latitude: 1, longitude: 2 } })],
        }),
      )
      const got = await repo.get(USER_A, created.id)
      expect(got?.name).toBe(name)
      expect(got?.destinations[0]?.rawInput).toBe(raw)
      expect(got?.destinations[0]?.place.displayName).toBe(raw)
    }
  })

  it('stores an empty destination list and a null name', async () => {
    const created = await repo.create(USER_A, input({ name: null, destinations: [] }))
    expect(created.name).toBeNull()
    expect((await repo.get(USER_A, created.id))?.destinations).toEqual([])
  })

  describe('list', () => {
    it('returns newest first and paginates each trip exactly once', async () => {
      const user = await insertUser(ctx.db, ctx.schema)
      const ids: string[] = []
      for (let i = 0; i < 5; i++) {
        const t = await repo.create(user, input({ name: `t${i}` }))
        ids.push(t.id)
        // Controlled ordering: t0 oldest ... t4 newest; t1 and t2 share a timestamp to exercise the id tiebreak.
        const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i === 2 ? 1 : i))
        await ctx.db`update ${ctx.db(ctx.schema)}.trips set updated_at = ${ts} where user_id = ${user} and id = ${t.id}`
      }

      const seen: string[] = []
      let cursor: { updatedAt: string; id: string } | undefined
      let pages = 0
      for (;;) {
        const page = await repo.list(user, { limit: 2, cursor })
        pages++
        seen.push(...page.items.map((i) => i.id))
        if (page.nextCursor === null) {
          expect(page.items).toHaveLength(1) // 5 trips at limit 2: pages of 2, 2, 1
          break
        }
        expect(page.items).toHaveLength(2)
        cursor = page.nextCursor
      }
      expect(pages).toBe(3)
      expect(new Set(seen).size).toBe(5)
      expect(seen).toHaveLength(5)

      // Order: updated_at desc, id desc.
      const all = await repo.list(user, { limit: 50 })
      expect(all.nextCursor).toBeNull()
      const keys = all.items.map((i) => `${i.updatedAt}|${i.id}`)
      expect(keys).toEqual([...keys].sort().reverse())
      expect(all.items.map((i) => i.id)).toEqual(seen)
      expect(all.items[0]?.name).toBe('t4')
    })

    it('exact-fit page has null nextCursor and summaries are built', async () => {
      const user = await insertUser(ctx.db, ctx.schema)
      await repo.create(
        user,
        input({
          name: 'sum',
          destinations: [
            dest({ place: { displayName: 'A', type: 'city', latitude: 0, longitude: 0 } }),
            dest({ place: { displayName: 'B', type: 'city', latitude: 0, longitude: 0 } }),
          ],
        }),
      )
      const page = await repo.list(user, { limit: 1 })
      expect(page.nextCursor).toBeNull()
      expect(page.items[0]).toMatchObject({
        name: 'sum',
        destinationCount: 2,
        placeNames: ['A', 'B'],
        startDay: '2026-04-01',
        endDay: '2026-04-05',
      })
    })

    it("does not list another user's trips; empty list is fine", async () => {
      const page = await repo.list(await insertUser(ctx.db, ctx.schema), { limit: 10 })
      expect(page).toEqual({ items: [], nextCursor: null })
    })
  })
})
