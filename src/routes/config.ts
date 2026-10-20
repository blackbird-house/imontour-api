import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { errorSchema } from '../schemas/trip.js'

/** Supplies the remote config document and its ETag (content hash). */
export type RemoteConfigSource = () => Promise<{ body: unknown; etag: string }>

/**
 * Reads and parses the file on every call, so edits apply without a restart.
 * The ETag is the quoted first 16 hex chars of the sha256 of the raw bytes.
 */
export function createFileConfigSource(path: string): RemoteConfigSource {
  return async () => {
    const raw = await readFile(path)
    const etag = `"${createHash('sha256').update(raw).digest('hex').slice(0, 16)}"`
    return { body: JSON.parse(raw.toString('utf8')) as unknown, etag }
  }
}

/** True when an `If-None-Match` header value matches `etag` (weak forms, lists and `*` included). */
function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false
  return header.split(',').some((part) => {
    const tag = part.trim()
    return tag === '*' || tag.replace(/^W\//, '') === etag
  })
}

/** Loose by design: the server never validates the document, clients fail open. */
const remoteConfigSchema = z
  .looseObject({
    schemaVersion: z.number().optional(),
    minimumSupportedVersion: z.string().optional(),
    recommendedVersion: z.string().optional(),
    flags: z
      .record(z.string(), z.object({ value: z.unknown(), rolloutPercent: z.number().optional() }))
      .optional(),
  })
  .openapi('RemoteConfig', {
    description:
      'Served verbatim from the config file and never validated server-side. Missing or ' +
      'malformed fields mean "no constraint"; clients fail open.',
  })

const cacheHeaders = z.object({
  ETag: z.string().openapi({ description: 'Quoted content hash of the config.', example: '"3f2a9c1d5e7b8a40"' }),
  'Cache-Control': z.string().openapi({ description: 'Always `no-cache`: revalidate with `If-None-Match`.', example: 'no-cache' }),
})

const getConfig = createRoute({
  method: 'get',
  path: '/config',
  tags: ['config'],
  summary: 'Remote config (public)',
  description: 'No authentication. Clients revalidate with `If-None-Match`.',
  request: {
    headers: z.object({
      'If-None-Match': z.string().optional().openapi({ description: 'Previously seen ETag.' }),
    }),
  },
  responses: {
    200: {
      description: 'The remote config document.',
      headers: cacheHeaders,
      content: { 'application/json': { schema: remoteConfigSchema } },
    },
    304: { description: 'Not modified; the ETag is unchanged.', headers: cacheHeaders },
    500: { description: 'Config file missing or unparsable.', content: { 'application/json': { schema: errorSchema } } },
  },
})

/** Public `GET /config`; the app mounts it under `/v1`. */
export function configRoute(source: RemoteConfigSource): OpenAPIHono {
  const app = new OpenAPIHono()
  app.openapi(getConfig, async (c) => {
    const { body, etag } = await source()
    const headers = { ETag: etag, 'Cache-Control': 'no-cache' }
    if (matchesIfNoneMatch(c.req.header('If-None-Match'), etag)) {
      return c.body(null, 304, headers) as never
    }
    return c.json(body as z.infer<typeof remoteConfigSchema>, 200, headers)
  })
  return app
}
