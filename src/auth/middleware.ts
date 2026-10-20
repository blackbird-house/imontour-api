import type { MiddlewareHandler } from 'hono'
import { UnauthorizedError } from '../errors.js'
import type { ResolveUser } from './resolver.js'
import type { VerifyToken } from './verifier.js'

/** `userId` is our own users.id, never a provider's subject. */
export type AuthVariables = { userId: string }

export function bearerAuth(
  verify: VerifyToken,
  resolveUser: ResolveUser,
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const parts = (c.req.header('Authorization') ?? '').trim().split(/\s+/)
    if (parts.length !== 2 || parts[0]!.toLowerCase() !== 'bearer' || parts[1] === '') {
      throw new UnauthorizedError()
    }
    c.set('userId', await resolveUser(await verify(parts[1]!)))
    await next()
  }
}
