import type { Deps } from './app.js'
import { createVerifier } from './auth/verifier.js'
import { createDb, type Db } from './db/client.js'
import type { Config } from './env.js'
import { createTripRepo } from './repo/trips.js'
import { createFileConfigSource } from './routes/config.js'

/**
 * Wires the app's dependencies from validated config. Creates the Db from
 * `config.databaseUrl` unless one is passed (tests inject their own). postgres.js
 * connects lazily, so nothing touches the network here. Runs no migrations.
 */
export function buildDeps(config: Config, db: Db = createDb(config.databaseUrl)): Deps {
  return {
    repo: createTripRepo(db, config.dbSchema),
    verify: createVerifier(config.auth),
    remoteConfig: createFileConfigSource(config.configFile),
  }
}
