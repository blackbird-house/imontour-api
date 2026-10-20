import { z } from 'zod'

export type AppEnv = 'local' | 'dev' | 'staging' | 'prod'
export type AuthConfig = {
  issuer: string
  audience: string
  jwksUrl?: string
  jwtSecret?: string
  localKeyFile?: string
}
export type Config = {
  appEnv: AppEnv
  port: number
  databaseUrl: string
  dbSchema: string
  auth: AuthConfig
  configFile: string
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal'])

// Empty strings are treated as unset.
const optional = z.string().trim().min(1).optional()

const schema = z.object({
  APP_ENV: z.enum(['local', 'dev', 'staging', 'prod']),
  PORT: z.string().regex(/^\d+$/, 'must be an integer').default('3000'),
  DATABASE_URL: z.string().trim().min(1),
  DB_SCHEMA: z.string().trim().min(1).default('public'),
  AUTH_ISSUER: z.string().trim().min(1),
  AUTH_AUDIENCE: z.string().trim().min(1).default('authenticated'),
  AUTH_JWKS_URL: optional,
  AUTH_JWT_SECRET: optional,
  AUTH_LOCAL_KEY_FILE: optional,
  CONFIG_FILE: z.string().trim().min(1).default('config/remote-config.json'),
})

function hostOf(databaseUrl: string): string {
  try {
    const host = new URL(databaseUrl).hostname.toLowerCase()
    return host.replace(/^\[|\]$/g, '')
  } catch {
    throw new ConfigError('DATABASE_URL is not a valid URL')
  }
}

/**
 * True for any host that resolves to this machine (or a Unix socket): loopback
 * names and addresses in all common spellings, the unspecified address, and an
 * empty host (`postgres:///db?host=/var/run/postgresql`).
 */
export function isLocalHost(rawHost: string): boolean {
  const host = rawHost.replace(/\.+$/, '')
  if (host === '') return true
  if (LOCAL_HOSTS.has(host) || host.endsWith('.localhost')) return true
  if (host === '::' || host === '0:0:0:0:0:0:0:1' || host === '0:0:0:0:0:0:0:0') return true
  if (/^127(\.\d+){0,3}$/.test(host)) return true // 127.0.0.0/8, including shorthand like 127.1
  if (/^::ffff:127(\.\d+){3}$/.test(host)) return true // IPv4-mapped loopback, dotted
  if (/^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host)) return true // IPv4-mapped loopback, hex
  return false
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const normalized: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) normalized[k] = v === '' ? undefined : v

  const parsed = schema.safeParse(normalized)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!
    const name = String(issue.path[0] ?? 'env')
    throw new ConfigError(`${name}: ${issue.message}`)
  }
  const e = parsed.data

  const port = Number.parseInt(e.PORT, 10)
  if (port < 0 || port > 65535) throw new ConfigError('PORT: must be between 0 and 65535')

  if (e.AUTH_JWKS_URL && e.AUTH_JWT_SECRET) {
    throw new ConfigError('AUTH_JWKS_URL and AUTH_JWT_SECRET are mutually exclusive; set only one')
  }
  if (e.AUTH_LOCAL_KEY_FILE && e.APP_ENV !== 'local') {
    throw new ConfigError('AUTH_LOCAL_KEY_FILE is only allowed when APP_ENV=local')
  }
  const hasAuth = e.AUTH_JWKS_URL || e.AUTH_JWT_SECRET || (e.APP_ENV === 'local' && e.AUTH_LOCAL_KEY_FILE)
  if (!hasAuth) {
    throw new ConfigError('AUTH_JWKS_URL or AUTH_JWT_SECRET is required (exactly one)')
  }

  if (e.APP_ENV !== 'local' && isLocalHost(hostOf(e.DATABASE_URL))) {
    throw new ConfigError(`DATABASE_URL must not point at a local host when APP_ENV=${e.APP_ENV}`)
  }

  const auth: AuthConfig = { issuer: e.AUTH_ISSUER, audience: e.AUTH_AUDIENCE }
  if (e.AUTH_JWKS_URL) auth.jwksUrl = e.AUTH_JWKS_URL
  if (e.AUTH_JWT_SECRET) auth.jwtSecret = e.AUTH_JWT_SECRET
  if (e.AUTH_LOCAL_KEY_FILE) auth.localKeyFile = e.AUTH_LOCAL_KEY_FILE

  return {
    appEnv: e.APP_ENV,
    port,
    databaseUrl: e.DATABASE_URL,
    dbSchema: e.DB_SCHEMA,
    auth,
    configFile: e.CONFIG_FILE,
  }
}

/**
 * Guard for the Vercel entrypoint: a serverless deployment is never `local`
 * (that mode trusts local hosts and a local key file). Returns the config unchanged.
 */
export function assertVercelConfig(config: Config): Config {
  if (config.appEnv === 'local') {
    throw new ConfigError('APP_ENV=local is not allowed on Vercel; use dev, staging or prod')
  }
  return config
}
