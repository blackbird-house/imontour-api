import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import type { AuthVariables } from '../auth/middleware.js'
import { badRequest, conflict, notFound, preconditionFailed, preconditionRequired } from '../errors.js'
import { decodeCursor, encodeCursor } from '../http/cursor.js'
import { formatEtag, parseIfMatch } from '../http/etag.js'
import { DuplicateTripError, type TripRepo, type WriteResult } from '../repo/trips.js'
import {
  createTripBodySchema,
  errorSchema,
  renameSchema,
  tripInputSchema,
  tripListSchema,
  tripSchema,
  type Trip,
} from '../schemas/trip.js'

export type TripsApp = OpenAPIHono<{ Variables: AuthVariables }>

export const DEFAULT_LIMIT = 20
export const MAX_LIMIT = 100

// ---------------------------------------------------------------------------
// Request / response schemas

const idParams = z.object({
  id: z.uuid().openapi({
    param: { name: 'id', in: 'path' },
    description: 'Trip id. A value that is not a UUID is treated as a missing trip (404).',
    example: '9b2f4a7c-5d1e-4f8a-8c3b-0a1b2c3d4e5f',
  }),
})

const listQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT)
    .openapi({
      param: { name: 'limit', in: 'query' },
      description: `Page size, 1-${MAX_LIMIT}.`,
      example: DEFAULT_LIMIT,
    }),
  cursor: z
    .string()
    .optional()
    .openapi({ param: { name: 'cursor', in: 'query' }, description: 'Opaque `nextCursor` from the previous page.' }),
})

const ifMatchRequired = z.object({
  'If-Match': z
    .string()
    .optional()
    // Optional to the validator, so a missing header reaches the handler and
    // answers 428 instead of a 400; documented as required, which it is.
    .openapi({
      param: { required: true },
      description: 'Revision being replaced: `"3"` or `3`. Required; missing is 428.',
      example: '"3"',
    }),
})

const preconditionFailedSchema = errorSchema
  .extend({ currentRevision: z.number().int().min(1) })
  .openapi('PreconditionFailedError')

const etagHeader = z.object({
  ETag: z.string().openapi({ description: 'Quoted trip revision.', example: '"1"' }),
})

const createdHeaders = etagHeader.extend({
  Location: z
    .string()
    .openapi({ description: 'URL of the created trip.', example: '/v1/trips/9b2f4a7c-5d1e-4f8a-8c3b-0a1b2c3d4e5f' }),
})

const jsonBody = <T extends z.ZodType>(schema: T, description: string) => ({
  required: true,
  description,
  content: { 'application/json': { schema } },
})

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: errorSchema } },
})

const tripResponse = (description: string) => ({
  description,
  headers: etagHeader,
  content: { 'application/json': { schema: tripSchema } },
})

const errors = {
  badRequest: errorResponse('Malformed JSON, header, query parameter or cursor.'),
  unauthorized: errorResponse('Missing or invalid bearer token.'),
  notFound: errorResponse('No such trip for this user (also for a non-UUID id).'),
  conflict: errorResponse('A trip with this id already exists for this user.'),
  preconditionFailed: {
    description: 'If-Match does not match the current revision.',
    content: { 'application/json': { schema: preconditionFailedSchema } },
  },
  payloadTooLarge: errorResponse('Request body larger than 1 MB.'),
  unsupportedMediaType: errorResponse('Request body is not application/json.'),
  unprocessable: errorResponse('Body is valid JSON but violates the schema.'),
  preconditionRequired: errorResponse('If-Match header is required.'),
  internal: errorResponse('Unexpected server error.'),
  serviceUnavailable: errorResponse(
    'The token could not be checked because the auth key service is unreachable. Retry later; do not sign the user out.',
  ),
}

const common = { tags: ['Trips'], security: [{ bearerAuth: [] }] }

// ---------------------------------------------------------------------------
// Routes

const listTrips = createRoute({
  ...common,
  operationId: 'listTrips',
  method: 'get',
  path: '/v1/trips',
  summary: 'List trip summaries, newest first',
  request: { query: listQuery },
  responses: {
    200: { description: 'A page of trip summaries.', content: { 'application/json': { schema: tripListSchema } } },
    400: errors.badRequest,
    401: errors.unauthorized,
    500: errors.internal,
    503: errors.serviceUnavailable,
  },
})

const createTrip = createRoute({
  ...common,
  operationId: 'createTrip',
  method: 'post',
  path: '/v1/trips',
  summary: 'Create a trip (empty or full)',
  request: { body: jsonBody(createTripBodySchema, 'The trip; `{}` or no body creates an empty unnamed trip.') },
  responses: {
    201: {
      description: 'Created.',
      headers: createdHeaders,
      content: { 'application/json': { schema: tripSchema } },
    },
    400: errors.badRequest,
    401: errors.unauthorized,
    409: errors.conflict,
    413: errors.payloadTooLarge,
    415: errors.unsupportedMediaType,
    422: errors.unprocessable,
    500: errors.internal,
    503: errors.serviceUnavailable,
  },
})

const getTrip = createRoute({
  ...common,
  operationId: 'getTrip',
  method: 'get',
  path: '/v1/trips/{id}',
  summary: 'Get a trip',
  request: { params: idParams },
  responses: {
    200: tripResponse('The trip.'),
    401: errors.unauthorized,
    404: errors.notFound,
    500: errors.internal,
    503: errors.serviceUnavailable,
  },
})

