import { serve, type ServerType } from '@hono/node-server'
import { createApp } from './app.js'
import { ensureLocalKeyFile } from './auth/localKeys.js'
import { runMigrations, type Db } from './db/client.js'
import { buildDeps } from './deps.js'
import type { Config } from './env.js'

/**
 * Prepares and starts the HTTP server: local-only setup (key file, migrations), then listen on
 * `config.port`. Deployed environments never migrate at startup: run `npm run migrate` before deploying.
 */
export async function startServer(
  config: Config,
  db: Db,
  log: (line: string) => void = console.log,
): Promise<{ server: ServerType; port: number }> {
  if (config.appEnv === 'local') {
    if (config.auth.localKeyFile) await ensureLocalKeyFile(config.auth.localKeyFile)
    const applied = await runMigrations(db, config.dbSchema, { authIssuer: config.auth.issuer })
    for (const file of applied) log(`applied ${file}`)
  }

  // Request logging is local-only; deployed environments use Vercel's own logs.
  const app = createApp(buildDeps(config, db), { requestLog: config.appEnv === 'local' })
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
      log(`imontour-api listening on :${info.port} (${config.appEnv})`)
      resolve({ server, port: info.port })
    })
    server.once('error', reject)
  })
}

/**
 * Returns an idempotent shutdown function: stop accepting connections, drop idle keep-alive ones, close the
 * database, then `exit(0)` (or `exit(1)` if closing failed or took longer than `forceAfterMs`).
 */
export function createShutdown(
  server: Pick<ServerType, 'close'> & { closeAllConnections?: () => void },
  db: Pick<Db, 'end'>,
  exit: (code: number) => void,
  forceAfterMs = 10_000,
): () => void {
  let stopping = false
  return () => {
    if (stopping) return
    stopping = true
    // Last resort if draining hangs (a stuck request or db.end); unref'd so it never keeps the process alive.
    setTimeout(() => exit(1), forceAfterMs).unref()
    server.close(() => {
      db.end({ timeout: 5 }).then(
        () => exit(0),
        () => exit(1),
      )
    })
    // Drop idle keep-alive connections so close() can finish (HTTP/1 servers only).
    server.closeAllConnections?.()
  }
}
