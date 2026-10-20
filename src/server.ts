import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { createApp } from './app.js'
import { ensureLocalKeyFile } from './auth/localKeys.js'
import { createDb, runMigrations } from './db/client.js'
import { buildDeps } from './deps.js'
import { ConfigError, loadConfig } from './env.js'

async function main(): Promise<void> {
  const config = loadConfig(process.env)
  const db = createDb(config.databaseUrl)

  if (config.appEnv === 'local') {
    if (config.auth.localKeyFile) await ensureLocalKeyFile(config.auth.localKeyFile)
    const applied = await runMigrations(db, config.dbSchema, { authIssuer: config.auth.issuer })
    for (const file of applied) console.log(`applied ${file}`)
  }
  // Deployed environments never migrate at startup: run `npm run migrate` before deploying.

  const api = createApp(buildDeps(config, db))
  // Request logging is local-only; deployed environments use Vercel's own logs.
  const app = config.appEnv === 'local' ? new Hono().use(logger()).route('/', api) : api
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`imontour-api listening on :${info.port} (${config.appEnv})`)
  })

  let stopping = false
  const shutdown = (): void => {
    if (stopping) return
    stopping = true
    // Last resort if draining hangs (a stuck request or db.end); unref'd so it never keeps the process alive.
    setTimeout(() => process.exit(1), 10_000).unref()
    server.close(() => {
      db.end({ timeout: 5 }).then(
        () => process.exit(0),
        () => process.exit(1),
      )
    })
    // Drop idle keep-alive connections so close() can finish (HTTP/1 servers only).
    if ('closeAllConnections' in server) server.closeAllConnections()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err: unknown) => {
  console.error(err instanceof ConfigError ? `ConfigError: ${err.message}` : err)
  process.exit(1)
})
