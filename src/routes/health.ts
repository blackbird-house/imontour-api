import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { errorSchema } from '../schemas/trip.js'

/** Resolves when the database answers; rejects when it does not. */
export type PingDatabase = () => Promise<void>

/** Longer than this and an uptime monitor would rather be told the API is unhealthy than wait. */
export const HEALTH_TIMEOUT_MS = 3000

const healthSchema = z
  .object({ status: z.enum(['ok', 'unavailable']) })
  .openapi('Health', { description: 'Deliberately minimal: no versions, hosts or error details.' })

const noStore = z.object({
  'Cache-Control': z.string().openapi({ description: 'Always `no-store`.', example: 'no-store' }),
})

const getHealth = createRoute({
  operationId: 'getHealth',
  method: 'get',
  path: '/health',
  tags: ['Health'],
  security: [],
  summary: 'Health check (public)',
  description:
    'No authentication. Runs a trivial query against the database, so it is meant for uptime monitors ' +
    '(and as a cheap smoke test), not for clients to call on every launch.',
  responses: {
    200: {
      description: 'The API and its database are reachable.',
      headers: noStore,
      content: { 'application/json': { schema: healthSchema } },
    },
    503: {
      description: 'The database did not answer in time or failed.',
      headers: noStore,
      content: { 'application/json': { schema: healthSchema } },
    },
    500: {
      description: 'Unexpected server error.',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
})

/** Public `GET /health`; the app mounts it under `/v1`. */
export function healthRoute(ping: PingDatabase, timeoutMs = HEALTH_TIMEOUT_MS): OpenAPIHono {
  const app = new OpenAPIHono()
  app.openapi(getHealth, async (c) => {
    const headers = { 'Cache-Control': 'no-store' }
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        ping(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`database ping timed out after ${timeoutMs} ms`)), timeoutMs)
        }),
      ])
      return c.json({ status: 'ok' as const }, 200, headers)
    } catch (err) {
      console.error('health check failed:', err instanceof Error ? err.message : err)
      return c.json({ status: 'unavailable' as const }, 503, headers)
    } finally {
      clearTimeout(timer)
    }
  })
  return app
}
