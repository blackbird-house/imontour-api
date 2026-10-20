export type Cursor = { updatedAt: string; id: string }

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify({ u: c.updatedAt, i: c.id }), 'utf8').toString('base64url')
}

/** Returns null for anything that is not a well-formed cursor. */
export function decodeCursor(s: string): Cursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const { u, i } = parsed as Record<string, unknown>
    if (typeof u !== 'string' || typeof i !== 'string') return null
    if (!ISO_DATETIME.test(u) || Number.isNaN(Date.parse(u)) || !UUID.test(i)) return null
    return { updatedAt: u, id: i }
  } catch {
    return null
  }
}
