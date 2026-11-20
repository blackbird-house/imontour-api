import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildBrunoFiles } from '../src/bruno.js'
import { buildOpenApiDocument } from '../src/openapi.js'

type Doc = Parameters<typeof buildBrunoFiles>[0]
const doc = buildOpenApiDocument() as Doc

// The client collection is generated from the OpenAPI document; its folder is wholly owned by the generator.
const targets = [
  { name: 'bruno/', dir: fileURLToPath(new URL('../bruno/', import.meta.url)), files: buildBrunoFiles(doc) },
]

/** Generated files on disk (.bru / .json), relative to dir. Dotfiles (Bruno's local .env) are not ours. */
function existing(dir: string, rel = ''): string[] {
  if (!existsSync(dir + rel)) return []
  return readdirSync(dir + rel, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith('.')) return []
    const path = rel + e.name
    if (e.isDirectory()) return existing(dir, `${path}/`)
    return /\.(bru|json)$/.test(e.name) ? [path] : []
  })
}

let failed = false
for (const { name, dir, files } of targets) {
  const stale = Object.entries(files)
    .filter(([file, content]) => !existsSync(dir + file) || readFileSync(dir + file, 'utf8') !== content)
    .map(([file]) => file)
  const extra = existing(dir).filter((file) => !(file in files))

  if (process.argv.includes('--check')) {
    if (stale.length + extra.length > 0) {
      console.error(
        `${name} is out of date (${[...stale, ...extra].join(', ')}). Run \`npm run collection\` and commit the result.`,
      )
      failed = true
    } else console.log(`${name} is up to date`)
  } else {
    for (const file of extra) rmSync(dir + file)
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(dir + file), { recursive: true })
      writeFileSync(dir + file, content)
    }
    console.log(`wrote ${Object.keys(files).length} files to ${name}`)
  }
}
if (failed) process.exit(1)
