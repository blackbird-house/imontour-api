import { loadConfig } from '../src/env.js'
import { createDb, runMigrations } from '../src/db/client.js'

const config = loadConfig(process.env)
const db = createDb(config.databaseUrl, { max: 1 })
try {
  const applied = await runMigrations(db, config.dbSchema, { authIssuer: config.auth.issuer })
  if (applied.length === 0) console.log('No pending migrations.')
  else for (const f of applied) console.log(`applied ${f}`)
} finally {
  await db.end({ timeout: 5 })
}
