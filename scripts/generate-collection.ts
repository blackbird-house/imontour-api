import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildCollectionFiles } from '../src/collection.js'
import { buildOpenApiDocument } from '../src/openapi.js'

const dir = fileURLToPath(new URL('../postman/', import.meta.url))
const files = buildCollectionFiles(buildOpenApiDocument() as Parameters<typeof buildCollectionFiles>[0])

if (process.argv.includes('--check')) {
  const stale = Object.entries(files)
    .filter(([name, content]) => !existsSync(dir + name) || readFileSync(dir + name, 'utf8') !== content)
    .map(([name]) => name)
  if (stale.length > 0) {
    console.error(`postman/ is out of date (${stale.join(', ')}). Run \`npm run collection\` and commit the result.`)
    process.exit(1)
  }
  console.log('postman/ is up to date')
} else {
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(dir + name, content)
  console.log(`wrote ${Object.keys(files).length} files to postman/`)
}
