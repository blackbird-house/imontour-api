import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { LEGAL_PAGES, placeholdersIn, renderLegalPage } from '../src/legalPages.js'

const docs = (name: string) => fileURLToPath(new URL(`../docs/legal/${name}`, import.meta.url))
const publicDir = (name: string) => fileURLToPath(new URL(`../public/${name}`, import.meta.url))
const check = process.argv.includes('--check')

const pages = LEGAL_PAGES.map((p) => {
  const markdown = readFileSync(docs(p.source), 'utf8')
  return { ...p, placeholders: placeholdersIn(markdown), html: renderLegalPage(markdown, p.title) }
})
const unfinished = pages.filter((p) => p.placeholders.length > 0)

if (check) {
  // Invariant: a draft is never published, and a finished document is never left unpublished or stale.
  const problems: string[] = []
  for (const p of pages) {
    const exists = existsSync(publicDir(p.out))
    if (p.placeholders.length > 0 && exists)
      problems.push(`public/${p.out} is published but ${p.source} still has placeholders`)
    if (p.placeholders.length === 0 && !exists) problems.push(`${p.source} is finished but public/${p.out} is missing`)
    if (p.placeholders.length === 0 && exists && readFileSync(publicDir(p.out), 'utf8') !== p.html)
      problems.push(`public/${p.out} is out of date`)
  }
  if (problems.length > 0) {
    console.error(`${problems.join('\n')}\nRun \`npm run legal\` and commit the result.`)
    process.exit(1)
  }
  console.log(unfinished.length > 0 ? 'legal pages: drafts, nothing published' : 'legal pages are up to date')
} else {
  if (unfinished.length > 0) {
    // Remove stale output so a draft can never be served by accident.
    for (const p of pages) rmSync(publicDir(p.out), { force: true })
    console.error(
      `Not publishing: placeholders left in ${unfinished.map((p) => `${p.source} (${p.placeholders.length})`).join(', ')}. ` +
        'Fill every ⟦…⟧ in docs/legal first.',
    )
    process.exit(1)
  }
  mkdirSync(fileURLToPath(new URL('../public/', import.meta.url)), { recursive: true })
  for (const p of pages) writeFileSync(publicDir(p.out), p.html)
  console.log(`wrote ${pages.map((p) => `public/${p.out}`).join(', ')}`)
}
