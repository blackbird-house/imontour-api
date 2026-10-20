// Opens the local Adminer database browser pre-filled for one environment. Local use only.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

const ENVS = ['local', 'dev', 'staging', 'prod'] as const
type EnvName = (typeof ENVS)[number]
const ADMINER = 'http://127.0.0.1:8080/'
const LOCAL_URL = 'postgres://postgres:postgres@127.0.0.1:54329/imontour'

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const name = process.argv[2] as EnvName | undefined
if (!name || !ENVS.includes(name)) fail(`usage: npm run db:browse -- <${ENVS.join('|')}>`)

let url: string
let schema = 'public'
if (name === 'local') {
  url = LOCAL_URL
} else {
  const file = `.env.${name}`
  let vars: Record<string, string | undefined>
  try {
    vars = parseEnv(readFileSync(file, 'utf8'))
  } catch {
    fail(`${file} not found. Create it from env/${name}.env.example (it is git-ignored).`)
  }
  const browse = vars.BROWSE_DATABASE_URL?.trim()
  // Prod is only ever browsed with a read-only role, never the API's own credentials.
  if (name === 'prod' && !browse) {
    fail('prod requires BROWSE_DATABASE_URL in .env.prod, a connection string for a READ-ONLY database role.')
  }
  const chosen = browse || vars.DATABASE_URL?.trim()
  if (!chosen) fail(`${file} has neither BROWSE_DATABASE_URL nor DATABASE_URL`)
  url = chosen
  schema = vars.DB_SCHEMA?.trim() || 'public'
}

const u = new URL(url)
// The browser runs in a container: loopback on this machine is host.docker.internal there.
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
const host = `${loopback ? 'host.docker.internal' : u.hostname}:${u.port || '5432'}`
if (u.port === '6543') {
  console.warn('note: port 6543 is the transaction pooler; if Adminer misbehaves use the session pooler (5432).')
}

execFileSync('docker', ['compose', '--profile', 'tools', 'up', '-d', '--wait', 'adminer'], { stdio: 'inherit' })

const link = new URL(ADMINER)
link.searchParams.set('pgsql', host)
link.searchParams.set('username', decodeURIComponent(u.username))
link.searchParams.set('db', u.pathname.replace(/^\//, '') || 'postgres')
link.searchParams.set('ns', schema)
console.log(`\n${name.toUpperCase()}${name === 'prod' ? ' (read-only role)' : ''}  schema=${schema}`)
console.log(`Open: ${link.href}`)
console.log('Password: from your connection string (not passed through the URL).')
try {
  execFileSync('open', [link.href])
} catch {
  // Not macOS or no browser: the URL above is enough.
}
