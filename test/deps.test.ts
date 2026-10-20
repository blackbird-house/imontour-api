import { afterAll, describe, expect, it } from 'vitest'
import { buildDeps } from '../src/deps.js'
import { loadConfig } from '../src/env.js'
import { UnauthorizedError } from '../src/errors.js'
import { createTestSchema, stopTestDatabase } from './helpers/db.js'

const config = loadConfig({
  APP_ENV: 'dev',
  DATABASE_URL: 'postgres://u:p@db.invalid:6543/postgres',
  AUTH_ISSUER: 'https://issuer.test/auth/v1',
  AUTH_JWT_SECRET: 'x'.repeat(32),
})

afterAll(stopTestDatabase)

describe('buildDeps', () => {
  it('wires a verifier that rejects garbage tokens', async () => {
    const { db, schema, drop } = await createTestSchema({ migrate: false })
    try {
      const deps = buildDeps({ ...config, dbSchema: schema }, db)
      await expect(deps.verify('garbage')).rejects.toBeInstanceOf(UnauthorizedError)
      expect(typeof deps.repo.list).toBe('function')
      expect(typeof deps.remoteConfig).toBe('function')
      expect(typeof deps.users.get).toBe('function')
      expect(typeof deps.resolveUser).toBe('function')
    } finally {
      await drop()
    }
  })

  it('wires a no-op identity admin without admin credentials', async () => {
    const deps = buildDeps(config)
    await expect(deps.identityAdmin.deleteIdentity({ issuer: config.auth.issuer, subject: 'x' })).resolves.toBeUndefined()
  })

  it('wires the Supabase identity admin when admin credentials are configured', async () => {
    const calls: string[] = []
    const real = globalThis.fetch
    globalThis.fetch = (async (url: string) => {
      calls.push(url)
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch
    try {
      const deps = buildDeps({ ...config, identityAdmin: { url: 'https://ref.supabase.co', serviceKey: 'k' } })
      await deps.identityAdmin.deleteIdentity({ issuer: config.auth.issuer, subject: 'abc' })
    } finally {
      globalThis.fetch = real
    }
    expect(calls).toEqual(['https://ref.supabase.co/auth/v1/admin/users/abc'])
  })

  it('does no I/O at build time when it creates the db from the URL itself', async () => {
    // postgres.js connects lazily, so creating the db from the URL must not connect either.
    const deps = buildDeps(config)
    expect(deps.repo).toBeDefined()
  })
})
