import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import { authUnavailable } from '../../src/auth/verifier.js'
import { encodeCursor } from '../../src/http/cursor.js'
import type { TripRepo } from '../../src/repo/trips.js'
import { createTestApp, stubDeps } from '../helpers/app.js'
import { TEST_USER_ID } from '../helpers/tokens.js'

type TestApp = Awaited<ReturnType<typeof createTestApp>>
type Json = Record<string, unknown>

const USER_A = TEST_USER_ID
const USER_B = '22222222-2222-4222-8222-222222222222'

function destination(overrides: Json = {}): Json {
  return {
    id: randomUUID(),
    rawInput: 'Tokyo "in spring"\nmaybe',
    color: 'coral',
    place: {
      displayName: 'Tokyo',
      type: 'city',
      latitude: 35.68,
      longitude: 139.69,
      geocodeSourceID: null,
      countryCode: 'JP',
    },
    timing: {
      mode: 'explicitDates',
      startDay: '2026-04-01',
      endDay: '2026-04-05',
      durationDays: null,
      targetYear: null,
      targetMonth: null,
      isPlaceholder: false,
    },
    ...overrides,
  }
}

function unknownValuesDestination(): Json {
  return destination({
    color: 'chartreuse',
    place: {
      displayName: 'Koh Lanta',
      type: 'island',
      latitude: 7.6,
      longitude: 99.05,
      geocodeSourceID: 'gn:123',
      countryCode: null,
    },
    timing: {
      mode: 'sabbatical',
      startDay: null,
      endDay: null,
      durationDays: 12,
      targetYear: 2027,
      targetMonth: 3,
      isPlaceholder: true,
    },
  })
}

const SUMMARY_KEYS = ['destinationCount', 'endDay', 'id', 'name', 'placeNames', 'startDay', 'updatedAt']

let t: TestApp

beforeAll(async () => {
  t = await createTestApp()
})

afterAll(async () => {
  await t.stop()
})

async function body(res: Response): Promise<Json> {
  return (await res.json()) as Json
}

async function createTrip(as: string, json: unknown = { name: 'Trip' }): Promise<Json> {
  const res = await t.request('/v1/trips', { method: 'POST', as, json })
  expect(res.status).toBe(201)
  return body(res)
}

function expectJson(res: Response) {
  expect(res.headers.get('content-type')).toBe('application/json')
}

async function expectError(res: Response, status: number, code: string): Promise<Json> {
  expect(res.status).toBe(status)
  expectJson(res)
  const b = await body(res)
  expect(b.error).toMatchObject({ code })
  expect(typeof (b.error as Json).message).toBe('string')
  return b
}

