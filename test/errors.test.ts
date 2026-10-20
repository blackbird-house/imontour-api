import { Hono } from 'hono'
import postgres from 'postgres'
import { describe, expect, it, vi } from 'vitest'
import { errorHandler } from '../src/errors.js'

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
})
