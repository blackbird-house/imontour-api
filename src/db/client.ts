import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

export type Db = ReturnType<typeof postgres>

const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/i
export type MigrationVars = {
  /** Issuer recorded for users that already own data (002_users.sql backfill). Required by that migration. */
  authIssuer?: string
}

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url))

/**
 * Creates a postgres.js client. `prepare: false` keeps it compatible with
 * transaction poolers (Supabase pooler / pgbouncer). Never rely on search_path:
 * always qualify tables with the `db(schema)` identifier.
 */
export function createDb(databaseUrl: string, opts: { max?: number } = {}): Db {
  return postgres(databaseUrl, {
    prepare: false,
    max: opts.max ?? 5,
    idle_timeout: 20,
    // Seconds. Fail a request quickly instead of hanging when the database is unreachable.
    connect_timeout: 10,
    onnotice: () => {},
  })
}

function assertSchemaName(schema: string): void {
  if (!SCHEMA_NAME.test(schema)) throw new Error(`invalid schema name: ${JSON.stringify(schema)}`)
}

/**
 * Applies db/migrations/*.sql in filename order, each in its own transaction,
 * skipping files already recorded in `<schema>.schema_migrations`.
 * The `{{schema}}` placeholder is replaced with the quoted schema identifier, and
 * `{{auth_issuer}}` with the issuer as a SQL string literal (an error if a
 * migration needs it and `vars.authIssuer` is not given).
 * Returns the filenames applied by this call.
 */
export async function runMigrations(db: Db, schema: string, vars: MigrationVars = {}): Promise<string[]> {
  assertSchemaName(schema)
  const quoted = `"${schema}"`

  // Under the same lock as the migrations, so two first-time runners cannot race on `create ... if not exists`.
  await db.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${schema}))`
    await tx.unsafe(`create schema if not exists ${quoted}`)
    await tx.unsafe(
      `create table if not exists ${quoted}.schema_migrations (
         filename   text primary key,
         applied_at timestamptz not null default now()
       )`,
    )
  })

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()
  const applied: string[] = []
  for (const file of files) {
    const raw = await readFile(MIGRATIONS_DIR + file, 'utf8')
    if (raw.includes('{{auth_issuer}}') && !vars.authIssuer) {
      throw new Error(`migration ${file} needs the auth issuer (pass vars.authIssuer / set AUTH_ISSUER)`)
    }
    const body = raw
      .replaceAll('{{schema}}', quoted)
      .replaceAll('{{auth_issuer}}', `'${(vars.authIssuer ?? '').replaceAll("'", "''")}'`)
    const didApply = await db.begin(async (tx) => {
      // Serialise concurrent runners for this schema.
      await tx`select pg_advisory_xact_lock(hashtext(${schema}))`
      const done = await tx`select 1 from ${tx(schema)}.schema_migrations where filename = ${file}`
      if (done.length > 0) return false
      await tx.unsafe(body)
      await tx`insert into ${tx(schema)}.schema_migrations (filename) values (${file})`
      return true
    })
    if (didApply) applied.push(file)
  }
  return applied
}
