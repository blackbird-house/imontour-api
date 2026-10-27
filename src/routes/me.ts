import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import type { AppleTokenRevoker } from '../auth/appleRevoke.js'
import type { AuthVariables } from '../auth/middleware.js'
import type { IdentityProviderAdmin } from '../auth/providerAdmin.js'
import { notFound } from '../errors.js'
import type { UserRepo } from '../repo/users.js'
import { errorSchema } from '../schemas/trip.js'
import { updateUserSchema, userSchema } from '../schemas/user.js'

export type MeApp = OpenAPIHono<{ Variables: AuthVariables }>

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: errorSchema } },
})

const errors = {
  badRequest: errorResponse('Malformed JSON.'),
  unauthorized: errorResponse('Missing or invalid bearer token.'),
  notFound: errorResponse('The user no longer exists.'),
  payloadTooLarge: errorResponse('Request body larger than 1 MB.'),
  unsupportedMediaType: errorResponse('Request body is not application/json.'),
  unprocessable: errorResponse('Body is valid JSON but violates the schema.'),
  internal: errorResponse('Unexpected server error.'),
  serviceUnavailable: errorResponse(
    'The token could not be checked because the auth key service is unreachable. Retry later; do not sign the user out.',
  ),
}

const common = { tags: ['Me'], security: [{ bearerAuth: [] }] }

const getMe = createRoute({
  ...common,
  operationId: 'getMe',
  method: 'get',
  path: '/v1/me',
  summary: 'Get the signed-in user profile',
  description: 'The user is created on the first authenticated request, so this never answers 404 for a fresh sign-in.',
  responses: {
    200: { description: 'The profile.', content: { 'application/json': { schema: userSchema } } },
    401: errors.unauthorized,
    404: errors.notFound,
    500: errors.internal,
    503: errors.serviceUnavailable,
  },
})

const updateMe = createRoute({
  ...common,
  operationId: 'updateMe',
  method: 'patch',
  path: '/v1/me',
  summary: 'Update the profile',
  description: 'Changes `displayName` and/or `locale`. Absent fields are unchanged; `null` clears a field.',
  request: {
    body: {
      required: true,
      description: 'The fields to change; at least one.',
      content: { 'application/json': { schema: updateUserSchema } },
    },
  },
  responses: {
    200: { description: 'The updated profile.', content: { 'application/json': { schema: userSchema } } },
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

const deleteMe = createRoute({
  ...common,
  operationId: 'deleteMe',
  method: 'delete',
  path: '/v1/me',
  summary: 'Delete the account',
  description:
    'Permanently deletes the user and all their trips, then asks the identity provider to delete the sign-in ' +
    'account. Provider cleanup is best effort: a failure is logged and does not fail the request. Not undoable. ' +
    'An app that signed the user in with Apple must send `X-Apple-Authorization-Code`, obtained by asking Apple ' +
    'for a fresh authorization at deletion time (a code is single-use and expires after about 5 minutes); the ' +
    "server uses it to revoke the user's Sign in with Apple token, as Apple requires. Revoking is also best effort.",
  request: {
    headers: z.object({
      'X-Apple-Authorization-Code': z
        .string()
        .max(2048)
        .optional()
        .openapi({ description: 'Fresh Sign in with Apple authorization code. Omit for other sign-in methods.' }),
    }),
  },
  responses: {
    204: { description: 'Deleted.' },
    401: errors.unauthorized,
    500: errors.internal,
    503: errors.serviceUnavailable,
  },
})

export function registerMeRoutes(
  app: MeApp,
  users: UserRepo,
  identityAdmin: IdentityProviderAdmin,
  appleRevoker: AppleTokenRevoker,
): void {
  app.openapi(getMe, async (c) => {
    const user = await users.get(c.get('userId'))
    if (!user) throw notFound()
    return c.json(user, 200)
  })

  app.openapi(updateMe, async (c) => {
    const user = await users.update(c.get('userId'), c.req.valid('json'))
    if (!user) throw notFound()
    return c.json(user, 200)
  })

  app.openapi(deleteMe, async (c) => {
    // Idempotent: a user that is already gone is still a 204.
    const identities = (await users.remove(c.get('userId'))) ?? []
    // The data is gone either way; a provider failure must not turn that into an error the client retries blindly.
    await Promise.all(
      identities.map((identity) =>
        identityAdmin.deleteIdentity(identity).catch((err: unknown) => {
          console.error('identity provider cleanup failed', identity.issuer, err)
        }),
      ),
    )
    // Independent of the above: Apple wants the grant revoked whether or not our own cleanup worked.
    const appleCode = c.req.valid('header')['X-Apple-Authorization-Code']?.trim()
    if (appleCode) {
      await appleRevoker.revoke(appleCode).catch((err: unknown) => {
        console.error(`apple token revoke failed (request ${c.get('requestId') ?? '-'})`, err)
      })
    }
    return c.body(null, 204)
  })
}
