import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import { stubDeps } from '../helpers/app.js'

afterEach(() => vi.restoreAllMocks())

describe('request logging', () => {
  it('is off by default', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await createApp(stubDeps()).request('/v1/config')
    expect(log).not.toHaveBeenCalled()
  })

  it('logs method, path and status when enabled', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await createApp(stubDeps(), { requestLog: true }).request('/v1/config')
    const lines = log.mock.calls.map((c) => String(c[0]))
    expect(lines.some((l) => l.includes('GET') && l.includes('/v1/config'))).toBe(true)
    expect(lines.some((l) => l.includes('200'))).toBe(true)
  })

  it('keeps the JSON 404 error shape for unknown routes when enabled', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const res = await createApp(stubDeps(), { requestLog: true }).request('/nope')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } })
  })
})
