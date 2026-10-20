import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import type { AuthConfig } from '../env.js'
import { UnauthorizedError } from '../errors.js'
import { readLocalKeyFile } from './localKeys.js'

export type VerifyToken = (token: string) => Promise<{ userId: string }>

const ASYMMETRIC_ALGS = ['ES256', 'RS256', 'EdDSA']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
      local ??= readLocalKeyFile(file).then(({ kid, publicJwk }) =>
        createLocalJWKSet({ keys: [{ ...publicJwk, kid, alg: 'ES256', use: 'sig' }] }),
      )
      return (await local)(header, token)
    }
  }

  return async (token) => {
    let sub: unknown
    try {
      const options = { ...common, algorithms }
      const result = secretKey
        ? await jwtVerify(token, secretKey, options)
        : await jwtVerify(token, resolveKey as JWTVerifyGetKey, options)
      sub = result.payload.sub
    } catch {
      throw new UnauthorizedError()
    }
    if (typeof sub !== 'string' || !UUID.test(sub)) throw new UnauthorizedError()
    return { userId: sub.toLowerCase() }
  }
}
