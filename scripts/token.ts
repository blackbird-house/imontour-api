import { ensureLocalKeyFile, signLocalToken } from '../src/auth/localKeys.js'
import { UUID_RE } from '../src/uuid.js'

const DEV_SUB = '00000000-0000-4000-8000-000000000001'

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const env = process.env
if (env.APP_ENV !== 'local') fail('npm run token only works with APP_ENV=local')
const iss = env.AUTH_ISSUER?.trim()
if (!iss) fail('AUTH_ISSUER is required')
const aud = env.AUTH_AUDIENCE?.trim() || 'authenticated'
const keyFile = env.AUTH_LOCAL_KEY_FILE?.trim()
if (!keyFile) fail('AUTH_LOCAL_KEY_FILE is required')
const sub = process.argv[2] ?? DEV_SUB
if (!UUID_RE.test(sub)) fail('sub must be a UUID')

await ensureLocalKeyFile(keyFile)
console.log(await signLocalToken(keyFile, { sub, iss, aud }))
