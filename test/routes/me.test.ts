import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import { authUnavailable } from '../../src/auth/verifier.js'
import { MAX_BODY_BYTES } from '../../src/app.js'
import { createTestApp, stubDeps } from '../helpers/app.js'
import { TEST_ISSUER } from '../helpers/tokens.js'

type TestApp = Awaited<ReturnType<typeof createTestApp>>
type Json = Record<string, unknown>

let t: TestApp

beforeAll(async () => {
  t = await createTestApp()
})

afterAll(async () => {
  await t.stop()
})

const body = async (res: Response) => (await res.json()) as Json

async function expectError(res: Response, status: number, code: string): Promise<Json> {
  expect(res.status).toBe(status)
  const b = await body(res)
  expect(b.error).toMatchObject({ code })
  return b
}

const usersCount = async () =>
  (await t.db<{ n: number }[]>`select count(*)::int as n from ${t.db(t.schema)}.users`)[0]!.n

describe('GET /v1/me', () => {
  it('provisions the user on the first authenticated request and returns the profile', async () => {
    const subject = randomUUID()
    const before = await usersCount()
    const res = await t.request('/v1/me', { as: subject })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    const me = await body(res)
    expect(me).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      displayName: null,
      email: null,
      locale: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    })
    expect(me.id).not.toBe(subject)
    expect(await usersCount()).toBe(before + 1)
  })

  it('returns the same user on every request for the same identity', async () => {
    const subject = randomUUID()
    const first = await body(await t.request('/v1/me', { as: subject }))
    const before = await usersCount()
    const second = await body(await t.request('/v1/me', { as: subject }))
    expect(second).toEqual(first)
    expect(await usersCount()).toBe(before)
    expect(second.id).toBe(await t.userIdFor(subject))
  })

  it('copies the token email on provisioning', async () => {
    const subject = randomUUID()
    const token = await t.tokenFor(subject, 'ana@example.com')
    const res = await t.app.request('/v1/me', { headers: { Authorization: `Bearer ${token}` } })
    expect(await body(res)).toMatchObject({ email: 'ana@example.com' })
  })

  it('gives different identities different users', async () => {
    const a = await body(await t.request('/v1/me', { as: randomUUID() }))
    const b = await body(await t.request('/v1/me', { as: randomUUID() }))
    expect(a.id).not.toBe(b.id)
  })

  it('creates one user for concurrent first requests', async () => {
    const subject = randomUUID()
    const before = await usersCount()
    const responses = await Promise.all(Array.from({ length: 8 }, () => t.request('/v1/me', { as: subject })))
    expect(responses.map((r) => r.status)).toEqual(Array(8).fill(200))
    const ids = await Promise.all(responses.map(async (r) => (await body(r)).id))
    expect(new Set(ids).size).toBe(1)
    expect(await usersCount()).toBe(before + 1)
  })

  it('is 401 without a token or with a bad one, and creates nobody', async () => {
    const before = await usersCount()
    await expectError(await t.request('/v1/me'), 401, 'unauthorized')
    await expectError(await t.request('/v1/me', { headers: { Authorization: 'Bearer nope' } }), 401, 'unauthorized')
    expect(await usersCount()).toBe(before)
  })

  it('is 503, not 401, when the auth key service is down', async () => {
    const app = createApp(
      stubDeps({
        verify: async () => {
          throw authUnavailable()
        },
      }),
    )
    await expectError(
      await app.request('/v1/me', { headers: { Authorization: 'Bearer x' } }),
      503,
      'service_unavailable',
    )
  })

  it('scopes trips to the internal user: the same identity sees its trips, another does not', async () => {
    const subject = randomUUID()
    const created = await t.request('/v1/trips', { method: 'POST', as: subject, json: { name: 'mine' } })
    const trip = await body(created)
    const again = await t.request(`/v1/trips/${trip.id as string}`, { as: subject })
    expect(again.status).toBe(200)
    const other = await t.request(`/v1/trips/${trip.id as string}`, { as: randomUUID() })
    expect(other.status).toBe(404)
    // The trip is stored under the internal id, not the provider subject.
    const rows = await t.db<{ user_id: string }[]>`
      select user_id from ${t.db(t.schema)}.trips where id = ${trip.id as string}`
    expect(rows[0]!.user_id).toBe(await t.userIdFor(subject))
    expect(rows[0]!.user_id).not.toBe(subject)
  })
})

