import { describe, expect, it, beforeAll } from 'vitest'
import { Hono } from 'hono'
import { errors as joseErrors, type JWTVerifyGetKey } from 'jose'
import { createVerifier } from '../../src/auth/verifier.js'
import { bearerAuth, type AuthVariables } from '../../src/auth/middleware.js'
import { ApiError, errorHandler, UnauthorizedError } from '../../src/errors.js'
import {
  TEST_AUDIENCE,
  TEST_ISSUER,
  TEST_USER_ID,
  jwksFor,
  makeKeyPair,
  signHs256,
  signToken,
  signUnsecured,
  type TestKeyPair,
} from '../helpers/tokens.js'

const auth = { issuer: TEST_ISSUER, audience: TEST_AUDIENCE, jwksUrl: 'https://issuer.test/jwks.json' }
const now = () => Math.floor(Date.now() / 1000)

let kp: TestKeyPair
let verify: ReturnType<typeof createVerifier>

beforeAll(async () => {
  kp = await makeKeyPair()
  verify = createVerifier(auth, await jwksFor(kp))
})

describe('createVerifier (JWKS mode)', () => {
  it('accepts a valid token and returns the issuer and subject', async () => {
    await expect(verify(await signToken(kp))).resolves.toEqual({ issuer: TEST_ISSUER, subject: TEST_USER_ID })
  })

  it('keeps the subject exactly as issued (opaque, not necessarily a UUID)', async () => {
    for (const sub of ['ABCDEF00-1111-4111-8111-111111111111', 'user-1', 'apple|001234.abcd']) {
      await expect(verify(await signToken(kp, { sub }))).resolves.toEqual({ issuer: TEST_ISSUER, subject: sub })
    }
  })

  it('returns the email claim when present, and omits it otherwise', async () => {
    await expect(verify(await signToken(kp, { email: 'a@example.com' }))).resolves.toEqual({
      issuer: TEST_ISSUER,
      subject: TEST_USER_ID,
      email: 'a@example.com',
    })
    expect(await verify(await signToken(kp))).not.toHaveProperty('email')
  })

  it('ignores an email it cannot store or that is absurdly long', async () => {
    for (const email of ['', 'a\u0000b@example.com', `${'a'.repeat(320)}@example.com`]) {
      expect(await verify(await signToken(kp, { email }))).not.toHaveProperty('email')
    }
  })

  it('rejects an expired token', async () => {
    await expect(verify(await signToken(kp, { exp: now() - 3600 }))).rejects.toBeInstanceOf(UnauthorizedError)
  })

  it('rejects the wrong audience', async () => {
    await expect(verify(await signToken(kp, { aud: 'other' }))).rejects.toBeInstanceOf(UnauthorizedError)
  })

  it('rejects the wrong issuer', async () => {
    await expect(verify(await signToken(kp, { iss: 'https://evil.test' }))).rejects.toBeInstanceOf(UnauthorizedError)
  })

  it('rejects a token signed by a different key', async () => {
    const other = await makeKeyPair()
    await expect(verify(await signToken({ ...other, kid: kp.kid }))).rejects.toBeInstanceOf(UnauthorizedError)
  })

  it('rejects alg none', async () => {
    await expect(verify(signUnsecured())).rejects.toBeInstanceOf(UnauthorizedError)
  })

  it('rejects garbage', async () => {
    await expect(verify('not-a-jwt')).rejects.toBeInstanceOf(UnauthorizedError)
  })

  it('rejects an HS256 token when only JWKS is configured', async () => {
    await expect(verify(await signHs256('s'.repeat(32)))).rejects.toBeInstanceOf(UnauthorizedError)
  })

  it('accepts a token that expired 30 s ago (clock skew)', async () => {
    await expect(verify(await signToken(kp, { exp: now() - 30 }))).resolves.toMatchObject({ subject: TEST_USER_ID })
  })

  it('rejects a token that expired 90 s ago', async () => {
    await expect(verify(await signToken(kp, { exp: now() - 90 }))).rejects.toBeInstanceOf(UnauthorizedError)
  })

  it('rejects a token without exp', async () => {
    await expect(verify(await signToken(kp, { exp: null }))).rejects.toBeInstanceOf(UnauthorizedError)
  })

  it('rejects a missing sub', async () => {
    await expect(verify(await signToken(kp, { sub: null }))).rejects.toBeInstanceOf(UnauthorizedError)
  })

  it('rejects an empty, oversized or NUL-containing sub', async () => {
    for (const sub of ['', 'x'.repeat(256), 'a\u0000b']) {
      await expect(verify(await signToken(kp, { sub }))).rejects.toBeInstanceOf(UnauthorizedError)
    }
  })

  it('does not leak the underlying error message', async () => {
    const err = await verify('not-a-jwt').catch((e: unknown) => e)
    expect((err as Error).message).toBe('Invalid or missing token')
  })
})

