import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildOpenApiDocument, formatOpenApiDocument } from '../src/openapi.js'

const file = fileURLToPath(new URL('../openapi.json', import.meta.url))
const generated = formatOpenApiDocument(buildOpenApiDocument())

if (process.argv.includes('--check')) {
  const committed = existsSync(file) ? readFileSync(file, 'utf8') : null
  if (committed !== generated) {
    console.error('openapi.json is out of date with the route declarations. Run `npm run openapi` and commit the result.')
    process.exit(1)
  }
  console.log('openapi.json is up to date')
} else {
  writeFileSync(file, generated)
  console.log('wrote openapi.json')
}