describe('PATCH /v1/me', () => {
  it('updates displayName and locale', async () => {
    const subject = randomUUID()
    const res = await t.request('/v1/me', {
      method: 'PATCH',
      as: subject,
      json: { displayName: 'Ana', locale: 'pt-BR' },
    })
    expect(res.status).toBe(200)
    expect(await body(res)).toMatchObject({ displayName: 'Ana', locale: 'pt-BR' })
    expect(await body(await t.request('/v1/me', { as: subject }))).toMatchObject({
      displayName: 'Ana',
      locale: 'pt-BR',
    })
  })

  it('changes only the fields sent, and null clears', async () => {
    const subject = randomUUID()
    await t.request('/v1/me', { method: 'PATCH', as: subject, json: { displayName: 'Ana', locale: 'en' } })
    const only = await t.request('/v1/me', { method: 'PATCH', as: subject, json: { locale: 'fr' } })
    expect(await body(only)).toMatchObject({ displayName: 'Ana', locale: 'fr' })
    const cleared = await t.request('/v1/me', { method: 'PATCH', as: subject, json: { displayName: null } })
    expect(await body(cleared)).toMatchObject({ displayName: null, locale: 'fr' })
  })

  it('strips unknown fields: id and email cannot be changed', async () => {
    const subject = randomUUID()
    const before = await body(await t.request('/v1/me', { as: subject }))
    const res = await t.request('/v1/me', {
      method: 'PATCH',
      as: subject,
      json: { displayName: 'Ana', id: randomUUID(), email: 'evil@example.com' },
    })
    expect(await body(res)).toMatchObject({ id: before.id, email: null, displayName: 'Ana' })
  })

  it.each([
    ['an empty object', {}],
    ['only unknown fields', { nope: 1 }],
    ['a non-string displayName', { displayName: 5 }],
    ['an over-long displayName', { displayName: 'x'.repeat(101) }],
    ['a NUL in displayName', { displayName: 'a\u0000b' }],
    ['a malformed locale', { locale: 'not a locale' }],
    ['an over-long locale', { locale: `en-${'x'.repeat(40)}` }],
  ])('rejects %s with 422', async (_label, json) => {
    await expectError(await t.request('/v1/me', { method: 'PATCH', as: randomUUID(), json }), 422, 'unprocessable')
  })

  it('accepts a 100 character displayName and an underscore locale', async () => {
    const res = await t.request('/v1/me', {
      method: 'PATCH',
      as: randomUUID(),
      json: { displayName: 'x'.repeat(100), locale: 'en_GB' },
    })
    expect(res.status).toBe(200)
  })

  it('is 400 for malformed JSON, 415 for another content type, 413 above 1 MB, 401 without a token', async () => {
    const subject = randomUUID()
    const token = await t.tokenFor(subject)
    const send = (headers: Record<string, string>, bodyText: string) =>
      t.app.request('/v1/me', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, ...headers },
        body: bodyText,
      })
    await expectError(await send({ 'Content-Type': 'application/json' }, '{'), 400, 'bad_request')
    await expectError(await send({ 'Content-Type': 'text/plain' }, '{}'), 415, 'unsupported_media_type')
    await expectError(
      await send({ 'Content-Type': 'application/json' }, JSON.stringify({ displayName: 'x'.repeat(MAX_BODY_BYTES) })),
      413,
      'payload_too_large',
    )
    await expectError(await t.request('/v1/me', { method: 'PATCH', json: { displayName: 'x' } }), 401, 'unauthorized')
  })
})

