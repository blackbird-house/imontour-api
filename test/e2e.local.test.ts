import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { ensureLocalKeyFile, signLocalToken } from '../src/auth/localKeys.js'
import { buildDeps } from '../src/deps.js'
import { loadConfig } from '../src/env.js'
import { createTestSchema, stopTestDatabase } from './helpers/db.js'

type Json = Record<string, unknown>

const ISSUER = 'http://localhost:3000/local-auth'
const USER = '00000000-0000-4000-8000-000000000001'

let dir: string
let drop: () => Promise<void>
let app: ReturnType<typeof createApp>
let auth: Record<string, string>

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'imontour-e2e-'))
  const keyFile = join(dir, 'jwks.json')
  const harness = await createTestSchema()
  drop = harness.drop

  const config = loadConfig({
    APP_ENV: 'local',
    // The harness db is injected below, so this URL is never connected to.
    DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:54329/imontour',
    DB_SCHEMA: harness.schema,
    AUTH_ISSUER: ISSUER,
    AUTH_LOCAL_KEY_FILE: keyFile,
  })
  await ensureLocalKeyFile(keyFile)
  app = createApp(buildDeps(config, harness.db))
  const token = await signLocalToken(keyFile, { sub: USER, iss: ISSUER, aud: config.auth.audience })
  auth = { Authorization: `Bearer ${token}` }
})

afterAll(async () => {
  await drop()
  await stopTestDatabase()
  await rm(dir, { recursive: true, force: true })
})

function destination(): Json {
  return {
    id: randomUUID(),
    rawInput: 'Tokyo',
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
  }
}

describe('local end-to-end', () => {
  it('serves the public remote config without a token', async () => {
    const res = await app.request('/v1/config')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ schemaVersion: 1 })
  })

  it('rejects trips requests without a token', async () => {
    expect((await app.request('/v1/trips')).status).toBe(401)
  })

  it('runs the full trip lifecycle', async () => {
    const id = randomUUID()
    const json = { 'Content-Type': 'application/json' }
    const created = await app.request('/v1/trips', {
      method: 'POST',
      headers: { ...auth, ...json },
      body: JSON.stringify({ schemaVersion: 1, id, name: 'Japan', destinations: [destination()] }),
    })
    expect(created.status).toBe(201)
    expect(created.headers.get('etag')).toBe('"1"')

    const got = await app.request(`/v1/trips/${id}`, { headers: auth })
    expect(got.status).toBe(200)
    const trip = (await got.json()) as Json
    expect(trip).toMatchObject({ id, name: 'Japan', revision: 1 })

    const list = await app.request('/v1/trips', { headers: auth })
    expect(list.status).toBe(200)
    const page = (await list.json()) as { items: Json[] }
    expect(page.items.map((i) => i.id)).toContain(id)

    const updated = await app.request(`/v1/trips/${id}`, {
      method: 'PUT',
      headers: { ...auth, ...json, 'If-Match': '"1"' },
      body: JSON.stringify({ ...trip, name: 'Japan 2' }),
    })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({ name: 'Japan 2', revision: 2 })

    const deleted = await app.request(`/v1/trips/${id}`, { method: 'DELETE', headers: auth })
    expect(deleted.status).toBe(204)

    const gone = await app.request(`/v1/trips/${id}`, { headers: auth })
    expect(gone.status).toBe(404)
  })
})
