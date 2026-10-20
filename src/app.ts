import { OpenAPIHono } from '@hono/zod-openapi'
import { bodyLimit } from 'hono/body-limit'
import { bearerAuth, type AuthVariables } from './auth/middleware.js'
import type { VerifyToken } from './auth/verifier.js'
import { errorHandler, notFound, payloadTooLarge } from './errors.js'
import { validationHook } from './http/validation.js'
import type { TripRepo } from './repo/trips.js'
import type { RemoteConfigSource } from './routes/config.js'
import { registerTripRoutes } from './routes/trips.js'

export type Deps = { repo: TripRepo; verify: VerifyToken; remoteConfig: RemoteConfigSource }

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
  app.use('/v1/trips/*', bearerAuth(deps.verify))
  app.use(
    '/v1/*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: () => {
        throw payloadTooLarge()
      },
    }),
  )

  registerTripRoutes(app, deps.repo)

  return app
}
