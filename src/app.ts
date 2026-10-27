import { OpenAPIHono } from '@hono/zod-openapi'
import { bodyLimit } from 'hono/body-limit'
import { logger } from 'hono/logger'
import { requestId } from 'hono/request-id'
import { bearerAuth, type AuthVariables } from './auth/middleware.js'
import type { AppleTokenRevoker } from './auth/appleRevoke.js'
import type { IdentityProviderAdmin } from './auth/providerAdmin.js'
import type { ResolveUser } from './auth/resolver.js'
import type { VerifyToken } from './auth/verifier.js'
import { errorHandler, notFound, payloadTooLarge } from './errors.js'
import { validationHook } from './http/validation.js'
import type { ExportRepo } from './repo/export.js'
import type { TripRepo } from './repo/trips.js'
import type { UserRepo } from './repo/users.js'
import { configRoute, type RemoteConfigSource } from './routes/config.js'
import { adminRoutes } from './routes/admin.js'
import { healthRoute, type PingDatabase } from './routes/health.js'
import { registerMeRoutes } from './routes/me.js'
import { registerTripRoutes } from './routes/trips.js'

export type Deps = {
  repo: TripRepo
  users: UserRepo
  verify: VerifyToken
  resolveUser: ResolveUser
  identityAdmin: IdentityProviderAdmin
  appleRevoker: AppleTokenRevoker
  remoteConfig: RemoteConfigSource
  pingDatabase: PingDatabase
  exporter: ExportRepo
  /** Mounts the operator-only /v1/admin routes when set. */
  adminApiKey?: string
}

export const MAX_BODY_BYTES = 1024 * 1024

/** Builds the HTTP app from its dependencies. No I/O happens here. `requestLog` logs each request to the console (local only). */
export function createApp(deps: Deps, opts: { requestLog?: boolean } = {}): OpenAPIHono<{ Variables: AuthVariables }> {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>({ defaultHook: validationHook })
  // First, so every response (errors included) carries X-Request-Id and the error log can quote it.
  app.use(requestId())
  // Registered on the app itself (not by wrapping it) so the JSON notFound/onError handlers still apply.
  if (opts.requestLog) app.use(logger())

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
  app.route('/v1', healthRoute(deps.pingDatabase))
  if (deps.adminApiKey) app.route('/v1/admin', adminRoutes(deps.exporter, deps.adminApiKey))
  registerTripRoutes(app, deps.repo)
  registerMeRoutes(app, deps.users, deps.identityAdmin, deps.appleRevoker)

  return app
}
