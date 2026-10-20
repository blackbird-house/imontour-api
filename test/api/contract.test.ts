import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTarget, type ApiTarget } from './target.js'

/**
 * Black-box contract tests over real HTTP. Locally the suite boots the real app on an
 * ephemeral port; with API_BASE_URL + API_TEST_TOKEN + API_TEST_ALLOW_REMOTE=1 it tests
 * that server instead (see README "Testing"). Everything it creates is deleted again.
 */

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

let target: ApiTarget
const created: string[] = []
const remote = () => target.mode === 'remote'

beforeAll(async () => {
  target = await createTarget()
})

afterAll(async () => {
  try {
    for (const id of created) {
      await call(`/v1/trips/${id}`, { method: 'DELETE' }).catch(() => undefined)
    }
  } finally {
    await target.stop()
  }
})

type CallInit = {
  method?: string
  token?: string | null
  json?: unknown
  body?: BodyInit
  headers?: Record<string, string>
}

function call(path: string, init: CallInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...init.headers }
  const token = init.token === undefined ? target.token : init.token
  if (token) headers.Authorization = `Bearer ${token}`
  let body = init.body
  if (init.json !== undefined) {
    body = JSON.stringify(init.json)
    headers['Content-Type'] = 'application/json'
  }
  return fetch(`${target.baseUrl}${path}`, { method: init.method ?? 'GET', headers, body })
}

const unique = (label: string) => `api-test ${label} ${randomUUID()}`

async function createTrip(
  name = unique('trip'),
  extra: Json = {},
  token?: string,
): Promise<{ id: string; res: Response; trip: Json }> {
  const id = randomUUID()
  const res = await call('/v1/trips', {
    method: 'POST',
    token,
    json: { schemaVersion: 1, id, name, destinations: [], ...extra },
  })
  expect(res.status).toBe(201)
  created.push(id)
  return { id, res, trip: (await res.json()) as Json }
}

async function expectError(res: Response, status: number, code: string): Promise<Json> {
  expect(res.status).toBe(status)
  expect(res.headers.get('content-type')).toMatch(/application\/json/)
  const body = (await res.json()) as Json
  expect(body.error).toEqual({ code, message: expect.any(String) })
  return body
}

describe('GET /v1/config', () => {
  it('is public, served as JSON with an ETag and no-cache', async () => {
    const res = await call('/v1/config', { token: null })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    expect(res.headers.get('etag')).toMatch(/^"[^"]+"$/)
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(await res.json()).toMatchObject({ schemaVersion: expect.any(Number) })
  })

  it('answers 304 with no body when If-None-Match matches, and 200 when it does not', async () => {
    const first = await call('/v1/config', { token: null })
    const etag = first.headers.get('etag')!
    await first.arrayBuffer()

    const cached = await call('/v1/config', { token: null, headers: { 'If-None-Match': etag } })
    expect(cached.status).toBe(304)
    expect(cached.headers.get('etag')).toBe(etag)
    expect(await cached.text()).toBe('')

    const stale = await call('/v1/config', { token: null, headers: { 'If-None-Match': '"stale"' } })
    expect(stale.status).toBe(200)
    await stale.arrayBuffer()
  })
})

describe('authentication', () => {
  it('rejects a missing token with the error shape', async () => {
    await expectError(await call('/v1/trips', { token: null }), 401, 'unauthorized')
    await expectError(await call('/v1/me', { token: null }), 401, 'unauthorized')
  })

  it('rejects a garbage token', async () => {
    await expectError(await call('/v1/trips', { token: 'not-a-jwt' }), 401, 'unauthorized')
  })

  it('rejects a non-bearer scheme', async () => {
    await expectError(
      await call('/v1/trips', { token: null, headers: { Authorization: 'Basic abc' } }),
      401,
      'unauthorized',
    )
  })

  it('rejects an expired token', async (ctx) => {
    if (!target.expiredToken) return ctx.skip()
    await expectError(await call('/v1/trips', { token: await target.expiredToken() }), 401, 'unauthorized')
  })

  it('authenticates before reading the body', async () => {
    const res = await call('/v1/trips', { method: 'POST', token: null, json: { name: 'x' } })
    await expectError(res, 401, 'unauthorized')
  })
})

