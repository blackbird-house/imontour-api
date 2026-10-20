import { createApp } from '../../src/app.js'
import { createVerifier } from '../../src/auth/verifier.js'
import { createTripRepo } from '../../src/repo/trips.js'
import { createTestSchema, stopTestDatabase } from './db.js'
import { TEST_AUDIENCE, TEST_ISSUER, jwksFor, makeKeyPair, signToken } from './tokens.js'

export type TestRequestInit = RequestInit & {
  /** Sends `Authorization: Bearer <token for this user id>`. */
  as?: string
  /** Serialized as the JSON body, with `Content-Type: application/json`. */
  json?: unknown
}

export const stubRemoteConfig = async () => ({ body: {}, etag: '"stub"' })

/** Builds the real app over a fresh migrated test schema and a local key pair. */
export async function createTestApp() {
  const { db, schema, drop } = await createTestSchema()
  const keyPair = await makeKeyPair()
  const verify = createVerifier(
    { issuer: TEST_ISSUER, audience: TEST_AUDIENCE, jwksUrl: 'http://unused' },
    await jwksFor(keyPair),
  )
  const app = createApp({ repo: createTripRepo(db, schema), verify, remoteConfig: stubRemoteConfig })

  const tokenFor = (userId: string) => signToken(keyPair, { sub: userId })

  async function request(path: string, init: TestRequestInit = {}): Promise<Response> {
    const { as, json, ...rest } = init
    const headers = new Headers(rest.headers)
    if (as !== undefined) headers.set('Authorization', `Bearer ${await tokenFor(as)}`)
    let body = rest.body
    if (json !== undefined) {
      body = JSON.stringify(json)
      headers.set('Content-Type', 'application/json')
    }
    return app.request(path, { ...rest, headers, body })
  }

  async function stop(): Promise<void> {
    await drop()
    await stopTestDatabase()
  }

  return { app, verify, tokenFor, request, stop }
}
