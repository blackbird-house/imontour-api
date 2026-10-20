import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor } from '../../src/http/cursor.js'

const id = '9b2f4a7c-5d1e-4f8a-8c3b-0a1b2c3d4e5f'
const updatedAt = '2026-10-20T09:00:00.123Z'

const b64 = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url')

describe('cursor', () => {
  it('round-trips', () => {
    const c = { updatedAt, id }
    expect(decodeCursor(encodeCursor(c))).toEqual(c)
  })

  it('is url-safe', () => {
    expect(encodeCursor({ updatedAt, id })).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it.each([
    ['not base64!!'],
    [''],
    [b64('not json')],
    [b64({ i: id })],
    [b64({ u: updatedAt })],
    [b64({ u: 5, i: id })],
    [b64({ u: updatedAt, i: 5 })],
    [b64({ u: 'yesterday', i: id })],
    [b64({ u: updatedAt, i: 'not-a-uuid' })],
    [b64('null')],
    [b64([1, 2])],
    [b64({ u: '2026-02-31T00:00:00.000Z', i: id })],
    [b64({ u: '2026-04-31T00:00:00.000Z', i: id })],
    [b64({ u: '2026-10-20T24:00:00.000Z', i: id })],
  ])('returns null for %j', (s) => {
    expect(decodeCursor(s)).toBeNull()
  })
})
