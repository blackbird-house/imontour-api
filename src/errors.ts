import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import postgres from 'postgres'
import { ZodError } from 'zod'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Extra top-level JSON fields, merged next to `error` in the response body. */
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export class UnauthorizedError extends ApiError {
  constructor() {
    super(401, 'unauthorized', 'Invalid or missing token')
    this.name = 'UnauthorizedError'
  }
}

export const badRequest = (message: string) => new ApiError(400, 'bad_request', message)
export const notFound = () => new ApiError(404, 'not_found', 'Not found')
export const conflict = (message: string) => new ApiError(409, 'conflict', message)
export const preconditionFailed = (extra: Record<string, unknown> = {}) =>
  new ApiError(412, 'precondition_failed', 'Precondition failed', extra)
export const preconditionRequired = () => new ApiError(428, 'precondition_required', 'If-Match header is required')
export const payloadTooLarge = () => new ApiError(413, 'payload_too_large', 'Payload too large')
export const unprocessable = (message: string) => new ApiError(422, 'unprocessable', message)

const HTTP_EXCEPTION_CODES: Record<number, string> = {
  400: 'bad_request',
  404: 'not_found',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
}

/**
 * Postgres rejected a value as malformed input: 22021 invalid byte sequence
 * (e.g. NUL in text), 22P05 untranslatable character (e.g. unpaired surrogate
 * in jsonb), 22P02 invalid text representation (e.g. a bad uuid). Schemas
 * should catch these first; this is the backstop that keeps them out of 500.
 */
const INVALID_INPUT_CODES = new Set(['22021', '22P05', '22P02'])

export function errorHandler(err: Error, c: Context): Response {
  if (err instanceof ApiError) {
    // `extra` goes first so it can never replace the standard `error` object.
    return c.json({ ...err.extra, error: { code: err.code, message: err.message } }, err.status as 400)
  }
  if (err instanceof HTTPException) {
    // Raised by Hono itself, e.g. malformed JSON (400) or an unsupported media type (415).
    const code = HTTP_EXCEPTION_CODES[err.status] ?? 'http_error'
    return c.json({ error: { code, message: err.message || 'Request failed' } }, err.status)
  }
  if (err instanceof ZodError) {
    const issue = err.issues[0]
    const path = issue && issue.path.length > 0 ? issue.path.join('.') : 'body'
    return c.json({ error: { code: 'unprocessable', message: `${path}: ${issue?.message ?? 'invalid'}` } }, 422)
  }
  if (err instanceof postgres.PostgresError && INVALID_INPUT_CODES.has(err.code)) {
    return c.json(
      { error: { code: 'unprocessable', message: 'body: contains a value the database cannot store' } },
      422,
    )
  }
  console.error(`request ${c.get('requestId') ?? '-'}:`, err)
  return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500)
}
