export type Cursor = { updatedAt: string; id: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify({ u: c.updatedAt, i: c.id }), 'utf8').toString('base64url')
}

/**
 * True only for the exact `Date#toISOString()` form (what encodeCursor emits).
 * Round-tripping rejects calendar-invalid values such as 2026-02-31, which
 * `Date.parse` would silently roll over into March.
 */
function isCanonicalInstant(u: string): boolean {
  const d = new Date(u)
  return !Number.isNaN(d.getTime()) && d.toISOString() === u
}

/** Returns null for anything that is not a well-formed cursor. */
export function decodeCursor(s: string): Cursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const { u, i } = parsed as Record<string, unknown>
    if (typeof u !== 'string' || typeof i !== 'string') return null
    if (!isCanonicalInstant(u) || !UUID.test(i)) return null
    return { updatedAt: u, id: i }
  } catch {
    return null
  }
}
