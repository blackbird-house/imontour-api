import { marked } from 'marked'

/** The public legal pages, rendered from docs/legal/*.md into public/ (Vercel serves public/ as static files). */
export const LEGAL_PAGES = [
  { source: 'privacy-policy.md', out: 'privacy.html', title: 'Privacy Policy' },
  { source: 'terms.md', out: 'terms.html', title: 'Terms of Service' },
] as const

/** Facts only the business can supply are written ⟦like this⟧ in the drafts; a page with any left must not be published. */
const PLACEHOLDER = /⟦[^⟧]*⟧/g

export function placeholdersIn(markdown: string): string[] {
  return markdown.match(PLACEHOLDER) ?? []
}

const escapeHtml = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1d1d1f;--muted:#6e6e73;--link:#0066cc;--rule:#d2d2d7}
@media(prefers-color-scheme:dark){:root{--bg:#000;--fg:#f5f5f7;--muted:#a1a1a6;--link:#2997ff;--rule:#424245}}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:42rem;margin:0 auto;padding:2rem 1rem 4rem}
h1{font-size:2rem;line-height:1.2}h2{font-size:1.25rem;margin-top:2rem}
a{color:var(--link)}nav{color:var(--muted);font-size:.9rem;border-top:1px solid var(--rule);margin-top:3rem;padding-top:1rem}
nav a{margin-right:1rem}
`

/** Renders one markdown document as a complete, self-contained HTML page. Deterministic. */
export function renderLegalPage(markdown: string, title: string): string {
  const body = marked.parse(markdown, { async: false })
  const nav = LEGAL_PAGES.map((p) => `<a href="/${p.out.replace(/\.html$/, '')}">${escapeHtml(p.title)}</a>`).join('')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Imontour</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}<nav>${nav}</nav>
</main>
</body>
</html>
`
}