describe('trip lifecycle', () => {
  it('creates a trip: 201 with ETag, Location and the stored document', async () => {
    const name = unique('create')
    const { id, res, trip } = await createTrip(name)
    expect(res.headers.get('etag')).toBe('"1"')
    expect(res.headers.get('location')).toBe(`/v1/trips/${id}`)
    expect(trip).toMatchObject({ id, name, revision: 1, schemaVersion: 1, destinations: [] })
    expect(trip.updatedAt).toEqual(expect.any(String))
  })

  it('gets a trip with its ETag', async () => {
    const { id, trip } = await createTrip()
    const res = await call(`/v1/trips/${id}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).toBe('"1"')
    expect(await res.json()).toEqual(trip)
  })

  it('creates an empty trip from a bare name', async () => {
    const name = unique('bare')
    const res = await call('/v1/trips', { method: 'POST', json: { name } })
    expect(res.status).toBe(201)
    const trip = (await res.json()) as Json
    created.push(trip.id)
    expect(trip).toMatchObject({ name, destinations: [], revision: 1 })
  })

  it('rejects a duplicate id with 409', async () => {
    const { id } = await createTrip()
    await expectError(await call('/v1/trips', { method: 'POST', json: { id, name: unique('dup') } }), 409, 'conflict')
  })

  it('lists with limit and nextCursor, visiting every trip exactly once', async () => {
    const ids = [(await createTrip()).id, (await createTrip()).id, (await createTrip()).id]
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const query: string = `limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const res = await call(`/v1/trips?${query}`)
      expect(res.status).toBe(200)
      const page = (await res.json()) as { items: Json[]; nextCursor: string | null }
      expect(page.items.length).toBeLessThanOrEqual(1)
      for (const item of page.items) {
        expect(Object.keys(item).sort()).toEqual([
          'destinationCount',
          'endDay',
          'id',
          'name',
          'placeNames',
          'startDay',
          'updatedAt',
        ])
        seen.push(item.id)
      }
      if (pages === 0) expect(page.nextCursor).toEqual(expect.any(String))
      cursor = page.nextCursor
      pages += 1
    } while (cursor && pages < 500)
    expect(cursor).toBeNull()
    expect(new Set(seen).size).toBe(seen.length)
    for (const id of ids) expect(seen).toContain(id)
  })

  it('rejects bad pagination parameters with 400/422', async () => {
    await expectError(await call('/v1/trips?cursor=garbage'), 400, 'bad_request')
    const res = await call('/v1/trips?limit=0')
    expect([400, 422]).toContain(res.status)
    expect(((await res.json()) as Json).error).toEqual({ code: expect.any(String), message: expect.any(String) })
  })

  it('PUT requires If-Match: 428 when missing', async () => {
    const { id, trip } = await createTrip()
    await expectError(
      await call(`/v1/trips/${id}`, { method: 'PUT', json: { ...trip, name: unique('put') } }),
      428,
      'precondition_required',
    )
  })

  it('PUT with a stale revision is 412 with currentRevision', async () => {
    const { id, trip } = await createTrip()
    const res = await call(`/v1/trips/${id}`, {
      method: 'PUT',
      headers: { 'If-Match': '"99"' },
      json: { ...trip, name: unique('stale') },
    })
    const body = await expectError(res, 412, 'precondition_failed')
    expect(body.currentRevision).toBe(1)
  })

  it('PUT with the current revision replaces the document and bumps the revision', async () => {
    const { id, trip } = await createTrip()
    const name = unique('replaced')
    const res = await call(`/v1/trips/${id}`, {
      method: 'PUT',
      headers: { 'If-Match': '"1"' },
      json: { ...trip, name },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).toBe('"2"')
    expect(await res.json()).toMatchObject({ id, name, revision: 2 })
    // The old revision is now stale.
    const again = await call(`/v1/trips/${id}`, {
      method: 'PUT',
      headers: { 'If-Match': '"1"' },
      json: { ...trip, name },
    })
    expect((await expectError(again, 412, 'precondition_failed')).currentRevision).toBe(2)
  })

  it('PATCH renames, with or without If-Match', async () => {
    const { id } = await createTrip()
    const renamed = unique('renamed')
    const res = await call(`/v1/trips/${id}`, { method: 'PATCH', json: { name: renamed } })
    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).toBe('"2"')
    expect(await res.json()).toMatchObject({ id, name: renamed, revision: 2 })

    await expectError(
      await call(`/v1/trips/${id}`, { method: 'PATCH', headers: { 'If-Match': '"1"' }, json: { name: unique('x') } }),
      412,
      'precondition_failed',
    )
    const ok = await call(`/v1/trips/${id}`, { method: 'PATCH', headers: { 'If-Match': '"2"' }, json: { name: null } })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ name: null, revision: 3 })
  })

  it('DELETE answers 204 with no body, then 404 everywhere', async () => {
    const { id, trip } = await createTrip()
    const del = await call(`/v1/trips/${id}`, { method: 'DELETE' })
    expect(del.status).toBe(204)
    expect(await del.text()).toBe('')
    await expectError(await call(`/v1/trips/${id}`), 404, 'not_found')
    await expectError(await call(`/v1/trips/${id}`, { method: 'DELETE' }), 404, 'not_found')
    await expectError(
      await call(`/v1/trips/${id}`, { method: 'PUT', headers: { 'If-Match': '"1"' }, json: trip }),
      404,
      'not_found',
    )
    await expectError(await call(`/v1/trips/${id}`, { method: 'PATCH', json: { name: 'x' } }), 404, 'not_found')
  })

  it('treats a path id that is not a UUID as not found', async () => {
    await expectError(await call('/v1/trips/not-a-uuid'), 404, 'not_found')
  })
})

