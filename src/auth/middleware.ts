import type { MiddlewareHandler } from 'hono'
import { UnauthorizedError } from '../errors.js'
import type { VerifyToken } from './verifier.js'

export type AuthVariables = { userId: string }

export function bearerAuth(verify: VerifyToken): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const parts = (c.req.header('Authorization') ?? '').trim().split(/\s+/)
    if (parts.length !== 2 || parts[0]!.toLowerCase() !== 'bearer' || parts[1] === '') {
      throw new UnauthorizedError()
    }
    const { userId } = await verify(parts[1]!)
    c.set('userId', userId)
    await next()
  }
}
