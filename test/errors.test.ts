import { Hono } from 'hono'
import postgres from 'postgres'
import { describe, expect, it, vi } from 'vitest'
import { HTTPException } from 'hono/http-exception'
import { ZodRealError } from 'zod'
import { ApiError, errorHandler, preconditionFailed } from '../src/errors.js'

function appThrowing(err: Error) {
  const app = new Hono()
  app.onError(errorHandler)
  app.get('/', () => {
    throw err
  })
  return app
}

const pgError = (code: string) =>
  new postgres.PostgresError({ message: 'invalid input syntax', code } as unknown as string)

describe('errorHandler', () => {
  it.each(['22021', '22P05', '22P02'])('maps PostgresError %s (invalid text/json/uuid input) to 422', async (code) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await appThrowing(pgError(code)).request('/')
      expect(res.status).toBe(422)
      const body = (await res.json()) as { error: { code: string; message: string } }
      expect(body.error.code).toBe('unprocessable')
      expect(body.error.message).not.toContain('syntax')
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it.each([
    ['another PostgresError', pgError('23505')],
    ['a plain Error', new Error('boom')],
  ])('keeps %s a generic 500', async (_label, err) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await appThrowing(err).request('/')
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: { code: 'internal', message: 'Internal server error' } })
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  // zod 4: only ZodRealError (what parse and safeParse produce) extends Error, so only it reaches onError.
  it('maps an HTTPException with an unmapped status to http_error, with a fallback message', async () => {
    const res = await appThrowing(new HTTPException(418)).request('/')
    expect(res.status).toBe(418)
    expect(await res.json()).toEqual({ error: { code: 'http_error', message: 'Request failed' } })
  })

  it('names the body when a ZodRealError has no path, and the first failing path otherwise', async () => {
    const rootIssue = new ZodRealError([{ code: 'custom', path: [], message: 'bad shape' }])
    const nested = new ZodRealError([{ code: 'custom', path: ['destinations', 0, 'color'], message: 'too long' }])
    expect(await (await appThrowing(rootIssue).request('/')).json()).toEqual({
      error: { code: 'unprocessable', message: 'body: bad shape' },
    })
    expect(await (await appThrowing(nested).request('/')).json()).toEqual({
      error: { code: 'unprocessable', message: 'destinations.0.color: too long' },
    })
  })

  it('puts extra fields next to error and never lets them replace it', async () => {
    const res = await appThrowing(preconditionFailed({ currentRevision: 3 })).request('/')
    expect(await res.json()).toEqual({
      error: { code: 'precondition_failed', message: 'Precondition failed' },
      currentRevision: 3,
    })

    const clash = new ApiError(409, 'conflict', 'real message', { error: 'spoofed' })
    expect(await (await appThrowing(clash).request('/')).json()).toEqual({
      error: { code: 'conflict', message: 'real message' },
    })
  })
})
