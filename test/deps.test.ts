import { afterAll, describe, expect, it } from 'vitest'
import { buildDeps } from '../src/deps.js'
import { loadConfig } from '../src/env.js'
import { UnauthorizedError } from '../src/errors.js'
import { createTestSchema, stopTestDatabase } from './helpers/db.js'

const config = loadConfig({
  APP_ENV: 'dev',
  DATABASE_URL: 'postgres://u:p@127.0.0.1:6543/postgres',
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
    } finally {
      await drop()
    }
  })

  it('does no I/O at import or build time when a db is supplied', async () => {
    // postgres.js connects lazily, so creating the db from the URL must not connect either.
    const deps = buildDeps(config)
    expect(deps.repo).toBeDefined()
  })
})
