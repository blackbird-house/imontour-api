# User module (provider-independent) — plan

## Goal

Add a user module whose identity does not depend on Supabase. Changing the auth provider later must be a config change plus a one-off data script, not a rewrite.

## Today

- The API has no user concept. `trips.user_id` is the Supabase token's `sub`, and `src/auth/verifier.ts` hands it straight to the routes.
- The verifier is already generic (JWT, issuer, JWKS). The coupling is the identity: our user id is Supabase's user id.

## Design

Our own user id, plus a link table.

```
users       (id uuid PK (ours), display_name, email?, locale?, created_at, updated_at)
identities  (issuer text, subject text, user_id -> users.id, created_at, PK (issuer, subject))
trips       (user_id -> users.id ON DELETE CASCADE, ...)  -- otherwise unchanged
```

- A token only proves "issuer X says subject Y". We map `(issuer, subject)` to our own `users.id`.
- Supabase, Apple, Google or Auth0 only appear as rows in `identities`.
- Trips and all future tables reference `users.id`, never a provider id.

### Request flow

```
Bearer token -> IdentityVerifier -> { issuer, subject, email? }
             -> UserResolver (find-or-create via identities) -> users.id
             -> c.set('userId', users.id) -> routes (trips unchanged)
```

- `IdentityVerifier`: today's `createVerifier` returns `{ issuer, subject }` instead of `{ userId }`. Supabase specifics stay in config (`AUTH_ISSUER`, `AUTH_JWKS_URL`).
- `UserResolver`: find-or-create in a single upsert; the first authenticated request provisions the user.
- Supabase auth methods (Apple, email/magic link, Google) need no code changes. Only `iss`, `sub` and optionally `email` are read, never provider-specific claims.

### Swapping providers later

1. Add the new issuer and JWKS to config (needs multi-issuer support: `AUTH_ISSUERS` as a list).
2. One-off script inserts `identities` rows (new issuer, new subject, existing `user_id`). No trip data moves.
3. Remove the old issuer.

Never auto-link accounts by email (unverified email enables account takeover). Linking a second identity to a user is an explicit action, added later.

### Endpoints

- `GET /v1/me`: profile.
- `PATCH /v1/me`: update `displayName`, `locale`.
- `DELETE /v1/me`: hard delete the user; trips cascade. Required by Apple for apps with Sign in with Apple.
- Provider-side cleanup goes behind an `IdentityProviderAdmin.deleteIdentity()` port: Supabase adapter (service-role key), no-op for local.

## Decisions (chosen)

1. Provisioning: automatic on first authenticated request (no explicit sign-up call).
2. Profile fields: minimal (`displayName`, `locale`, optional `email` copied from the token).
3. Deletion: hard delete with cascade. A grace period can be added later.
4. No per-request cache at first; one indexed lookup per request. Add a short in-memory cache only if latency shows it is needed.

## Steps

1. **Migration `db/migrations/002_users.sql`**: create `users` and `identities`. Backfill one user per distinct `trips.user_id` (old id becomes `users.id`, current issuer becomes the identity). Then add the foreign key with cascade.
2. **Auth refactor**: verifier returns an identity; add `UserResolver` and a user repo; middleware sets the internal `userId`. Existing trip tests keep passing (`userId` is still a UUID).
3. **`/v1/me` routes** with Zod schemas and OpenAPI update (`getMe`, `updateMe`, `deleteMe`); regenerate `openapi.json`.
4. **Account deletion**: cascade plus the `IdentityProviderAdmin` port (Supabase adapter, local no-op).
5. **Tests, README, env docs.** Cover: first-login provisioning, concurrent first requests (no duplicate users), same identity resolves to same user, deletion cascade, 503 behavior unchanged.
6. **Local DX**: `npm run token [uuid]` keeps working; the user is created on first request.

## Out of scope

Account linking across providers, soft delete, roles/permissions, caching.
