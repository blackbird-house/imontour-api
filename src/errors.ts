import type { Context } from 'hono'
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
export const preconditionRequired = () =>
  new ApiError(428, 'precondition_required', 'If-Match header is required')
export const payloadTooLarge = () => new ApiError(413, 'payload_too_large', 'Payload too large')
export const unprocessable = (message: string) => new ApiError(422, 'unprocessable', message)

export function errorHandler(err: Error, c: Context): Response {
  if (err instanceof ApiError) {
    return c.json({ error: { code: err.code, message: err.message }, ...err.extra }, err.status as 400)
  }
  if (err instanceof ZodError) {
    const issue = err.issues[0]
    const path = issue && issue.path.length > 0 ? issue.path.join('.') : 'body'
    return c.json({ error: { code: 'unprocessable', message: `${path}: ${issue?.message ?? 'invalid'}` } }, 422)
  }
  console.error(err)
  return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500)
}
