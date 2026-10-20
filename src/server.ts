import { serve } from '@hono/node-server'
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
    const applied = await runMigrations(db, config.dbSchema)
    for (const file of applied) console.log(`applied ${file}`)
  }
  // Deployed environments run `npm run migrate` during deploy, never at startup.

  const app = createApp(buildDeps(config, db))
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`imontour-api listening on :${info.port} (${config.appEnv})`)
  })

  let stopping = false
  const shutdown = (): void => {
    if (stopping) return
    stopping = true
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
