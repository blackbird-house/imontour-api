/** Strong ETag for a trip revision, e.g. `"3"`. */
export function formatEtag(revision: number): string {
  return `"${revision}"`
}

/**
 * Parses an If-Match header into a revision number. Accepts `"3"`, `3` and `W/"3"`.
 * The weak form is accepted on purpose: CDNs such as Vercel's weaken a strong ETag
 * when they compress the response, so clients receive `W/"3"` and send it back as is.
 * A revision is an exact integer, so weak and strong mean the same thing here.
 * `*`, lists, unbalanced quotes, zero, negatives and non-integers are 'invalid';
 * an absent header is 'missing'.
 */
export function parseIfMatch(header: string | undefined): number | 'missing' | 'invalid' {
  if (header === undefined) return 'missing'
  const v = header.trim()
  const m = /^(?:(?:W\/)?"(\d+)"|(\d+))$/.exec(v)
  const digits = m?.[1] ?? m?.[2]
  if (digits === undefined) return 'invalid'
  const n = Number(digits)
  return Number.isSafeInteger(n) && n >= 1 ? n : 'invalid'
}
