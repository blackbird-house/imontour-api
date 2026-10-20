/**
 * Resolves what the black-box API suite talks to.
 *
 * - Local (default): `startLocalTarget` boots the real app on an ephemeral loopback port.
 * - Remote: API_BASE_URL + API_TEST_TOKEN (+ explicit API_TEST_ALLOW_REMOTE=1) point the suite at
 *   an already running server. Never aim it at production: it creates and deletes real trips.
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { createApp } from '../../src/app.js'
import { ensureLocalKeyFile, signLocalToken } from '../../src/auth/localKeys.js'
import { buildDeps } from '../../src/deps.js'
import { loadConfig } from '../../src/env.js'
import { createTestSchema, stopTestDatabase } from '../helpers/db.js'

export type ApiTarget = {
  mode: 'local' | 'remote'
  baseUrl: string
  /** Token of the primary test user. */
  token: string
  /** Token of a second user, when available (always locally; optional remotely). */
  otherToken?: string
  /** Token of a throwaway user for DELETE /v1/me (local only). */
  disposableToken?: () => Promise<string>
  /** Token signed by the right key but already expired (local only). */
  expiredToken?: () => Promise<string>
  stop(): Promise<void>
}

export type RemoteTarget = { baseUrl: string; token: string; otherToken?: string }

const LOOPBACK = /^(localhost|127(\.\d+){3}|\[::1\]|::1|.+\.localhost)$/i

/** Throws unless the URL is https or plain http to a loopback host. */
export function assertSafeRemoteUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`API_BASE_URL is not a valid URL: ${raw}`)
  }
  const loopback = LOOPBACK.test(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(
      `API_BASE_URL must be https (or http on a loopback host); refusing ${url.protocol}//${url.hostname}`,
    )
  }
  return url
}

/** Returns the remote target described by env, or null for local mode. Throws on unsafe or partial config. */
export function resolveRemoteTarget(env: Record<string, string | undefined>): RemoteTarget | null {
  const baseUrl = env.API_BASE_URL?.trim()
  const token = env.API_TEST_TOKEN?.trim()
  if (!baseUrl && !token) return null
  if (!baseUrl || !token) throw new Error('Remote mode needs both API_BASE_URL and API_TEST_TOKEN')
  if (env.API_TEST_ALLOW_REMOTE !== '1') {
    throw new Error('Refusing to run against a remote server: set API_TEST_ALLOW_REMOTE=1 to opt in (never use prod)')
  }
  const url = assertSafeRemoteUrl(baseUrl)
  const otherToken = env.API_TEST_TOKEN_OTHER?.trim()
  return { baseUrl: url.origin + url.pathname.replace(/\/+$/, ''), token, ...(otherToken ? { otherToken } : {}) }
}

const ISSUER = 'http://localhost:3000/local-auth'
const AUDIENCE = 'authenticated'

export async function startLocalTarget(): Promise<ApiTarget> {
  const dir = await mkdtemp(join(tmpdir(), 'imontour-api-'))
  const keyFile = join(dir, 'jwks.json')
  const harness = await createTestSchema()
  const config = loadConfig({
    APP_ENV: 'local',
    // The harness db is injected below, so this URL is never connected to.
    DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:54329/imontour',
    DB_SCHEMA: harness.schema,
    AUTH_ISSUER: ISSUER,
    AUTH_LOCAL_KEY_FILE: keyFile,
  })
  await ensureLocalKeyFile(keyFile)
  const app = createApp(buildDeps(config, harness.db))

  let server!: ReturnType<typeof serve>
  const port = await new Promise<number>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve(info.port))
  })

  const sign = (opts: { sub?: string; expiresIn?: string } = {}) =>
    signLocalToken(keyFile, { sub: opts.sub ?? randomUUID(), iss: ISSUER, aud: AUDIENCE, expiresIn: opts.expiresIn })

  return {
    mode: 'local',
    baseUrl: `http://127.0.0.1:${port}`,
    token: await sign(),
    otherToken: await sign(),
    disposableToken: () => sign(),
    expiredToken: () => sign({ expiresIn: '10 minutes ago' }),
    async stop() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        if ('closeAllConnections' in server) server.closeAllConnections()
      })
      await harness.drop()
      await stopTestDatabase()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

export async function createTarget(env: Record<string, string | undefined> = process.env): Promise<ApiTarget> {
  const remote = resolveRemoteTarget(env)
  if (!remote) return startLocalTarget()
  return { mode: 'remote', ...remote, stop: async () => {} }
}