describe('POST /v1/trips', () => {
  it('creates an empty trip from a name-only body', async () => {
    const res = await t.request('/v1/trips', { method: 'POST', as: USER_A, json: { name: 'Japan' } })
    expect(res.status).toBe(201)
    expectJson(res)
    const trip = await body(res)
    expect(trip).toMatchObject({ schemaVersion: 1, name: 'Japan', revision: 1, destinations: [] })
    expect(trip.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(typeof trip.updatedAt).toBe('string')
    expect(res.headers.get('etag')).toBe('"1"')
    expect(res.headers.get('location')).toBe(`/v1/trips/${trip.id as string}`)
  })

  it('creates an unnamed trip from an empty body object', async () => {
    const trip = await createTrip(USER_A, {})
    expect(trip).toMatchObject({ name: null, destinations: [], revision: 1 })
  })

  it('keeps the client id and destination ids for a full trip, in array order', async () => {
    const id = randomUUID()
    const destinations = [
      destination({ color: 'teal' }),
      destination({ color: 'amber' }),
      destination({ color: 'rose' }),
    ]
    const res = await t.request('/v1/trips', {
      method: 'POST',
      as: USER_A,
      json: { schemaVersion: 1, id, name: 'Full', destinations },
    })
    expect(res.status).toBe(201)
    const trip = await body(res)
    expect(trip.id).toBe(id)
    expect(trip.destinations).toEqual(destinations)
    expect(res.headers.get('location')).toBe(`/v1/trips/${id}`)
    expect(res.headers.get('etag')).toBe('"1"')
  })

  it('treats {name, destinations: []} as a full trip (client id kept)', async () => {
    const id = randomUUID()
    const trip = await createTrip(USER_A, { id, name: 'x', destinations: [] })
    expect(trip).toMatchObject({ id, name: 'x', destinations: [] })
  })

  it('keeps the client id in a body without destinations (empty trip)', async () => {
    const id = randomUUID()
    const trip = await createTrip(USER_A, { id, name: 'no dests' })
    expect(trip).toMatchObject({ id, name: 'no dests', destinations: [] })
  })

  it('rejects schemaVersion 2 in a body without destinations with 422', async () => {
    const res = await t.request('/v1/trips', { method: 'POST', as: USER_A, json: { schemaVersion: 2, name: 'x' } })
    const b = await expectError(res, 422, 'unprocessable')
    expect((b.error as Json).message).toMatch(/^schemaVersion/)
  })

  it('validates destinations when the key is present', async () => {
    const res = await t.request('/v1/trips', {
      method: 'POST',
      as: USER_A,
      json: { name: 'x', destinations: [destination({ color: '' })] },
    })
    const b = await expectError(res, 422, 'unprocessable')
    expect((b.error as Json).message).toContain('destinations.0.color')
  })

  it('rejects a non-array destinations with 422', async () => {
    const res = await t.request('/v1/trips', {
      method: 'POST',
      as: USER_A,
      json: { name: 'x', destinations: 'nope' },
    })
    const b = await expectError(res, 422, 'unprocessable')
    expect((b.error as Json).message).toMatch(/^destinations/)
  })

  it('rejects a name of the wrong type with 422 naming the path', async () => {
    const res = await t.request('/v1/trips', { method: 'POST', as: USER_A, json: { name: 5 } })
    const b = await expectError(res, 422, 'unprocessable')
    expect((b.error as Json).message).toMatch(/^name/)
  })

  it('rejects schemaVersion above the known version with 422', async () => {
    const res = await t.request('/v1/trips', {
      method: 'POST',
      as: USER_A,
      json: { schemaVersion: 2, destinations: [] },
    })
    const b = await expectError(res, 422, 'unprocessable')
    expect((b.error as Json).message).toMatch(/^schemaVersion/)
  })

  it('rejects 201 destinations with 422', async () => {
    const destinations = Array.from({ length: 201 }, () => destination())
    const res = await t.request('/v1/trips', { method: 'POST', as: USER_A, json: { destinations } })
    const b = await expectError(res, 422, 'unprocessable')
    expect((b.error as Json).message).toMatch(/^destinations/)
  })

  it('rejects malformed JSON with 400', async () => {
    const res = await t.request('/v1/trips', {
      method: 'POST',
      as: USER_A,
      headers: { 'Content-Type': 'application/json' },
      body: '{"name": ',
    })
    await expectError(res, 400, 'bad_request')
  })

  it('treats a request with no Content-Type and no body as {} (201 empty trip, no server error)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await t.request('/v1/trips', { method: 'POST', as: USER_A })
      expect(res.status).toBe(201)
      expectJson(res)
      const trip = await body(res)
      expect(trip).toMatchObject({ name: null, destinations: [], revision: 1 })
      expect(res.headers.get('etag')).toBe('"1"')
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('rejects destinations: null with 422 naming destinations', async () => {
    const res = await t.request('/v1/trips', { method: 'POST', as: USER_A, json: { destinations: null } })
    const b = await expectError(res, 422, 'unprocessable')
    expect((b.error as Json).message).toMatch(/^destinations/)
  })

  it('rejects a non-JSON content type with 415', async () => {
    const res = await t.request('/v1/trips', {
      method: 'POST',
      as: USER_A,
      headers: { 'Content-Type': 'text/plain' },
      body: '{"name":"x"}',
    })
    await expectError(res, 415, 'unsupported_media_type')
  })

  it('rejects a JSON body that is not an object with 422', async () => {
    const res = await t.request('/v1/trips', { method: 'POST', as: USER_A, json: [1, 2] })
    await expectError(res, 422, 'unprocessable')
  })

  it('rejects a body over 1 MB with 413', async () => {
    const res = await t.request('/v1/trips', {
      method: 'POST',
      as: USER_A,
      json: { name: 'x'.repeat(1024 * 1024 + 1) },
    })
    await expectError(res, 413, 'payload_too_large')
  })

  it('rejects a duplicate id for the same user with 409, but not for another user', async () => {
    const id = randomUUID()
    await createTrip(USER_A, { id, destinations: [] })
    const dup = await t.request('/v1/trips', { method: 'POST', as: USER_A, json: { id, destinations: [] } })
    await expectError(dup, 409, 'conflict')
    const other = await t.request('/v1/trips', { method: 'POST', as: USER_B, json: { id, destinations: [] } })
    expect(other.status).toBe(201)
  })

  it('drops unknown fields at the top level and inside destinations', async () => {
    const d = destination()
    const trip = await createTrip(USER_A, {
      name: 'x',
      foo: 'bar',
      revision: 99,
      updatedAt: '2000-01-01T00:00:00Z',
      destinations: [{ ...d, extra: true, place: { ...(d.place as Json), bogus: 1 } }],
    })
    expect(trip).not.toHaveProperty('foo')
    expect(trip.revision).toBe(1)
    expect(trip.updatedAt).not.toBe('2000-01-01T00:00:00Z')
    expect(trip.destinations).toEqual([d])
  })
})

describe('text Postgres cannot store', () => {
  it.each([
    ['a NUL in name', { name: 'a\u0000b' }, /^name/],
    ['a lone surrogate in name', { name: 'a\ud800b' }, /^name/],
    ['a NUL in rawInput', { destinations: [destination({ rawInput: 'a\u0000b' })] }, /^destinations\.0\.rawInput/],
    ['a lone surrogate in rawInput', { destinations: [destination({ rawInput: '\ud800' })] }, /^destinations\.0\.rawInput/],
  ])('POST with %s is 422 naming the path, never a server error', async (_label, json, path) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await t.request('/v1/trips', { method: 'POST', as: USER_A, json })
      const b = await expectError(res, 422, 'unprocessable')
      expect((b.error as Json).message).toMatch(path)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('PATCH with a NUL in name is 422', async () => {
    const created = await createTrip(USER_A)
    const res = await t.request(`/v1/trips/${created.id as string}`, {
      method: 'PATCH',
      as: USER_A,
      json: { name: 'x\u0000' },
    })
    const b = await expectError(res, 422, 'unprocessable')
    expect((b.error as Json).message).toMatch(/^name/)
  })

  it('keeps a well-formed surrogate pair (emoji) unchanged', async () => {
    const trip = await createTrip(USER_A, { name: 'Trip \u{1F5FE}', destinations: [destination({ rawInput: '\u{1F30F}' })] })
    expect(trip.name).toBe('Trip \u{1F5FE}')
    expect((trip.destinations as Json[])[0]!.rawInput).toBe('\u{1F30F}')
  })
})

describe('unknown enum-like values', () => {
  it('round-trip unchanged through POST, GET and PUT', async () => {
    const destinations = [unknownValuesDestination(), destination()]
    const created = await createTrip(USER_A, { name: 'Unknowns', destinations })
    expect(created.destinations).toEqual(destinations)

    const got = await t.request(`/v1/trips/${created.id as string}`, { as: USER_A })
    expect(got.status).toBe(200)
    expect((await body(got)).destinations).toEqual(destinations)

    const reversed = [...destinations].reverse()
    const put = await t.request(`/v1/trips/${created.id as string}`, {
      method: 'PUT',
      as: USER_A,
      headers: { 'If-Match': '"1"' },
      json: { name: 'Unknowns', destinations: reversed },
    })
    expect(put.status).toBe(200)
    expect((await body(put)).destinations).toEqual(reversed)

    const again = await t.request(`/v1/trips/${created.id as string}`, { as: USER_A })
    expect((await body(again)).destinations).toEqual(reversed)
  })
})

describe('GET /v1/trips/{id}', () => {
  it('returns the trip with its ETag', async () => {
    const created = await createTrip(USER_A, { name: 'Get me', destinations: [destination()] })
    const res = await t.request(`/v1/trips/${created.id as string}`, { as: USER_A })
    expect(res.status).toBe(200)
    expectJson(res)
    expect(await body(res)).toEqual(created)
    expect(res.headers.get('etag')).toBe('"1"')
  })

  it('is 404 for a missing trip', async () => {
    await expectError(await t.request(`/v1/trips/${randomUUID()}`, { as: USER_A }), 404, 'not_found')
  })

  it("is 404 for another user's trip", async () => {
    const created = await createTrip(USER_A)
    await expectError(await t.request(`/v1/trips/${created.id as string}`, { as: USER_B }), 404, 'not_found')
  })
})

describe('non-UUID path id', () => {
  it.each([
    ['GET', undefined],
    ['PUT', { destinations: [] }],
    ['PATCH', { name: 'x' }],
    ['DELETE', undefined],
  ])('%s /v1/trips/not-a-uuid is 404', async (method, json) => {
    const res = await t.request('/v1/trips/not-a-uuid', {
      method,
      as: USER_A,
      json,
      headers: { 'If-Match': '"1"' },
    })
    await expectError(res, 404, 'not_found')
  })
})

describe('GET /v1/trips', () => {
  it('returns summaries with exactly the summary keys', async () => {
    const user = randomUUID()
    const created = await createTrip(user, {
      name: 'Summary',
      destinations: [
        destination({ place: { ...(destination().place as Json), displayName: 'A' } }),
        destination({ place: { ...(destination().place as Json), displayName: 'B' } }),
      ],
    })
    const res = await t.request('/v1/trips', { as: user })
    expect(res.status).toBe(200)
    expectJson(res)
    const list = await body(res)
    expect(Object.keys(list).sort()).toEqual(['items', 'nextCursor'])
    expect(list.nextCursor).toBeNull()
    const items = list.items as Json[]
    expect(items).toHaveLength(1)
    expect(Object.keys(items[0]!).sort()).toEqual(SUMMARY_KEYS)
    expect(items[0]).toEqual({
      id: created.id,
      name: 'Summary',
      destinationCount: 2,
      placeNames: ['A', 'B'],
      startDay: '2026-04-01',
      endDay: '2026-04-05',
      updatedAt: created.updatedAt,
    })
  })

  it('paginates across 3 pages with limit=2, newest first, no duplicates', async () => {
    const user = randomUUID()
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push((await createTrip(user, { name: `T${i}` })).id as string)

    const full = await body(await t.request('/v1/trips?limit=100', { as: user }))
    const expected = (full.items as Json[]).map((i) => i.id)
    expect([...expected].sort()).toEqual([...ids].sort())

    const seen: unknown[] = []
    const pageSizes: number[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const qs: string = cursor ? `limit=2&cursor=${encodeURIComponent(cursor)}` : 'limit=2'
      const res = await t.request(`/v1/trips?${qs}`, { as: user })
      expect(res.status).toBe(200)
      const page = await body(res)
      const items = page.items as Json[]
      pageSizes.push(items.length)
      seen.push(...items.map((i) => i.id))
      cursor = page.nextCursor as string | null
      pages++
    } while (cursor && pages < 10)

    expect(pages).toBe(3)
    expect(pageSizes).toEqual([2, 2, 1])
    expect(seen).toEqual(expected)
  })

  it('defaults to a limit of 20', async () => {
    const user = randomUUID()
    for (let i = 0; i < 21; i++) await createTrip(user, { name: `T${i}` })
    const page = await body(await t.request('/v1/trips', { as: user }))
    expect(page.items).toHaveLength(20)
    expect(typeof page.nextCursor).toBe('string')
  })

  it('accepts limit=100 and limit=1', async () => {
    expect((await t.request('/v1/trips?limit=100', { as: USER_A })).status).toBe(200)
    expect((await t.request('/v1/trips?limit=1', { as: USER_A })).status).toBe(200)
  })

  it.each(['abc', '0', '101', '-1', '1.5', ''])('rejects limit=%j with 400', async (limit) => {
    await expectError(await t.request(`/v1/trips?limit=${limit}`, { as: USER_A }), 400, 'bad_request')
  })

  it.each([
    ['garbage', 'garbage'],
    ['calendar-invalid timestamp', encodeCursor({ updatedAt: '2026-02-31T00:00:00.000Z', id: randomUUID() })],
    ['non-uuid id', encodeCursor({ updatedAt: '2026-02-01T00:00:00.000Z', id: 'nope' })],
  ])('rejects a %s cursor with 400', async (_label, cursor) => {
    const res = await t.request(`/v1/trips?cursor=${encodeURIComponent(cursor)}`, { as: USER_A })
    await expectError(res, 400, 'bad_request')
  })
})

describe('PUT /v1/trips/{id}', () => {
  it('requires If-Match (428)', async () => {
    const created = await createTrip(USER_A)
    const res = await t.request(`/v1/trips/${created.id as string}`, {
      method: 'PUT',
      as: USER_A,
      json: { destinations: [] },
    })
    await expectError(res, 428, 'precondition_required')
  })

  it.each(['abc', 'W/"1"', '*', '"1", "2"', '0'])('rejects If-Match %j with 400', async (ifMatch) => {
    const created = await createTrip(USER_A)
    const res = await t.request(`/v1/trips/${created.id as string}`, {
      method: 'PUT',
      as: USER_A,
      headers: { 'If-Match': ifMatch },
      json: { destinations: [] },
    })
    await expectError(res, 400, 'bad_request')
  })

  it('is 412 with the current revision when stale', async () => {
    const created = await createTrip(USER_A)
    const ok = await t.request(`/v1/trips/${created.id as string}`, {
      method: 'PUT',
      as: USER_A,
      headers: { 'If-Match': '"1"' },
      json: { name: 'v2', destinations: [] },
    })
    expect(ok.status).toBe(200)
    const stale = await t.request(`/v1/trips/${created.id as string}`, {
      method: 'PUT',
      as: USER_A,
      headers: { 'If-Match': '"1"' },
      json: { name: 'lost', destinations: [] },
    })
    const b = await expectError(stale, 412, 'precondition_failed')
    expect(b.currentRevision).toBe(2)
  })

  it('replaces the trip, bumps the revision and returns the new ETag', async () => {
    const created = await createTrip(USER_A, { name: 'Before', destinations: [destination()] })
    const destinations = [destination({ color: 'violet' })]
    const res = await t.request(`/v1/trips/${created.id as string}`, {
      method: 'PUT',
      as: USER_A,
      headers: { 'If-Match': '"1"' },
      json: { name: 'After', destinations },
    })
    expect(res.status).toBe(200)
    expectJson(res)
    const trip = await body(res)
    expect(trip).toMatchObject({ id: created.id, name: 'After', revision: 2, destinations })
    expect(res.headers.get('etag')).toBe('"2"')
    expect(res.headers.get('etag')).toBe(`"${trip.revision as number}"`)

    const second = await t.request(`/v1/trips/${created.id as string}`, {
      method: 'PUT',
      as: USER_A,
      headers: { 'If-Match': '2' },
      json: { name: 'Again', destinations },
    })
    expect(second.status).toBe(200)
    expect((await body(second)).revision).toBe(3)
    expect(second.headers.get('etag')).toBe('"3"')
  })

  it('ignores revision, updatedAt and id in the body', async () => {
    const created = await createTrip(USER_A)
    const res = await t.request(`/v1/trips/${created.id as string}`, {
      method: 'PUT',
      as: USER_A,
      headers: { 'If-Match': '"1"' },
      json: { id: randomUUID(), revision: 99, updatedAt: '2000-01-01T00:00:00Z', destinations: [] },
    })
    expect(res.status).toBe(200)
    const trip = await body(res)
    expect(trip.id).toBe(created.id)
    expect(trip.revision).toBe(2)
    expect(trip.updatedAt).not.toBe('2000-01-01T00:00:00Z')
  })

  it('is 404 for a missing trip', async () => {
    const res = await t.request(`/v1/trips/${randomUUID()}`, {
      method: 'PUT',
      as: USER_A,
      headers: { 'If-Match': '"1"' },
      json: { destinations: [] },
    })
    await expectError(res, 404, 'not_found')
  })

  it('rejects a schema violation with 422 and malformed JSON with 400', async () => {
    const created = await createTrip(USER_A)
    const path = `/v1/trips/${created.id as string}`
    const bad = await t.request(path, {
      method: 'PUT',
      as: USER_A,
      headers: { 'If-Match': '"1"' },
      json: { destinations: [destination({ timing: { mode: 'explicitDates', startDay: '2026-02-30', isPlaceholder: false } })] },
    })
    const b = await expectError(bad, 422, 'unprocessable')
    expect((b.error as Json).message).toContain('destinations.0.timing.startDay')

    const malformed = await t.request(path, {
      method: 'PUT',
      as: USER_A,
      headers: { 'If-Match': '"1"', 'Content-Type': 'application/json' },
      body: '{',
    })
    await expectError(malformed, 400, 'bad_request')
  })
})

describe('PATCH /v1/trips/{id}', () => {
  it('renames without If-Match, returns the full trip and bumps the revision', async () => {
    const destinations = [destination()]
    const created = await createTrip(USER_A, { name: 'Old', destinations })
    const res = await t.request(`/v1/trips/${created.id as string}`, {
      method: 'PATCH',
      as: USER_A,
      json: { name: 'New' },
    })
    expect(res.status).toBe(200)
    expectJson(res)
    const trip = await body(res)
    expect(trip).toMatchObject({ id: created.id, name: 'New', revision: 2, destinations, schemaVersion: 1 })
    expect(res.headers.get('etag')).toBe('"2"')
  })

  it('accepts name: null', async () => {
    const created = await createTrip(USER_A, { name: 'Old' })
    const res = await t.request(`/v1/trips/${created.id as string}`, {
      method: 'PATCH',
      as: USER_A,
      json: { name: null },
    })
    expect(res.status).toBe(200)
    expect((await body(res)).name).toBeNull()
  })

  it('honours a matching If-Match and rejects a stale one with 412', async () => {
    const created = await createTrip(USER_A)
    const path = `/v1/trips/${created.id as string}`
    const ok = await t.request(path, { method: 'PATCH', as: USER_A, headers: { 'If-Match': '"1"' }, json: { name: 'a' } })
    expect(ok.status).toBe(200)
    const stale = await t.request(path, { method: 'PATCH', as: USER_A, headers: { 'If-Match': '"1"' }, json: { name: 'b' } })
    const b = await expectError(stale, 412, 'precondition_failed')
    expect(b.currentRevision).toBe(2)
  })

  it('rejects a malformed If-Match with 400', async () => {
    const created = await createTrip(USER_A)
    const res = await t.request(`/v1/trips/${created.id as string}`, {
      method: 'PATCH',
      as: USER_A,
      headers: { 'If-Match': 'abc' },
      json: { name: 'a' },
    })
    await expectError(res, 400, 'bad_request')
  })

  it('rejects {} with 422', async () => {
    const created = await createTrip(USER_A)
    const res = await t.request(`/v1/trips/${created.id as string}`, { method: 'PATCH', as: USER_A, json: {} })
    const b = await expectError(res, 422, 'unprocessable')
    expect((b.error as Json).message).toMatch(/^name/)
  })

  it('rejects malformed JSON with 400', async () => {
    const created = await createTrip(USER_A)
    const res = await t.request(`/v1/trips/${created.id as string}`, {
      method: 'PATCH',
      as: USER_A,
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    await expectError(res, 400, 'bad_request')
  })

  it('is 404 for a missing trip', async () => {
    const res = await t.request(`/v1/trips/${randomUUID()}`, { method: 'PATCH', as: USER_A, json: { name: 'x' } })
    await expectError(res, 404, 'not_found')
  })
})

describe('DELETE /v1/trips/{id}', () => {
  it('returns 204 with no body, then the trip is gone', async () => {
    const created = await createTrip(USER_A)
    const path = `/v1/trips/${created.id as string}`
    const res = await t.request(path, { method: 'DELETE', as: USER_A })
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
    await expectError(await t.request(path, { as: USER_A }), 404, 'not_found')
    await expectError(await t.request(path, { method: 'DELETE', as: USER_A }), 404, 'not_found')
  })
})

describe('user isolation', () => {
  it("user B can never see or change user A's trip", async () => {
    const created = await createTrip(USER_A, { name: 'Private', destinations: [destination()] })
    const path = `/v1/trips/${created.id as string}`

    const listB = await body(await t.request('/v1/trips?limit=100', { as: USER_B }))
    expect((listB.items as Json[]).map((i) => i.id)).not.toContain(created.id)

    await expectError(await t.request(path, { as: USER_B }), 404, 'not_found')
    await expectError(
      await t.request(path, { method: 'PUT', as: USER_B, headers: { 'If-Match': '"1"' }, json: { destinations: [] } }),
      404,
      'not_found',
    )
    await expectError(await t.request(path, { method: 'PATCH', as: USER_B, json: { name: 'hijack' } }), 404, 'not_found')
    await expectError(await t.request(path, { method: 'DELETE', as: USER_B }), 404, 'not_found')

    const still = await t.request(path, { as: USER_A })
    expect(still.status).toBe(200)
    expect(await body(still)).toEqual(created)
  })
})

describe('authentication', () => {
  const id = '33333333-3333-4333-8333-333333333333'
  const routes: [string, string, unknown][] = [
    ['GET', '/v1/trips', undefined],
    ['POST', '/v1/trips', { name: 'x' }],
    ['GET', `/v1/trips/${id}`, undefined],
    ['PUT', `/v1/trips/${id}`, { destinations: [] }],
    ['PATCH', `/v1/trips/${id}`, { name: 'x' }],
    ['DELETE', `/v1/trips/${id}`, undefined],
  ]

  it.each(routes)('%s %s without a token is 401', async (method, path, json) => {
    await expectError(await t.request(path, { method, json }), 401, 'unauthorized')
  })

  it.each(routes)('%s %s with a malformed token is 401', async (method, path, json) => {
    const res = await t.request(path, { method, json, headers: { Authorization: 'Bearer not.a.jwt' } })
    await expectError(res, 401, 'unauthorized')
  })

  it.each(routes)('%s %s with a non-bearer scheme is 401', async (method, path, json) => {
    const res = await t.request(path, { method, json, headers: { Authorization: 'Basic dXNlcjpwYXNz' } })
    await expectError(res, 401, 'unauthorized')
  })
})

describe('auth key service outage', () => {
  it('answers 503 service_unavailable, not 401', async () => {
    const app = createApp(
      stubDeps({
        verify: async () => {
          throw authUnavailable()
        },
      }),
    )
    const res = await app.request('/v1/trips', { headers: { Authorization: 'Bearer x' } })
    await expectError(res, 503, 'service_unavailable')
  })
})

describe('unknown routes', () => {
  it('return a JSON 404', async () => {
    await expectError(await t.request('/v1/nope'), 404, 'not_found')
  })
})

describe('unexpected failures', () => {
  it('returns a JSON 500 without leaking details', async () => {
    const boom = () => Promise.reject(new Error('db exploded'))
    const repo: TripRepo = { list: boom, get: boom, create: boom, replace: boom, rename: boom, remove: boom }
    const app = createApp({ ...t.deps, repo })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await app.request('/v1/trips', {
        headers: { Authorization: `Bearer ${await t.tokenFor(USER_A)}` },
      })
      const b = await expectError(res, 500, 'internal')
      expect(JSON.stringify(b)).not.toContain('exploded')
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})