describe('request validation', () => {
  it('rejects an invalid document with 422', async () => {
    await expectError(
      await call('/v1/trips', { method: 'POST', json: { name: unique('bad'), destinations: 'nope' } }),
      422,
      'unprocessable',
    )
    await expectError(await call('/v1/trips', { method: 'POST', json: { name: 42 } }), 422, 'unprocessable')
  })

  it('rejects malformed JSON with 400', async () => {
    const res = await call('/v1/trips', {
      method: 'POST',
      body: '{nope',
      headers: { 'Content-Type': 'application/json' },
    })
    await expectError(res, 400, 'bad_request')
  })

  it('rejects a non-JSON content type with 415', async () => {
    const res = await call('/v1/trips', { method: 'POST', body: 'name=x', headers: { 'Content-Type': 'text/plain' } })
    await expectError(res, 415, 'unsupported_media_type')
  })

  it('rejects a body over 1 MB with 413 on every writing method', async () => {
    const big = JSON.stringify({ name: 'x'.repeat(1024 * 1024 + 1) })
    // `Connection: close`: the server answers 413 without draining the oversized body and the socket
    // can then be reset, which would break the next request if it were reused from the keep-alive pool.
    const headers = { 'Content-Type': 'application/json', Connection: 'close' }
    await expectError(await call('/v1/trips', { method: 'POST', body: big, headers }), 413, 'payload_too_large')
    const { id } = await createTrip()
    await expectError(await call(`/v1/trips/${id}`, { method: 'PATCH', body: big, headers }), 413, 'payload_too_large')
  })
})