describe('DELETE /v1/me', () => {
  it('hard-deletes the user and their trips, leaves other users alone, and cleans up at the provider', async () => {
    const subject = randomUUID()
    const bystander = randomUUID()
    const trip = await body(await t.request('/v1/trips', { method: 'POST', as: subject, json: { name: 'doomed' } }))
    const kept = await body(await t.request('/v1/trips', { method: 'POST', as: bystander, json: { name: 'kept' } }))
    const userId = await t.userIdFor(subject)

    const res = await t.request('/v1/me', { method: 'DELETE', as: subject })
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')

    const q = t.db(t.schema)
    expect(await t.db`select 1 from ${q}.users where id = ${userId}`).toHaveLength(0)
    expect(await t.db`select 1 from ${q}.identities where user_id = ${userId}`).toHaveLength(0)
    expect(await t.db`select 1 from ${q}.trips where user_id = ${userId}`).toHaveLength(0)
    expect(t.deleted).toContainEqual({ issuer: TEST_ISSUER, subject })
    expect(t.deleted).not.toContainEqual({ issuer: TEST_ISSUER, subject: bystander })

    expect((await t.request(`/v1/trips/${kept.id as string}`, { as: bystander })).status).toBe(200)
    expect(trip.id).toBeDefined()
  })

  it('still answers 204 when the provider cleanup fails', async () => {
    const subject = randomUUID()
    await t.request('/v1/me', { as: subject })
    const app = createApp({
      ...t.deps,
      identityAdmin: {
        deleteIdentity: async () => {
          throw new Error('provider down')
        },
      },
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await app.request('/v1/me', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${await t.tokenFor(subject)}` },
      })
      expect(res.status).toBe(204)
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
    expect(await t.db`select 1 from ${t.db(t.schema)}.users where id = ${await t.userIdFor(subject)}`).toHaveLength(1)
  })

  it('revokes the Apple grant when the app sends an authorization code, and ignores it otherwise', async () => {
    const withCode = randomUUID()
    await t.request('/v1/me', { method: 'GET', as: withCode })
    const res = await t.request('/v1/me', {
      method: 'DELETE',
      as: withCode,
      headers: { 'X-Apple-Authorization-Code': ' code-123 ' },
    })
    expect(res.status).toBe(204)
    expect(t.revoked).toContain('code-123')

    const before = t.revoked.length
    const without = randomUUID()
    await t.request('/v1/me', { method: 'GET', as: without })
    expect((await t.request('/v1/me', { method: 'DELETE', as: without })).status).toBe(204)
    expect(t.revoked).toHaveLength(before)
  })

  it('still answers 204 when the Apple revoke fails, and logs it', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const app = createApp({ ...t.deps, appleRevoker: { revoke: () => Promise.reject(new Error('apple down')) } })
      const subject = randomUUID()
      await t.userIdFor(subject)
      const res = await app.request('/v1/me', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${await t.tokenFor(subject)}`, 'X-Apple-Authorization-Code': 'c' },
      })
      expect(res.status).toBe(204)
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('does not apply the body limit to DELETE', async () => {
    const res = await t.request('/v1/me', {
      method: 'DELETE',
      as: randomUUID(),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: 'x'.repeat(MAX_BODY_BYTES) }),
    })
    expect(res.status).toBe(204)
  })

  it('is 401 without a token', async () => {
    await expectError(await t.request('/v1/me', { method: 'DELETE' }), 401, 'unauthorized')
  })

  it('is idempotent: repeating the delete with a still-valid token is 204 again and leaves no account behind', async () => {
    const subject = randomUUID()
    await t.request('/v1/me', { as: subject })
    expect((await t.request('/v1/me', { method: 'DELETE', as: subject })).status).toBe(204)
    const before = await usersCount()
    const again = await t.request('/v1/me', { method: 'DELETE', as: subject })
    expect(again.status).toBe(204)
    expect(await again.text()).toBe('')
    expect(await usersCount()).toBe(before)
  })

  it('a still-valid token after deletion starts a fresh, empty account', async () => {
    const subject = randomUUID()
    const old = await body(await t.request('/v1/me', { as: subject }))
    await t.request('/v1/me', { method: 'DELETE', as: subject })
    const fresh = await body(await t.request('/v1/me', { as: subject }))
    expect(fresh.id).not.toBe(old.id)
  })
})

describe('unexpected failures', () => {
  it('returns a JSON 500 without leaking details when the user lookup fails', async () => {
    const app = createApp({
      ...t.deps,
      resolveUser: () => Promise.reject(new Error('db exploded')),
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await app.request('/v1/me', {
        headers: { Authorization: `Bearer ${await t.tokenFor(randomUUID())}` },
      })
      const b = await expectError(res, 500, 'internal')
      expect(JSON.stringify(b)).not.toContain('exploded')
    } finally {
      spy.mockRestore()
    }
  })
})
