import { createLocalJWKSet, createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose'
import type { AuthConfig } from '../env.js'
import { ApiError, UnauthorizedError } from '../errors.js'
import { readLocalKeyFile } from './localKeys.js'

/**
 * What a verified token proves: "issuer says subject". The subject is opaque
 * (a UUID for Supabase, anything for other providers) and is mapped to our own
 * user id by the UserResolver. `email` is informational and never used to link accounts.
 */
export type Identity = { issuer: string; subject: string; email?: string }

export type VerifyToken = (token: string) => Promise<Identity>

const ASYMMETRIC_ALGS = ['ES256', 'RS256', 'EdDSA']
const MAX_SUBJECT_LENGTH = 255
const MAX_EMAIL_LENGTH = 320

/** Postgres text cannot hold NUL; anything else is stored as given. */
const storable = (s: string) => !s.includes('\u0000')

export const authUnavailable = () => new ApiError(503, 'service_unavailable', 'Authentication service unavailable')

/**
 * True when the key getter failed to obtain keys at all (timeout, network
 * error, non-200 or unparsable JWKS response), as opposed to the token being
 * bad. jose reports a non-200 or non-JSON response as a bare JOSEError.
 */
function isKeyFetchFailure(err: unknown): boolean {
  if (!(err instanceof errors.JOSEError)) return true
  return err instanceof errors.JWKSTimeout || err instanceof errors.JWKSInvalid || err.code === errors.JOSEError.code
}

/**
 * Wraps a key getter so a key service outage becomes a 503 instead of a 401:
 * clients must not sign users out because Supabase is unreachable.
 */
function guardKeyFetch(getKey: JWTVerifyGetKey): JWTVerifyGetKey {
  return async (header, token) => {
    try {
      return await getKey(header, token)
    } catch (err) {
      throw isKeyFetchFailure(err) ? authUnavailable() : err
    }
  }
}

export function createVerifier(auth: AuthConfig, keys?: JWTVerifyGetKey): VerifyToken {
  const common = { issuer: auth.issuer, audience: auth.audience, clockTolerance: 60, requiredClaims: ['exp', 'sub'] }

  let resolveKey: JWTVerifyGetKey | undefined = keys
  let algorithms = ASYMMETRIC_ALGS
  let secretKey: Uint8Array | undefined

  if (auth.jwtSecret) {
    secretKey = new TextEncoder().encode(auth.jwtSecret)
    algorithms = ['HS256']
  } else if (!resolveKey && auth.jwksUrl) {
    resolveKey = createRemoteJWKSet(new URL(auth.jwksUrl))
  } else if (!resolveKey && auth.localKeyFile) {
    const file = auth.localKeyFile
    let local: Promise<JWTVerifyGetKey> | undefined
    resolveKey = async (header, token) => {
      local ??= readLocalKeyFile(file)
        .then(({ kid, publicJwk }) => createLocalJWKSet({ keys: [{ ...publicJwk, kid, alg: 'ES256', use: 'sig' }] }))
        .catch((err: unknown) => {
          // Do not cache a failed key-file read; retry on the next request.
          local = undefined
          throw err
        })
      return (await local)(header, token)
    }
  }

  if (!secretKey && !resolveKey) {
    throw new Error('createVerifier: no key source (set jwtSecret, jwksUrl or localKeyFile, or inject keys)')
  }
  const getKey = resolveKey ? guardKeyFetch(resolveKey) : undefined

  return async (token) => {
    let payload: JWTPayload
    try {
      const options = { ...common, algorithms }
      const result = secretKey
        ? await jwtVerify(token, secretKey, options)
        : await jwtVerify(token, getKey as JWTVerifyGetKey, options)
      payload = result.payload
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) throw err
      throw new UnauthorizedError()
    }
    const { sub, iss, email } = payload
    // jwtVerify already required iss to equal the configured issuer and sub to be present.
    if (typeof iss !== 'string' || typeof sub !== 'string') throw new UnauthorizedError()
    if (sub === '' || sub.length > MAX_SUBJECT_LENGTH || !storable(sub)) throw new UnauthorizedError()
    const identity: Identity = { issuer: iss, subject: sub }
    if (typeof email === 'string' && email !== '' && email.length <= MAX_EMAIL_LENGTH && storable(email)) {
      identity.email = email
    }
    return identity
  }
}
