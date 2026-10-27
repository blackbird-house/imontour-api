import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import { UnauthorizedError } from '../../src/errors.js'
import { stubDeps } from '../helpers/app.js'

const verify = () => Promise.reject(new UnauthorizedError())

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GET /v1/health', () => {
  it('answers 200 {status:ok} without a token and is never cached', async () => {
    const app = createApp(stubDeps({ verify, pingDatabase: async () => {} }))
    const res = await app.request('/v1/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('answers 503 {status:unavailable} when the database fails, without leaking the reason', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = createApp(stubDeps({ verify, pingDatabase: () => Promise.reject(new Error('password for db.secret')) }))
    const res = await app.request('/v1/health')
    expect(res.status).toBe(503)
    expect(await res.text()).toBe('{"status":"unavailable"}')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(spy).toHaveBeenCalledOnce()
  })

  it('answers 503 when the database does not answer in time', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      const app = createApp(stubDeps({ verify, pingDatabase: () => new Promise(() => {}) }))
      const pending = app.request('/v1/health')
      await vi.advanceTimersByTimeAsync(3000)
      expect((await pending).status).toBe(503)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is documented as a public endpoint', () => {
    const doc = createApp(stubDeps()).getOpenAPI31Document({ openapi: '3.1.0', info: { title: 't', version: '1' } })
    expect(doc.paths?.['/v1/health']?.get?.security).toEqual([])
  })
})

describe('X-Request-Id', () => {
  it('is set on every response, including errors and 404s', async () => {
    const app = createApp(stubDeps({ verify }))
    for (const path of ['/v1/config', '/v1/trips', '/v1/nope']) {
      const res = await app.request(path)
      expect(res.headers.get('X-Request-Id'), path).toBeTruthy()
    }
  })

  it('is quoted in the log line of an unexpected 500', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = createApp(
      stubDeps({
        remoteConfig: () => Promise.reject(new Error('boom')),
      }),
    )
    const res = await app.request('/v1/config', { headers: { 'X-Request-Id': 'abc-123' } })
    expect(res.status).toBe(500)
    expect(res.headers.get('X-Request-Id')).toBe('abc-123')
    expect(spy.mock.calls[0]?.[0]).toBe('request abc-123:')
  })
})
