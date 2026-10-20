import { describe, expect, it } from 'vitest'
import { assertVercelConfig, ConfigError, loadConfig } from '../src/env.js'

const base = {
  APP_ENV: 'dev',
  DATABASE_URL: 'postgres://u:p@db.example.com:5432/app',
  AUTH_ISSUER: 'https://issuer.example.com',
  AUTH_JWKS_URL: 'https://issuer.example.com/.well-known/jwks.json',
}

describe('loadConfig', () => {
  it('parses a valid dev env with defaults', () => {
    const c = loadConfig(base)
    expect(c.appEnv).toBe('dev')
    expect(c.port).toBe(3000)
    expect(c.dbSchema).toBe('public')
    expect(c.configFile).toBe('config/remote-config.json')
    expect(c.auth).toMatchObject({
      issuer: 'https://issuer.example.com',
      audience: 'authenticated',
      jwksUrl: 'https://issuer.example.com/.well-known/jwks.json',
    })
  })

  it('accepts overrides and an HS secret', () => {
    const c = loadConfig({
      ...base,
      AUTH_JWKS_URL: undefined,
      AUTH_JWT_SECRET: 's3cret',
      AUTH_AUDIENCE: 'aud',
      DB_SCHEMA: 'dev',
      PORT: '8080',
      CONFIG_FILE: 'x.json',
    })
    expect(c.port).toBe(8080)
    expect(c.dbSchema).toBe('dev')
    expect(c.configFile).toBe('x.json')
    expect(c.auth.jwtSecret).toBe('s3cret')
    expect(c.auth.audience).toBe('aud')
  })

  it('throws naming DATABASE_URL when missing', () => {
    expect(() => loadConfig({ ...base, DATABASE_URL: undefined })).toThrow(ConfigError)
    expect(() => loadConfig({ ...base, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/)
  })

  it('throws when AUTH_ISSUER is missing', () => {
    expect(() => loadConfig({ ...base, AUTH_ISSUER: undefined })).toThrow(/AUTH_ISSUER/)
  })

  it('rejects an unknown APP_ENV', () => {
    expect(() => loadConfig({ ...base, APP_ENV: 'qa' })).toThrow(/APP_ENV/)
  })

  it('rejects an invalid PORT', () => {
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow(/PORT/)
    expect(() => loadConfig({ ...base, PORT: '3000.5' })).toThrow(/PORT/)
  })

  it('rejects both JWKS url and JWT secret', () => {
    expect(() => loadConfig({ ...base, AUTH_JWT_SECRET: 'x' })).toThrow(ConfigError)
  })

  it('rejects neither JWKS url nor JWT secret', () => {
    expect(() => loadConfig({ ...base, AUTH_JWKS_URL: undefined })).toThrow(/AUTH_JWKS_URL/)
  })

  it('allows local with only AUTH_LOCAL_KEY_FILE', () => {
    const c = loadConfig({
      ...base,
      APP_ENV: 'local',
      AUTH_JWKS_URL: undefined,
      AUTH_LOCAL_KEY_FILE: '.local/key.json',
      DATABASE_URL: 'postgres://u:p@localhost:5432/app',
    })
    expect(c.auth.localKeyFile).toBe('.local/key.json')
  })

  it('rejects AUTH_LOCAL_KEY_FILE outside local', () => {
    for (const appEnv of ['dev', 'staging', 'prod']) {
      expect(() => loadConfig({ ...base, APP_ENV: appEnv, AUTH_LOCAL_KEY_FILE: 'k.json' })).toThrow(
        /AUTH_LOCAL_KEY_FILE/,
      )
    }
  })

  const LOCAL_URLS = [
    'postgres://u:p@localhost:5432/app',
    'postgres://u:p@127.0.0.1:5432/app',
    'postgres://u:p@127.8.9.10:5432/app',
    'postgres://u:p@127.1:5432/app',
    'postgres://u:p@[::1]:5432/app',
    'postgres://u:p@[0:0:0:0:0:0:0:1]:5432/app',
    'postgres://u:p@[::]:5432/app',
    'postgres://u:p@[::ffff:127.0.0.1]:5432/app',
    'postgres://u:p@[::ffff:7f00:2]:5432/app',
    'postgres://u:p@0.0.0.0:5432/app',
    'postgres://u:p@host.docker.internal:5432/app',
    'postgres://u:p@localhost.:5432/app',
    'postgres://u:p@LOCALHOST:5432/app',
    'postgres://u:p@db.localhost:5432/app',
    'postgres://u:p@db.localhost.:5432/app',
    'postgres:///app?host=/var/run/postgresql',
  ]

  it.each(['dev', 'staging', 'prod'])('rejects every local database host when APP_ENV=%s', (appEnv) => {
    for (const url of LOCAL_URLS) {
      expect(() => loadConfig({ ...base, APP_ENV: appEnv, DATABASE_URL: url }), url).toThrow(/DATABASE_URL/)
    }
  })

  it('allows every local database host when APP_ENV=local', () => {
    for (const url of LOCAL_URLS) {
      expect(loadConfig({ ...base, APP_ENV: 'local', DATABASE_URL: url }).databaseUrl, url).toBe(url)
    }
  })

  it('does not mistake look-alike remote hosts for local ones', () => {
    for (const host of ['127.example.com', 'localhost.example.com', 'mylocalhost', '128.0.0.1']) {
      const url = `postgres://u:p@${host}:5432/app`
      expect(loadConfig({ ...base, APP_ENV: 'prod', DATABASE_URL: url }).databaseUrl, url).toBe(url)
    }
  })

  it('allows a remote database in prod', () => {
    expect(loadConfig({ ...base, APP_ENV: 'prod' }).appEnv).toBe('prod')
  })
})

describe('assertVercelConfig', () => {
  it('refuses APP_ENV=local (Vercel is never local)', () => {
    const local = loadConfig({ ...base, APP_ENV: 'local', DATABASE_URL: 'postgres://u:p@localhost:5432/app' })
    expect(() => assertVercelConfig(local)).toThrow(ConfigError)
    expect(() => assertVercelConfig(local)).toThrow(/APP_ENV=local/)
  })

  it.each(['dev', 'staging', 'prod'])('passes APP_ENV=%s through unchanged', (appEnv) => {
    const config = loadConfig({ ...base, APP_ENV: appEnv })
    expect(assertVercelConfig(config)).toBe(config)
  })
})
