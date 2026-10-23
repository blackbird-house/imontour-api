import { describe, expect, it } from 'vitest'
import { formatEtag, parseIfMatch } from '../../src/http/etag.js'

describe('formatEtag', () => {
  it('quotes the revision', () => {
    expect(formatEtag(3)).toBe('"3"')
  })
})

describe('parseIfMatch', () => {
  it('parses quoted and bare integers', () => {
    expect(parseIfMatch('"3"')).toBe(3)
    expect(parseIfMatch('3')).toBe(3)
    expect(parseIfMatch(' "12" ')).toBe(12)
  })

  it('accepts the weak form a compressing CDN turns a strong ETag into', () => {
    expect(parseIfMatch('W/"3"')).toBe(3)
    expect(parseIfMatch('W/"3')).toBe('invalid')
    expect(parseIfMatch('W/3')).toBe('invalid')
  })

  it('reports a missing header', () => {
    expect(parseIfMatch(undefined)).toBe('missing')
  })

  it.each(['abc', '"3', '3"', '-1', '1.5', '0', '"0"', '', '*', '"1", "2"', '1,2', '""', '1e2', '+3'])(
    'rejects %j',
    (v) => {
      expect(parseIfMatch(v)).toBe('invalid')
    },
  )
})