const replaceTrip = createRoute({
  ...common,
  operationId: 'replaceTrip',
  method: 'put',
  path: '/v1/trips/{id}',
  summary: 'Replace a trip (revision-checked)',
  description:
    'Replaces the whole trip document. The `If-Match` header is required; a missing one yields 428. ' +
    'A stale revision yields 412 with `currentRevision`.',
  request: {
    params: idParams,
    headers: ifMatchRequired,
    body: jsonBody(tripInputSchema, 'The whole trip. `id`, `revision` and `updatedAt` in the body are ignored.'),
  },
  responses: {
    200: tripResponse('Replaced; the new revision.'),
    400: errors.badRequest,
    401: errors.unauthorized,
    404: errors.notFound,
    412: errors.preconditionFailed,
    413: errors.payloadTooLarge,
    415: errors.unsupportedMediaType,
    422: errors.unprocessable,
    428: errors.preconditionRequired,
    500: errors.internal,
    503: errors.serviceUnavailable,
  },
})

const renameTrip = createRoute({
  ...common,
  operationId: 'renameTrip',
  method: 'patch',
  path: '/v1/trips/{id}',
  summary: 'Rename a trip',
  description:
    'Changes only the name, unconditionally (last write wins), and bumps the revision. ' +
    'Use `PUT` with `If-Match` for a change that must not overwrite a newer revision.',
  request: {
    params: idParams,
    body: jsonBody(renameSchema, 'The new name (string or null).'),
  },
  responses: {
    200: tripResponse('Renamed; the full trip with its new revision.'),
    400: errors.badRequest,
    401: errors.unauthorized,
    404: errors.notFound,
    413: errors.payloadTooLarge,
    415: errors.unsupportedMediaType,
    422: errors.unprocessable,
    500: errors.internal,
    503: errors.serviceUnavailable,
  },
})

const deleteTrip = createRoute({
  ...common,
  operationId: 'deleteTrip',
  method: 'delete',
  path: '/v1/trips/{id}',
  summary: 'Delete a trip',
  request: { params: idParams },
  responses: {
    204: { description: 'Deleted.' },
    401: errors.unauthorized,
    404: errors.notFound,
    500: errors.internal,
    503: errors.serviceUnavailable,
  },
})

// ---------------------------------------------------------------------------
// Helpers

function expectedRevision(header: string | undefined, required: boolean): number | undefined {
  const parsed = parseIfMatch(header)
  if (parsed === 'invalid') throw badRequest('Malformed If-Match header')
  if (parsed === 'missing') {
    if (required) throw preconditionRequired()
    return undefined
  }
  return parsed
}

function unwrap(result: WriteResult): Trip {
  if (result.kind === 'missing') throw notFound()
  if (result.kind === 'stale') throw preconditionFailed({ currentRevision: result.currentRevision })
  return result.trip
}

// ---------------------------------------------------------------------------
// Registration

export function registerTripRoutes(app: TripsApp, repo: TripRepo): void {
  app.openapi(listTrips, async (c) => {
    const { limit, cursor: rawCursor } = c.req.valid('query')
    const cursor = rawCursor === undefined ? undefined : decodeCursor(rawCursor)
    if (cursor === null) throw badRequest('cursor: invalid cursor')
    const page = await repo.list(c.get('userId'), { limit, cursor })
    return c.json({ items: page.items, nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null }, 200)
  })

  app.openapi(createTrip, async (c) => {
    // A request with no body and no Content-Type validates as `{}`.
    const body = c.req.valid('json')
    let trip: Trip
    try {
      trip = await repo.create(c.get('userId'), { ...body, destinations: body.destinations ?? [] })
    } catch (err) {
      if (err instanceof DuplicateTripError) throw conflict('A trip with this id already exists')
      throw err
    }
    return c.json(trip, 201, { ETag: formatEtag(trip.revision), Location: `/v1/trips/${trip.id}` })
  })

  app.openapi(getTrip, async (c) => {
    const trip = await repo.get(c.get('userId'), c.req.valid('param').id)
    if (!trip) throw notFound()
    return c.json(trip, 200, { ETag: formatEtag(trip.revision) })
  })

  app.openapi(replaceTrip, async (c) => {
    const { id } = c.req.valid('param')
    const input = c.req.valid('json')
    const revision = expectedRevision(c.req.header('If-Match'), true)!
    const trip = unwrap(await repo.replace(c.get('userId'), id, revision, input))
    return c.json(trip, 200, { ETag: formatEtag(trip.revision) })
  })

  app.openapi(renameTrip, async (c) => {
    const { id } = c.req.valid('param')
    const { name } = c.req.valid('json')
    // Not part of the documented contract (see renameTrip), but still honoured if a client sends it.
    const revision = expectedRevision(c.req.header('If-Match'), false)
    const trip = unwrap(await repo.rename(c.get('userId'), id, name, revision))
    return c.json(trip, 200, { ETag: formatEtag(trip.revision) })
  })

  app.openapi(deleteTrip, async (c) => {
    if (!(await repo.remove(c.get('userId'), c.req.valid('param').id))) throw notFound()
    return c.body(null, 204)
  })
}