describe("another user's trips", () => {
  it('are not found, not forbidden, and never listed', async (ctx) => {
    if (!target.otherToken) return ctx.skip()
    const { id, trip } = await createTrip()
    const other = target.otherToken
    await expectError(await call(`/v1/trips/${id}`, { token: other }), 404, 'not_found')
    await expectError(
      await call(`/v1/trips/${id}`, {
        method: 'PUT',
        token: other,
        headers: { 'If-Match': '"1"' },
        json: { ...trip, name: 'hijack' },
      }),
      404,
      'not_found',
    )
    await expectError(
      await call(`/v1/trips/${id}`, { method: 'PATCH', token: other, json: { name: 'hijack' } }),
      404,
      'not_found',
    )
    await expectError(await call(`/v1/trips/${id}`, { method: 'DELETE', token: other }), 404, 'not_found')

    const list = (await (await call('/v1/trips?limit=100', { token: other })).json()) as { items: Json[] }
    expect(list.items.map((i) => i.id)).not.toContain(id)
    // Still intact for the owner.
    expect(((await (await call(`/v1/trips/${id}`)).json()) as Json).name).toBe(trip.name)
  })
})

describe('/v1/me', () => {
  it('returns the profile, then patches it', async () => {
    const res = await call('/v1/me')
    expect(res.status).toBe(200)
    const profile = (await res.json()) as Json
    expect(profile).toMatchObject({
      id: expect.any(String),
      displayName: expect.toBeOneOf([null, expect.any(String)]),
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    })

    const original = { displayName: profile.displayName, locale: profile.locale }
    try {
      const patched = await call('/v1/me', { method: 'PATCH', json: { displayName: 'API Test', locale: 'en-GB' } })
      expect(patched.status).toBe(200)
      expect(await patched.json()).toMatchObject({ id: profile.id, displayName: 'API Test', locale: 'en-GB' })
      expect(await (await call('/v1/me')).json()).toMatchObject({ displayName: 'API Test', locale: 'en-GB' })
    } finally {
      await call('/v1/me', { method: 'PATCH', json: original })
    }
  })

  it('rejects an invalid profile update with 422', async () => {
    await expectError(
      await call('/v1/me', { method: 'PATCH', json: { locale: 'not a locale!' } }),
      422,
      'unprocessable',
    )
    await expectError(
      await call('/v1/me', { method: 'PATCH', json: { displayName: 'x'.repeat(101) } }),
      422,
      'unprocessable',
    )
  })

  it('rejects a non-JSON content type with 415', async () => {
    const res = await call('/v1/me', { method: 'PATCH', body: 'x', headers: { 'Content-Type': 'text/plain' } })
    await expectError(res, 415, 'unsupported_media_type')
  })

  // Local mode only: remote mode never deletes the real test user.
  it('DELETE removes the user and all their trips', async (ctx) => {
    if (remote() || !target.disposableToken) return ctx.skip()
    const token = await target.disposableToken()
    const ids = [(await createTrip(unique('gone-1'), {}, token)).id, (await createTrip(unique('gone-2'), {}, token)).id]
    expect(((await (await call('/v1/trips', { token })).json()) as { items: Json[] }).items).toHaveLength(2)

    const del = await call('/v1/me', { method: 'DELETE', token })
    expect(del.status).toBe(204)
    expect(await del.text()).toBe('')

    // The same token now provisions a brand-new, empty user.
    for (const id of ids) await expectError(await call(`/v1/trips/${id}`, { token }), 404, 'not_found')
    expect(((await (await call('/v1/trips', { token })).json()) as { items: Json[] }).items).toEqual([])
    // Deleting again is idempotent.
    expect((await call('/v1/me', { method: 'DELETE', token })).status).toBe(204)
  })
})

describe('unknown routes', () => {
  it('answer 404 with the error shape', async () => {
    await expectError(await call('/v1/nope', { token: null }), 404, 'not_found')
    await expectError(await call('/nope'), 404, 'not_found')
  })
})
