import { createHash, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { ApiError, notFound, payloadTooLarge, UnauthorizedError } from '../errors.js'
import type { ExportRepo } from '../repo/export.js'

/** Fixed-length digests, so the comparison neither throws on a length mismatch nor leaks the length. */
function sameSecret(given: string, expected: string): boolean {
  const digest = (v: string) => createHash('sha256').update(v).digest()
  return timingSafeEqual(digest(given), digest(expected))
}

const exportRequest = z.object({ email: z.string().trim().min(3).max(320) })

/**
 * Operator-only routes, mounted under `/v1/admin` only when ADMIN_API_KEY is set (otherwise the path is a plain 404).
 * Deliberately not part of OpenAPI or the client collection: the iOS app never calls them.
 */
export function adminRoutes(exporter: ExportRepo, apiKey: string): Hono {
  const app = new Hono()

  app.use('*', async (c, next) => {
    const header = c.req.header('Authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
    if (token === '' || !sameSecret(token, apiKey)) {
      console.warn(`admin auth rejected (request ${c.get('requestId') ?? '-'})`)
      throw new UnauthorizedError()
    }
    await next()
  })

  // The email is in the body, not the URL, so it never lands in request logs.
  app.post(
    '/export',
    bodyLimit({
      maxSize: 4 * 1024,
      onError: () => {
        throw payloadTooLarge()
      },
    }),
    async (c) => {
      const parsed = exportRequest.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) throw new ApiError(422, 'unprocessable', 'body: expected {"email": "..."}')
      const found = await exporter.findByEmail(parsed.data.email)
      if (found.length === 0) throw notFound()
      // Audit trail without the address: which accounts were exported, and when.
      console.info(
        `admin export: users ${found.map((f) => f.user.id).join(',')} (request ${c.get('requestId') ?? '-'})`,
      )
      const exportedAt = new Date().toISOString()
      return c.json({ exportedAt, users: found }, 200, {
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="imontour-export-${exportedAt.slice(0, 10)}.json"`,
      })
    },
  )

  return app
}
