import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadConfig, type AppEnv } from '../src/env.js'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal'])
const PLACEHOLDERS: Record<string, string> = {
  'project-ref': 'abcdefghijklmnop',
  password: 'pw',
  region: 'eu-west-2',
}

function parse(name: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync(fileURLToPath(new URL(`../env/${name}.env.example`, import.meta.url)), 'utf8').split(
    '\n',
  )) {
    const t = line.trim()
    if (t === '' || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    expect(eq, `bad line: ${t}`).toBeGreaterThan(0)
    out[t.slice(0, eq)] = t.slice(eq + 1)
  }
  return out
}

function concrete(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    out[k] = v.replace(/<([^>]*)>/g, (_m, n: string) => PLACEHOLDERS[n] ?? 'placeholder')
  }
  return out
}

const names: AppEnv[] = ['local', 'dev', 'staging', 'prod']

describe.each(names)('env/%s.env.example', (name) => {
  const raw = parse(name)
  const config = loadConfig(concrete(raw))

  it('loads through loadConfig for its own environment', () => {
    expect(config.appEnv).toBe(name)
    expect(config.dbSchema).toBe(name === 'dev' ? 'dev' : 'public')
  })

  it('sets exactly the intended auth source', () => {
    const { localKeyFile, jwksUrl, jwtSecret } = config.auth
    if (name === 'local') {
      expect(localKeyFile).toBeDefined()
      expect(jwksUrl).toBeUndefined()
      expect(jwtSecret).toBeUndefined()
    } else {
      expect(localKeyFile).toBeUndefined()
      expect(jwksUrl).toBeDefined()
      expect(jwtSecret).toBeUndefined()
    }
  })

  it('keeps secrets as placeholders and deployed databases off local hosts', () => {
    if (name === 'local') return
    expect(raw.DATABASE_URL).toContain('<')
    expect(raw.DATABASE_URL).toMatch(/<[^>]+>/)
    // URL.hostname keeps the brackets of an IPv6 literal.
    const host = new URL(config.databaseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '')
    expect(LOCAL_HOSTS.has(host)).toBe(false)
  })
})
