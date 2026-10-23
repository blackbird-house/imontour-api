import type { ValidationTargets } from 'hono'
import type { ZodError } from 'zod'
import { badRequest, notFound } from '../errors.js'

export type ValidationResult = { target: keyof ValidationTargets } & (
  { success: true } | { success: false; error: ZodError }
)

/**
 * Validation hook (OpenAPIHono `defaultHook`) mapping request-validation
 * failures onto the API's error contract:
 * - path params (only `{id}` today): 404, so a malformed id looks like any missing trip;
 * - query string and headers: 400;
 * - a JSON body that parsed but breaks the schema: 422, naming the first failing path
 *   (the ZodError is rethrown and formatted by `errorHandler`).
 * Malformed JSON never reaches this hook: Hono throws a 400 HTTPException first.
 */
export function validationHook(result: ValidationResult): void {
  if (result.success) return
  if (result.target === 'param') throw notFound()
  if (result.target === 'json' || result.target === 'form') throw result.error
  const issue = result.error.issues[0]
  const path = issue && issue.path.length > 0 ? issue.path.join('.') : result.target
  throw badRequest(`${path}: ${issue?.message ?? 'invalid'}`)
}
