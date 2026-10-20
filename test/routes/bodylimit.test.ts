import { describe, expect, it } from 'vitest'
import { createApp, MAX_BODY_BYTES } from '../../src/app.js'
import type { TripRepo } from '../../src/repo/trips.js'
import { stubRemoteConfig } from '../helpers/app.js'

const USER = '11111111-1111-4111-8111-111111111111'
const ID = '9b2f4a7c-5d1e-4f8a-8c3b-0a1b2c3d4e5f'

const repo = {
  list: async () => ({ items: [], nextCursor: null }),
  get: async () => null,
  remove: async () => false,
} as unknown as TripRepo

const app = createApp({ repo, verify: async () => ({ userId: USER }), remoteConfig: stubRemoteConfig })
const oversized = { Authorization: 'Bearer x', 'Content-Length': String(MAX_BODY_BYTES + 1) }

describe('body limit scope', () => {
  it.each([
    ['GET', '/v1/trips'],
    ['GET', `/v1/trips/${ID}`],
    ['DELETE', `/v1/trips/${ID}`],
  ])('does not apply to %s %s', async (method, path) => {
    const res = await app.request(path, { method, headers: oversized })
    expect(res.status).not.toBe(413)
  })

  it.each([
    ['POST', '/v1/trips'],
    ['PUT', `/v1/trips/${ID}`],
    ['PATCH', `/v1/trips/${ID}`],
  ])('still applies to %s %s', async (method, path) => {
    const body = JSON.stringify({ name: 'x'.repeat(MAX_BODY_BYTES + 1) })
    const res = await app.request(path, {
      method,
      headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
      body,
    })
    expect(res.status).toBe(413)
  })
})
