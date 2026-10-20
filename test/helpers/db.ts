import { randomBytes, randomUUID } from 'node:crypto'
import { createDb, runMigrations, type Db } from '../../src/db/client.js'
import { TEST_ISSUER } from './tokens.js'

/**
 * Test database harness.
 *
 * - If TEST_DATABASE_URL is set (CI, Docker users) it is used directly.
 * - Otherwise an in-process PGlite is started lazily (once per module instance,
 *   i.e. once per test file under vitest) and served over the Postgres wire
 *   protocol on a free loopback port, so the normal `postgres` client works.
 *
 * Tests should call `await stopTestDatabase()` in an `afterAll` (after
 * `drop()`); it is a no-op when TEST_DATABASE_URL is used.
 */

type Running = { url: string; stop: () => Promise<void> }
let running: Promise<Running> | undefined
const opened = new Set<Db>()

async function startPglite(): Promise<Running> {
  const { PGlite } = await import('@electric-sql/pglite')
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket')
  const pg = await PGlite.create()
  const server = new PGLiteSocketServer({ db: pg, port: 0, host: '127.0.0.1' })
  await server.start()
  const url = `postgres://postgres:postgres@${server.getServerConn()}/postgres`
  return {
    url,
    stop: async () => {
      await server.stop()
      await pg.close()
    },
  }
}

function getRunning(): Promise<Running> {
  const external = process.env.TEST_DATABASE_URL
  running ??= external
    ? Promise.resolve({ url: external, stop: async () => {} })
    : startPglite()
  return running
}

export async function createTestSchema(
  opts: { migrate?: boolean } = {},
): Promise<{ db: Db; schema: string; drop(): Promise<void> }> {
  const { url } = await getRunning()
  // PGlite serves one connection at a time, so use a single pooled connection;
  // a real server gets two so concurrency tests really run concurrently.
  const db = createDb(url, { max: process.env.TEST_DATABASE_URL ? 2 : 1 })
  opened.add(db)
  const schema = `t_${randomBytes(6).toString('hex')}`
  if (opts.migrate !== false) await runMigrations(db, schema, { authIssuer: TEST_ISSUER })
  return {
    db,
    schema,
    async drop() {
      await db.unsafe(`drop schema if exists "${schema}" cascade`)
      await db.end({ timeout: 5 })
      opened.delete(db)
    },
  }
}

export async function stopTestDatabase(): Promise<void> {
  for (const db of opened) await db.end({ timeout: 5 })
  opened.clear()
  if (!running) return
  const r = await running
  running = undefined
  await r.stop()
}

/** Inserts a bare user row (no identity) so tests can own trips directly. */
export async function insertUser(db: Db, schema: string, id: string = randomUUID()): Promise<string> {
  await db`insert into ${db(schema)}.users (id) values (${id})`
  return id
}
