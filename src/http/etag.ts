/** Strong ETag for a trip revision, e.g. `"3"`. */
export function formatEtag(revision: number): string {
  return `"${revision}"`
}

/**
 * Parses an If-Match header into a revision number. Accepts `"3"` or `3`.
 * Weak validators, `*`, lists, unbalanced quotes, zero, negatives and
 * non-integers are 'invalid'; an absent header is 'missing'.
 */
export function parseIfMatch(header: string | undefined): number | 'missing' | 'invalid' {
  if (header === undefined) return 'missing'
  const v = header.trim()
  const m = /^(?:"(\d+)"|(\d+))$/.exec(v)
  const digits = m?.[1] ?? m?.[2]
  if (digits === undefined) return 'invalid'
  const n = Number(digits)
  return Number.isSafeInteger(n) && n >= 1 ? n : 'invalid'
}
