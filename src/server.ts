import { createDb } from './db/client.js'
import { ConfigError, loadConfig } from './env.js'
import { createShutdown, startServer } from './lifecycle.js'

async function main(): Promise<void> {
  const config = loadConfig(process.env)
  const db = createDb(config.databaseUrl)
  const { server } = await startServer(config, db)

  const shutdown = createShutdown(server, db, (code) => process.exit(code))
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err: unknown) => {
  console.error(err instanceof ConfigError ? `ConfigError: ${err.message}` : err)
  process.exit(1)
})
