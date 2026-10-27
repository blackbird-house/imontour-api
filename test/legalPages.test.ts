import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { LEGAL_PAGES, placeholdersIn, renderLegalPage } from '../src/legalPages.js'

describe('legal pages', () => {
  it('finds ⟦placeholders⟧ and nothing else', () => {
    expect(placeholdersIn('Operated by ⟦name⟧, contact ⟦email⟧.')).toEqual(['⟦name⟧', '⟦email⟧'])
    expect(placeholdersIn('All filled in. [link](x) ⟦')).toEqual([])
  })

  it('renders a complete, escaped, responsive page with links to both documents', () => {
    const html = renderLegalPage(
      '# Privacy Policy\n\nWe keep <script>x</script> out.\n\n## Your rights\n\n- delete',
      'A & B',
    )
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<html lang="en">')
    expect(html).toContain('<meta name="viewport"')
    expect(html).toContain('<title>A &amp; B · Imontour</title>')
    expect(html).toContain('<h1>Privacy Policy</h1>')
    expect(html).toContain('<h2>Your rights</h2>')
    for (const p of LEGAL_PAGES) expect(html).toContain(`href="/${p.out.replace('.html', '')}"`)
    expect(renderLegalPage('# x', 'x')).toBe(renderLegalPage('# x', 'x'))
  })

  it('keeps the repository consistent: no draft published, no finished document left out (npm run legal:check)', () => {
    expect(() => execFileSync('npx', ['tsx', 'scripts/build-legal.ts', '--check'], { stdio: 'pipe' })).not.toThrow()
  })
})
