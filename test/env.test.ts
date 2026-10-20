import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../src/env.js'

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

  it('rejects prod with a local database host', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]', '0.0.0.0', 'host.docker.internal']) {
      expect(() =>
        loadConfig({ ...base, APP_ENV: 'prod', DATABASE_URL: `postgres://u:p@${host}:5432/app` }),
      ).toThrow(/DATABASE_URL/)
    }
  })

  it('allows a remote database in prod', () => {
    expect(loadConfig({ ...base, APP_ENV: 'prod' }).appEnv).toBe('prod')
  })
})
