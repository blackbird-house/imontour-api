import {
  SignJWT,
  UnsecuredJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
  type CryptoKey,
} from 'jose'

export const TEST_ISSUER = 'https://issuer.test/auth/v1'
export const TEST_AUDIENCE = 'authenticated'
export const TEST_USER_ID = '11111111-1111-4111-8111-111111111111'

export type TestKeyPair = { kid: string; privateKey: CryptoKey; publicKey: CryptoKey }

export type TokenClaims = {
  sub?: string | null
  email?: string
  iss?: string
  aud?: string
  /** Absolute expiry, seconds since epoch. Defaults to now + 1h. */
  exp?: number | null
}

let counter = 0

export async function makeKeyPair(): Promise<TestKeyPair> {
  const { privateKey, publicKey } = await generateKeyPair('ES256')
  counter += 1
  return { kid: `test-key-${counter}`, privateKey, publicKey }
}

function payloadFor(claims: TokenClaims) {
  const payload: Record<string, unknown> = {}
  if (claims.sub !== null) payload.sub = claims.sub ?? TEST_USER_ID
  if (claims.email !== undefined) payload.email = claims.email
  return payload
}

export async function signToken(keyPair: TestKeyPair, claims: TokenClaims = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const jwt = new SignJWT(payloadFor(claims))
    .setProtectedHeader({ alg: 'ES256', kid: keyPair.kid })
    .setIssuer(claims.iss ?? TEST_ISSUER)
    .setAudience(claims.aud ?? TEST_AUDIENCE)
    .setIssuedAt(now - 10)
  if (claims.exp !== null) jwt.setExpirationTime(claims.exp ?? now + 3600)
  return jwt.sign(keyPair.privateKey)
}

export async function signHs256(secret: string, claims: TokenClaims = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const jwt = new SignJWT(payloadFor(claims))
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(claims.iss ?? TEST_ISSUER)
    .setAudience(claims.aud ?? TEST_AUDIENCE)
    .setIssuedAt(now - 10)
  if (claims.exp !== null) jwt.setExpirationTime(claims.exp ?? now + 3600)
  return jwt.sign(new TextEncoder().encode(secret))
}

export function signUnsecured(claims: TokenClaims = {}): string {
  const now = Math.floor(Date.now() / 1000)
  return new UnsecuredJWT(payloadFor(claims))
    .setIssuer(claims.iss ?? TEST_ISSUER)
    .setAudience(claims.aud ?? TEST_AUDIENCE)
    .setExpirationTime(claims.exp ?? now + 3600)
    .encode()
}

export async function jwksFor(keyPair: TestKeyPair): Promise<JWTVerifyGetKey> {
  const jwk = await exportJWK(keyPair.publicKey)
  return createLocalJWKSet({ keys: [{ ...jwk, kid: keyPair.kid, alg: 'ES256', use: 'sig' }] })
}
