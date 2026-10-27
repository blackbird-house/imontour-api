import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import { TEST_ADMIN_KEY, createTestApp, stubDeps } from '../helpers/app.js'

type TestApp = Awaited<ReturnType<typeof createTestApp>>
type Json = Record<string, unknown>
type Exported = {
  users: {
    user: Json
    identities: Json[]
    trips: Json[]
  }[]
}

let t: TestApp

beforeAll(async () => {
  t = await createTestApp()
})
afterAll(async () => {
  await t.stop()
})

const asAdmin = (email: unknown, key: string | null = TEST_ADMIN_KEY) =>
  t.request('/v1/admin/export', {
    method: 'POST',
    headers: key === null ? {} : { Authorization: `Bearer ${key}` },
    json: { email },
  })

async function seedUser(email: string): Promise<string> {
  const subject = randomUUID()
  const id = await t.userIdFor(subject)
  await t.db`update ${t.db(t.schema)}.users set email = ${email}, display_name = 'Ana' where id = ${id}`
  await t.request('/v1/trips', {
    method: 'POST',
    as: subject,
    json: { name: 'Japan', destinations: [] },
  })
  return id
}

describe('POST /v1/admin/export', () => {
  it('returns the user, identities and full trips, matching the email case-insensitively', async () => {
    const email = `${randomUUID()}@Example.com`
    const id = await seedUser(email)
    const res = await asAdmin(email.toLowerCase())
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('Content-Disposition')).toMatch(
      /^attachment; filename="imontour-export-\d{4}-\d{2}-\d{2}\.json"$/,
    )
    const body = (await res.json()) as Exported
    expect(body.users).toHaveLength(1)
    const [u] = body.users
    expect(u.user).toMatchObject({ id, email, displayName: 'Ana' })
    expect(u.identities).toHaveLength(1)
    expect(u.trips).toHaveLength(1)
    expect(u.trips[0]).toMatchObject({ name: 'Japan', schemaVersion: 1, revision: 1, destinations: [] })
  })

  it('is 404 for an address we hold nothing for', async () => {
    const res = await asAdmin(`${randomUUID()}@example.com`)
    expect(res.status).toBe(404)
  })

  it('rejects a missing, wrong or user token with 401, before touching the body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect((await asAdmin('a@b.co', null)).status).toBe(401)
      expect((await asAdmin('a@b.co', 'wrong')).status).toBe(401)
      const userToken = await t.tokenFor(randomUUID())
      expect((await asAdmin('a@b.co', userToken)).status).toBe(401)
    } finally {
      warn.mockRestore()
    }
  })

  it('is 422 for a missing email and 413 for an oversized body', async () => {
    expect((await asAdmin(undefined)).status).toBe(422)
    expect((await asAdmin('x'.repeat(5000))).status).toBe(413)
  })

  it('does not put the email in the audit log', async () => {
    const email = `${randomUUID()}@example.com`
    await seedUser(email)
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      await asAdmin(email)
      expect(info).toHaveBeenCalledOnce()
      expect(String(info.mock.calls[0]?.[0])).not.toContain(email)
    } finally {
      info.mockRestore()
    }
  })

  it('does not exist when no ADMIN_API_KEY is configured', async () => {
    const app = createApp(stubDeps())
    const res = await app.request('/v1/admin/export', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_ADMIN_KEY}`, 'Content-Type': 'application/json' },
      body: '{"email":"a@b.co"}',
    })
    expect(res.status).toBe(404)
  })

  it('is not in the OpenAPI document', () => {
    expect(
      Object.keys(t.app.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 't', version: '1' } }).paths ?? {}),
    ).not.toContain('/v1/admin/export')
  })
})
