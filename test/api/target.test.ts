import { describe, expect, it } from 'vitest'
import { assertSafeRemoteUrl, resolveRemoteTarget } from './target.js'

const base = { API_BASE_URL: 'https://api.example.test', API_TEST_TOKEN: 't', API_TEST_ALLOW_REMOTE: '1' }

describe('resolveRemoteTarget', () => {
  it('is local mode when nothing is set', () => {
    expect(resolveRemoteTarget({})).toBeNull()
    expect(resolveRemoteTarget({ API_BASE_URL: ' ', API_TEST_TOKEN: '' })).toBeNull()
  })

  it('needs both the url and the token', () => {
    expect(() => resolveRemoteTarget({ API_BASE_URL: 'https://x.test' })).toThrow(/both/)
    expect(() => resolveRemoteTarget({ API_TEST_TOKEN: 't' })).toThrow(/both/)
  })

  it('requires the explicit opt-in', () => {
    expect(() => resolveRemoteTarget({ ...base, API_TEST_ALLOW_REMOTE: undefined })).toThrow(/API_TEST_ALLOW_REMOTE=1/)
    expect(() => resolveRemoteTarget({ ...base, API_TEST_ALLOW_REMOTE: 'true' })).toThrow(/API_TEST_ALLOW_REMOTE=1/)
  })

  it('normalizes the base url and carries the optional second token', () => {
    expect(
      resolveRemoteTarget({ ...base, API_BASE_URL: 'https://api.example.test/', API_TEST_TOKEN_OTHER: 'o' }),
    ).toEqual({
      baseUrl: 'https://api.example.test',
      token: 't',
      otherToken: 'o',
    })
  })
})

describe('assertSafeRemoteUrl', () => {
  it.each([
    'https://api.example.test',
    'http://localhost:3000',
    'http://127.0.0.1:8080',
    'http://[::1]:3000',
    'http://a.localhost',
  ])('accepts %s', (url) => {
    expect(() => assertSafeRemoteUrl(url)).not.toThrow()
  })

  it.each(['http://api.example.test', 'http://10.0.0.5:3000', 'ftp://localhost', 'nonsense'])('refuses %s', (url) => {
    expect(() => assertSafeRemoteUrl(url)).toThrow()
  })
})
