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

const app = createApp({
  repo,
  verify: async (token) => {
    if (token !== 'good') throw new Error('unexpected token')
    return { userId: USER }
  },
  remoteConfig: stubRemoteConfig,
})
const oversizedJson = JSON.stringify({ name: 'x'.repeat(MAX_BODY_BYTES + 1) })
const json = { 'Content-Type': 'application/json' }

// GET is not covered: a GET request cannot carry a body (fetch's Request rejects one).
describe('body limit scope', () => {
  it('does not apply to DELETE: an oversized body still reaches the handler (404)', async () => {
    const res = await app.request(`/v1/trips/${ID}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer good', ...json },
      body: oversizedJson,
    })
    expect(res.status).toBe(404)
  })

  it.each([
    ['POST', '/v1/trips'],
    ['PUT', `/v1/trips/${ID}`],
    ['PATCH', `/v1/trips/${ID}`],
  ])('applies to %s %s (413)', async (method, path) => {
    const res = await app.request(path, {
      method,
      headers: { Authorization: 'Bearer good', ...json },
      body: oversizedJson,
    })
    expect(res.status).toBe(413)
  })

  it.each([
    ['POST', '/v1/trips'],
    ['PUT', `/v1/trips/${ID}`],
  ])('authenticates first: anonymous %s %s with an oversized body is 401', async (method, path) => {
    const res = await app.request(path, { method, headers: json, body: oversizedJson })
    expect(res.status).toBe(401)
  })
})
