import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerType } from '@hono/node-server'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig, type Config } from '../src/env.js'
import { createShutdown, startServer } from '../src/lifecycle.js'
import { createTestSchema, stopTestDatabase } from './helpers/db.js'

afterAll(stopTestDatabase)

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'imontour-lifecycle-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function config(over: Record<string, string>): Config {
  return loadConfig({
    APP_ENV: 'local',
    PORT: '0',
    // The harness db is injected, so this URL is never connected to.
    DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:54329/imontour',
    AUTH_ISSUER: 'http://localhost:3000/local-auth',
    AUTH_LOCAL_KEY_FILE: join(dir, 'jwks.json'),
    CONFIG_FILE: 'config/remote-config.json',
    ...over,
  })
}

const close = (server: ServerType) =>
  new Promise<void>((resolve) => {
    server.close(() => resolve())
    if ('closeAllConnections' in server) server.closeAllConnections()
  })

describe('startServer', () => {
  it('local: creates the key file, migrates, logs requests and serves over a real socket', async () => {
    const harness = await createTestSchema({ migrate: false })
    const lines: string[] = []
    const requestLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { server, port } = await startServer(config({ DB_SCHEMA: harness.schema }), harness.db, (l) => lines.push(l))
    try {
      expect(lines.some((l) => l.startsWith('applied 001'))).toBe(true)
      expect(lines.at(-1)).toBe(`imontour-api listening on :${port} (local)`)

      const ok = await fetch(`http://127.0.0.1:${port}/v1/config`)
      expect(ok.status).toBe(200)
      await ok.arrayBuffer()
      const missing = await fetch(`http://127.0.0.1:${port}/nope`)
      expect(missing.status).toBe(404)
      expect(await missing.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } })

      const logged = requestLog.mock.calls.map((c) => String(c[0]))
      expect(logged.some((l) => l.includes('GET') && l.includes('/v1/config'))).toBe(true)
    } finally {
      requestLog.mockRestore()
      await close(server)
      await harness.drop()
    }
  })

  it('deployed: does not migrate and does not log requests', async () => {
    const harness = await createTestSchema({ migrate: false })
    const lines: string[] = []
    const requestLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    const deployed = loadConfig({
      APP_ENV: 'dev',
      PORT: '0',
      DATABASE_URL: 'postgres://u:p@db.invalid:6543/postgres',
      DB_SCHEMA: harness.schema,
      AUTH_ISSUER: 'https://issuer.test/auth/v1',
      AUTH_JWT_SECRET: 'x'.repeat(32),
    })
    const { server, port } = await startServer(deployed, harness.db, (l) => lines.push(l))
    try {
      expect(lines).toEqual([`imontour-api listening on :${port} (dev)`])
      const res = await fetch(`http://127.0.0.1:${port}/v1/config`)
      expect(res.status).toBe(200)
      await res.arrayBuffer()
      expect(requestLog).not.toHaveBeenCalled()
      // Nothing was migrated: the schema has no tables.
      const tables = await harness.db`select 1 from information_schema.tables where table_schema = ${harness.schema}`
      expect(tables).toHaveLength(0)
    } finally {
      requestLog.mockRestore()
      await close(server)
      await harness.drop()
    }
  })

  it('rejects when the port is already taken', async () => {
    const harness = await createTestSchema()
    const first = await startServer(config({ DB_SCHEMA: harness.schema }), harness.db, () => {})
    try {
      await expect(
        startServer(config({ DB_SCHEMA: harness.schema, PORT: String(first.port) }), harness.db, () => {}),
      ).rejects.toThrow(/EADDRINUSE/)
    } finally {
      await close(first.server)
      await harness.drop()
    }
  })
})

describe('createShutdown', () => {
  function fakes(endResult: Promise<void>) {
    let onClose = () => {}
    const server = {
      close: vi.fn((cb?: () => void) => {
        onClose = cb ?? (() => {})
        return undefined as never
      }),
      closeAllConnections: vi.fn(),
    }
    const db = { end: vi.fn(() => endResult) }
    const exit = vi.fn()
    return { server, db, exit, finishClose: () => onClose() }
  }
  const flush = () => new Promise((r) => setImmediate(r))

  it('closes the server, drops idle connections, ends the db and exits 0', async () => {
    const f = fakes(Promise.resolve())
    const shutdown = createShutdown(f.server, f.db, f.exit)
    shutdown()
    expect(f.server.close).toHaveBeenCalledTimes(1)
    expect(f.server.closeAllConnections).toHaveBeenCalledTimes(1)
    expect(f.db.end).not.toHaveBeenCalled()
    f.finishClose()
    await flush()
    expect(f.db.end).toHaveBeenCalledWith({ timeout: 5 })
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(0)
  })

  it('is idempotent', () => {
    const f = fakes(Promise.resolve())
    const shutdown = createShutdown(f.server, f.db, f.exit)
    shutdown()
    shutdown()
    expect(f.server.close).toHaveBeenCalledTimes(1)
  })

  it('exits 1 when the db cannot be closed', async () => {
    const f = fakes(Promise.reject(new Error('boom')))
    createShutdown(f.server, f.db, f.exit)()
    f.finishClose()
    await flush()
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('exits 1 when draining hangs past the deadline', async () => {
    vi.useFakeTimers()
    try {
      const f = fakes(Promise.resolve())
      createShutdown(f.server, f.db, f.exit, 5_000)()
      await vi.advanceTimersByTimeAsync(4_999)
      expect(f.exit).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(f.exit).toHaveBeenCalledExactlyOnceWith(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('works with servers that cannot closeAllConnections (HTTP/2)', () => {
    const f = fakes(Promise.resolve())
    const server = { close: f.server.close }
    expect(() => createShutdown(server, f.db, f.exit)()).not.toThrow()
  })
})
