import { OpenAPIHono } from '@hono/zod-openapi'
import { bodyLimit } from 'hono/body-limit'
import { bearerAuth, type AuthVariables } from './auth/middleware.js'
import type { IdentityProviderAdmin } from './auth/providerAdmin.js'
import type { ResolveUser } from './auth/resolver.js'
import type { VerifyToken } from './auth/verifier.js'
import { errorHandler, notFound, payloadTooLarge } from './errors.js'
import { validationHook } from './http/validation.js'
import type { TripRepo } from './repo/trips.js'
import type { UserRepo } from './repo/users.js'
import { configRoute, type RemoteConfigSource } from './routes/config.js'
import { registerMeRoutes } from './routes/me.js'
import { registerTripRoutes } from './routes/trips.js'

export type Deps = {
  repo: TripRepo
  users: UserRepo
  verify: VerifyToken
  resolveUser: ResolveUser
  identityAdmin: IdentityProviderAdmin
  remoteConfig: RemoteConfigSource
}

export const MAX_BODY_BYTES = 1024 * 1024

/** Builds the HTTP app from its dependencies. No I/O happens here. */
export function createApp(deps: Deps): OpenAPIHono<{ Variables: AuthVariables }> {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>({ defaultHook: validationHook })

  app.onError(errorHandler)
  app.notFound(() => {
    throw notFound()
  })

  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  })

  // Authenticate before reading any body, so anonymous callers always get 401.
  const auth = bearerAuth(deps.verify, deps.resolveUser)
  app.use('/v1/trips/*', auth)
  app.use('/v1/me', auth)
  // Only routes that accept a body are limited, so GET/DELETE never answer 413.
  // '/v1/trips/*' also matches '/v1/trips' itself (bodylimit.test.ts proves POST gets 413).
  const limitBody = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: () => {
      throw payloadTooLarge()
    },
  })
  app.on(['POST', 'PUT', 'PATCH'], '/v1/trips/*', limitBody)
  app.on(['POST', 'PUT', 'PATCH'], '/v1/me', limitBody)

  // Public: bearerAuth above only covers /v1/trips/* and /v1/me.
  app.route('/v1', configRoute(deps.remoteConfig))
  registerTripRoutes(app, deps.repo)
  registerMeRoutes(app, deps.users, deps.identityAdmin)

  return app
}
