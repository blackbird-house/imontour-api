import type { Deps } from './app.js'
import { createAppleRevoker, createNoopAppleRevoker } from './auth/appleRevoke.js'
import { createNoopIdentityAdmin } from './auth/providerAdmin.js'
import { createUserResolver } from './auth/resolver.js'
import { createSupabaseIdentityAdmin } from './auth/supabaseAdmin.js'
import { createVerifier } from './auth/verifier.js'
import { createDb, type Db } from './db/client.js'
import type { Config } from './env.js'
import { createExportRepo } from './repo/export.js'
import { createTripRepo } from './repo/trips.js'
import { createUserRepo } from './repo/users.js'
import { createFileConfigSource } from './routes/config.js'

/**
 * Wires the app's dependencies from validated config. Creates the Db from
 * `config.databaseUrl` unless one is passed (tests inject their own). postgres.js
 * connects lazily, so nothing touches the network here. Runs no migrations.
 */
export function buildDeps(config: Config, db: Db = createDb(config.databaseUrl)): Deps {
  return {
    repo: createTripRepo(db, config.dbSchema),
    users: createUserRepo(db, config.dbSchema),
    verify: createVerifier(config.auth),
    resolveUser: createUserResolver(db, config.dbSchema),
    identityAdmin: config.identityAdmin
      ? createSupabaseIdentityAdmin({ ...config.identityAdmin, issuer: config.auth.issuer })
      : createNoopIdentityAdmin(),
    appleRevoker: config.appleRevoke ? createAppleRevoker(config.appleRevoke) : createNoopAppleRevoker(),
    remoteConfig: createFileConfigSource(config.configFile),
    exporter: createExportRepo(db, config.dbSchema),
    ...(config.adminApiKey ? { adminApiKey: config.adminApiKey } : {}),
    pingDatabase: async () => {
      await db`select 1`
    },
  }
}