describe('createVerifier (secret mode)', () => {
  const secret = 'a-shared-secret-of-sufficient-length'
  const secretVerify = createVerifier({ issuer: TEST_ISSUER, audience: TEST_AUDIENCE, jwtSecret: secret })

  it('accepts an HS256 token', async () => {
    await expect(secretVerify(await signHs256(secret))).resolves.toEqual({ issuer: TEST_ISSUER, subject: TEST_USER_ID })
  })

  it('rejects an HS256 token with the wrong secret', async () => {
    await expect(secretVerify(await signHs256('x'.repeat(40)))).rejects.toBeInstanceOf(UnauthorizedError)
  })

  it('rejects an HS256 token without exp', async () => {
    await expect(secretVerify(await signHs256(secret, { exp: null }))).rejects.toBeInstanceOf(UnauthorizedError)
  })

  it('rejects an ES256 token', async () => {
    await expect(secretVerify(await signToken(kp))).rejects.toBeInstanceOf(UnauthorizedError)
  })

  it('rejects the wrong issuer', async () => {
    await expect(secretVerify(await signHs256(secret, { iss: 'https://evil.test' }))).rejects.toBeInstanceOf(
      UnauthorizedError,
    )
  })

  it('rejects the wrong audience', async () => {
    await expect(secretVerify(await signHs256(secret, { aud: 'other' }))).rejects.toBeInstanceOf(UnauthorizedError)
  })

  it('rejects an expired token', async () => {
    await expect(secretVerify(await signHs256(secret, { exp: now() - 3600 }))).rejects.toBeInstanceOf(
      UnauthorizedError,
    )
  })
})

describe('createVerifier construction', () => {
  it('throws a plain configuration Error when no key source resolves', () => {
    let thrown: unknown
    try {
      createVerifier({ issuer: TEST_ISSUER, audience: TEST_AUDIENCE })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown).not.toBeInstanceOf(ApiError)
    expect((thrown as Error).message).toMatch(/no key source/i)
  })

  it('accepts injected keys without any configured source', () => {
    expect(() => createVerifier({ issuer: TEST_ISSUER, audience: TEST_AUDIENCE }, async () => kp.publicKey)).not.toThrow()
  })
})

describe('createVerifier (key service failures)', () => {
  const throwing =
    (err: unknown): JWTVerifyGetKey =>
    async () => {
      throw err
    }

  async function failure(getKey: JWTVerifyGetKey): Promise<unknown> {
    const v = createVerifier(auth, getKey)
    return v(await signToken(kp)).catch((e: unknown) => e)
  }

  it.each([
    ['a JWKS timeout', new joseErrors.JWKSTimeout()],
    ['an invalid JWKS response', new joseErrors.JWKSInvalid()],
    ['a non-200 JWKS response', new joseErrors.JOSEError('Expected 200 OK from the JSON Web Key Set HTTP response')],
    ['a network error', new TypeError('fetch failed')],
  ])('maps %s to 503 service_unavailable', async (_label, err) => {
    const e = await failure(throwing(err))
    expect(e).toBeInstanceOf(ApiError)
    expect(e).toMatchObject({ status: 503, code: 'service_unavailable', message: 'Authentication service unavailable' })
  })

  it('keeps no matching key a 401', async () => {
    expect(await failure(throwing(new joseErrors.JWKSNoMatchingKey()))).toBeInstanceOf(UnauthorizedError)
  })
})

describe('bearerAuth middleware', () => {
  const app = new Hono<{ Variables: AuthVariables }>()
  app.onError(errorHandler)
  const seen: unknown[] = []
  app.use(
    '*',
    bearerAuth(
      (token) => verify(token),
      async (identity) => {
        seen.push(identity)
        return `internal-${identity.subject}`
      },
    ),
  )
  app.get('/me', (c) => c.json({ userId: c.get('userId') }))

  const call = (headers?: Record<string, string>) => app.request('/me', { headers })

  async function expectUnauthorized(res: Response) {
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: { code: 'unauthorized', message: 'Invalid or missing token' } })
  }

  it('sets userId to the resolved internal id for a valid bearer token', async () => {
    const res = await call({ Authorization: `Bearer ${await signToken(kp)}` })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ userId: `internal-${TEST_USER_ID}` })
    expect(seen.at(-1)).toEqual({ issuer: TEST_ISSUER, subject: TEST_USER_ID })
  })

  it('does not resolve a user for a rejected token', async () => {
    const before = seen.length
    await expectUnauthorized(await call({ Authorization: 'Bearer nope' }))
    expect(seen).toHaveLength(before)
  })

  it('accepts a case-insensitive scheme', async () => {
    const res = await call({ Authorization: `bearer ${await signToken(kp)}` })
    expect(res.status).toBe(200)
  })

  it('401 when the header is missing', async () => expectUnauthorized(await call()))
  it('401 for Basic auth', async () => expectUnauthorized(await call({ Authorization: 'Basic x' })))
  it('401 for an empty bearer', async () => expectUnauthorized(await call({ Authorization: 'Bearer ' })))
  it('401 for extra tokens', async () => expectUnauthorized(await call({ Authorization: 'Bearer a b' })))
  it('401 for an invalid token', async () => expectUnauthorized(await call({ Authorization: 'Bearer nope' })))
})
