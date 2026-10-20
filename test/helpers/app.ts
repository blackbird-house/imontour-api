import { createApp, type Deps } from '../../src/app.js'
import type { IdentityProviderAdmin } from '../../src/auth/providerAdmin.js'
import { createUserResolver } from '../../src/auth/resolver.js'
import { createVerifier } from '../../src/auth/verifier.js'
import { createTripRepo } from '../../src/repo/trips.js'
import { createUserRepo } from '../../src/repo/users.js'
import { createTestSchema, stopTestDatabase } from './db.js'
import { TEST_AUDIENCE, TEST_ISSUER, jwksFor, makeKeyPair, signToken } from './tokens.js'

export type TestRequestInit = RequestInit & {
  /** Sends `Authorization: Bearer <token>` for a token whose subject is this value. */
  as?: string
  /** Serialized as the JSON body, with `Content-Type: application/json`. */
  json?: unknown
}

export const stubRemoteConfig = async () => ({ body: {}, etag: '"stub"' })

const unused = () => Promise.reject(new Error('unused'))

/** Deps whose every collaborator fails when called; override what a test needs. */
export function stubDeps(over: Partial<Deps> = {}): Deps {
  return {
    repo: { list: unused, get: unused, create: unused, replace: unused, rename: unused, remove: unused },
    users: { get: unused, update: unused, remove: unused },
    verify: unused,
    resolveUser: unused,
    identityAdmin: { deleteIdentity: unused },
    remoteConfig: stubRemoteConfig,
    ...over,
  }
}

/** Builds the real app over a fresh migrated test schema and a local key pair. */
export async function createTestApp() {
  const { db, schema, drop } = await createTestSchema()
  const keyPair = await makeKeyPair()
  const verify = createVerifier(
    { issuer: TEST_ISSUER, audience: TEST_AUDIENCE, jwksUrl: 'http://unused' },
    await jwksFor(keyPair),
  )
  const deleted: { issuer: string; subject: string }[] = []
  const identityAdmin: IdentityProviderAdmin = {
    deleteIdentity: async ({ issuer, subject }) => {
      deleted.push({ issuer, subject })
    },
  }
  const resolveUser = createUserResolver(db, schema)
  const deps: Deps = {
    repo: createTripRepo(db, schema),
    users: createUserRepo(db, schema),
    verify,
    resolveUser,
    identityAdmin,
    remoteConfig: stubRemoteConfig,
  }
  const app = createApp(deps)

  /** A token for this subject (and optionally email) from the test issuer. */
  const tokenFor = (subject: string, email?: string) => signToken(keyPair, { sub: subject, email })
  /** The internal user id for a subject, provisioning the user as the middleware would. */
  const userIdFor = (subject: string) => resolveUser({ issuer: TEST_ISSUER, subject })

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

  return { app, deps, db, schema, verify, tokenFor, userIdFor, deleted, request, stop }
}
