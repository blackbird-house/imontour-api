# imontour-api

REST backend for the Imontour iOS/macOS trip-planning app. It is a **document store**: it saves, versions and returns trip documents per user. All trip rules (colors, timing, validation of itineraries) are applied by the client; the server only checks the document shape.

TypeScript, Hono, Postgres. Runs locally as a Node server and in deployed environments as a Vercel function backed by Supabase.

- Design: [docs/superpowers/specs/2026-10-20-imontour-api-design.md](docs/superpowers/specs/2026-10-20-imontour-api-design.md)
- Plan: [docs/superpowers/plans/2026-10-20-imontour-api.md](docs/superpowers/plans/2026-10-20-imontour-api.md)

## Quick start (local)

Prerequisites: Node 22.9+ (`.nvmrc` pins 22; 22.9 is needed for `--env-file-if-exists`) and Docker (for the local Postgres).

```sh
npm ci
npm run db:up                     # starts Postgres on 127.0.0.1:54329 (waits until healthy)
cp env/local.env.example .env
npm run dev                       # runs migrations automatically (local only), serves :3000
```

`docker-compose.yml` is for **local development only**: the database is bound to loopback and uses a fixed dev password. Never reuse it anywhere else.

If the `imontour_test` database is missing (the volume was created before `docker/init-db.sql` existed), recreate the volume with `docker compose down -v` and `npm run db:up`. This deletes local data. `npm run db:down` stops the database and keeps the data.

In another terminal, get a local token and call the API:

```sh
TOKEN=$(npm run -s token)
BASE=http://localhost:3000

# Public remote config
curl -s $BASE/v1/config

# Create a trip with just a name (no destinations)
curl -s -i -X POST $BASE/v1/trips \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Japan 2027"}'
#   HTTP/1.1 201 Created, ETag: "1", Location: /v1/trips/<id>
#   {"schemaVersion":1,"id":"<id>","name":"Japan 2027","revision":1,"updatedAt":"2026-10-20T09:00:00.000Z","destinations":[]}

# Create a full trip with two destinations
curl -s -X POST $BASE/v1/trips \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "schemaVersion": 1,
    "name": "Japan and Korea",
    "destinations": [
      {
        "id": "7d0a1f3e-2b6c-4a58-9e41-5c8d2f6b7a10",
        "rawInput": "Tokyo",
        "color": "coral",
        "place": {"displayName":"Tokyo","type":"city","latitude":35.68,"longitude":139.69,"countryCode":"JP"},
        "timing": {"mode":"explicitDates","startDay":"2027-04-01","endDay":"2027-04-06","isPlaceholder":false}
      },
      {
        "id": "b3c9e5a2-6d14-4f7b-8a20-1e9f4c3d5b62",
        "rawInput": "Seoul",
        "color": "teal",
        "place": {"displayName":"Seoul","type":"city","latitude":37.57,"longitude":126.98,"countryCode":"KR"},
        "timing": {"mode":"durationOnly","durationDays":4,"isPlaceholder":true}
      }
    ]
  }'

# List summaries (newest first)
curl -s "$BASE/v1/trips?limit=20" -H "Authorization: Bearer $TOKEN"

# Get one trip; note the ETag header (the revision) and the id
ID=<id from a previous response>
curl -s -i $BASE/v1/trips/$ID -H "Authorization: Bearer $TOKEN"
#   ETag: "1"

# Replace the whole trip. If-Match is required (428 without it, 412 if stale)
curl -s -X PUT $BASE/v1/trips/$ID \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H 'If-Match: "1"' \
  -d '{"schemaVersion":1,"name":"Japan v2","destinations":[]}'

# Rename (If-Match optional)
curl -s -X PATCH $BASE/v1/trips/$ID \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Renamed"}'

# Delete (204)
curl -s -i -X DELETE $BASE/v1/trips/$ID -H "Authorization: Bearer $TOKEN"

# Your profile (the user is created by the first authenticated request)
curl -s $BASE/v1/me -H "Authorization: Bearer $TOKEN"
curl -s -X PATCH $BASE/v1/me \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"displayName":"Ana","locale":"en-GB"}'
```

`npm run token [uuid]` signs a token whose subject is the given UUID (default `00000000-0000-4000-8000-000000000001`). It only works with `APP_ENV=local`. The matching user is created by the first request that uses the token; the same subject always resolves to the same user.

## Environments

`APP_ENV` selects the environment: `local`, `dev`, `staging` or `prod`. Template files for each live in [`env/`](env/) (`local.env.example`, `dev.env.example`, `staging.env.example`, `prod.env.example`).

**Real values live in Vercel and Supabase environment settings, never in git.** `.env` and `.env.*` are git-ignored; only the `env/*.example` templates are committed.

### Supabase layout

Only **two Supabase projects** exist: staging and prod.

| Environment | Database | Schema | Hosted on |
|---|---|---|---|
| local | Docker Postgres (`docker-compose.yml`) | `public` | your machine |
| dev | staging Supabase project | `dev` (`DB_SCHEMA=dev`) | Vercel Preview |
| staging | staging Supabase project | `public` | Vercel, `staging` branch |
| prod | prod Supabase project | `public` | Vercel, `master` branch |

Dev shares the staging project's database but is isolated in its own schema. Migrations create the schema if it is missing.

### Variables

| Variable | Required | Environments | Meaning | Default |
|---|---|---|---|---|
| `APP_ENV` | yes | all | `local`, `dev`, `staging` or `prod` | none |
| `PORT` | no | local server only (ignored on Vercel) | HTTP port | `3000` |
| `DATABASE_URL` | yes | all | Postgres connection string. Deployed: the Supabase pooled (transaction) string, port 6543. Secret | none |
| `DB_SCHEMA` | no | all | Schema holding the app tables (`dev` on the dev environment) | `public` |
| `AUTH_ISSUER` | yes | all | Expected token `iss` (Supabase: `https://<ref>.supabase.co/auth/v1`) | none |
| `AUTH_AUDIENCE` | no | all | Expected token `aud` | `authenticated` |
| `AUTH_JWKS_URL` | exactly one of this and `AUTH_JWT_SECRET` | dev, staging, prod | Public signing keys URL used to verify tokens | none |
| `AUTH_JWT_SECRET` | exactly one of this and `AUTH_JWKS_URL` | dev, staging, prod | Legacy HS256 shared secret. Secret | none |
| `AUTH_LOCAL_KEY_FILE` | local only | local | Local ES256 key pair file, created on first start | `.local/jwks.json` in the template |
| `AUTH_ADMIN_URL` | no, with `AUTH_ADMIN_SERVICE_KEY` | dev, staging, prod | Supabase project URL, used to delete the auth user on `DELETE /v1/me`. Without it the provider account is left in place | none |
| `AUTH_ADMIN_SERVICE_KEY` | no, with `AUTH_ADMIN_URL` | dev, staging, prod | Supabase service-role key for the call above. Secret, full admin rights | none |
| `CONFIG_FILE` | no | all | Remote config document served at `GET /v1/config` | `config/remote-config.json` |

Safety guards, enforced at startup (a violation throws a `ConfigError` naming the variable):

- `APP_ENV=dev`, `staging` and `prod` refuse a `DATABASE_URL` that points at a local host: `localhost` (also `localhost.` and `*.localhost`), any `127.0.0.0/8` address, `::1` in any spelling, `::`, IPv4-mapped loopback (`::ffff:127.0.0.1`), `0.0.0.0`, `host.docker.internal`, or an empty host (a Unix socket, `postgres:///db?host=/var/run/postgresql`). `APP_ENV=local` is unrestricted.
- The Vercel entrypoint (`api/index.ts`) refuses `APP_ENV=local`.
- `AUTH_LOCAL_KEY_FILE` is only allowed when `APP_ENV=local`, so self-signed local tokens can never be accepted elsewhere.
- `AUTH_JWKS_URL` and `AUTH_JWT_SECRET` are mutually exclusive, and one of them is required outside local.
- `AUTH_ADMIN_URL` and `AUTH_ADMIN_SERVICE_KEY` must be set together or not at all.
- Empty strings count as unset.

## Auth

The iOS app signs in with Apple through Supabase Auth and sends the resulting Supabase JWT as `Authorization: Bearer <jwt>`. The API verifies the token locally (no call to Supabase) using `AUTH_JWKS_URL` or the HS256 `AUTH_JWT_SECRET`, and enforces `iss`, `aud` and `exp`.

If the signing keys cannot be fetched (JWKS timeout, network error, non-200 or invalid JWKS response), authenticated routes answer **503** `service_unavailable` instead of 401, so a Supabase outage does not sign users out. Clients should retry a 503 and only treat a 401 as "signed out". A token whose key id is not in the JWKS is still 401.

Locally there is no Supabase: `npm run token` signs a token with the local key file that the local server trusts.

`GET /v1/config` is public; everything under `/v1/trips` and `/v1/me` requires a token.

### Users and identities

Our user id does not depend on the identity provider. A token only proves "issuer X says subject Y"; the API maps that pair to its own `users.id` and uses only that id (trips reference `users.id`, never the provider subject).

```
Bearer token -> verifier -> { issuer, subject, email? }
             -> user resolver (find-or-create in `identities`) -> users.id
             -> routes (trips, /v1/me)
```

- **Provisioning is automatic.** The first authenticated request for an unknown `(issuer, subject)` creates the user (and copies the token's `email`, if any). It is safe under concurrent first requests: one user is created, the others pick it up (a transaction-scoped advisory lock keyed by the identity, with the `identities` primary key as backstop).
- Only `iss`, `sub` and optionally `email` are read from the token, never provider-specific claims, so Apple, email/magic link and Google sign-in through Supabase need no code. The subject is opaque (1-255 characters).
- Accounts are **never linked by email** (an unverified email would allow account takeover). Linking a second identity to a user is a future, explicit action.
- Tables: `users (id, display_name, email, locale, created_at, updated_at)` and `identities (issuer, subject, user_id, created_at)` with primary key `(issuer, subject)`; `trips.user_id` references `users.id` with `on delete cascade`.
- Migration `002_users.sql` backfills one user per distinct existing `trips.user_id` (the old Supabase user id becomes `users.id`) and links it to the configured `AUTH_ISSUER`, so existing sessions keep working and no trip data moves. It needs `AUTH_ISSUER` at migration time, which `npm run migrate` and the local server pass automatically. Run it with the same issuer the tokens carry.

### Profile endpoints

- `GET /v1/me`: the profile (`id`, `displayName`, `email`, `locale`, `createdAt`, `updatedAt`).
- `PATCH /v1/me`: change `displayName` (max 100 characters) and/or `locale` (a BCP 47 tag such as `en-GB`). Absent fields are unchanged, `null` clears, at least one field is required (422 otherwise). `id` and `email` cannot be changed.
- `DELETE /v1/me`: hard-deletes the user; their trips and identities cascade (204). Required by Apple for apps with Sign in with Apple. Afterwards the identity provider is asked to delete the sign-in account through the `IdentityProviderAdmin` port (Supabase adapter when `AUTH_ADMIN_URL` and `AUTH_ADMIN_SERVICE_KEY` are set, no-op otherwise, including locally). Provider cleanup is best effort: a failure is logged and the request still answers 204. The Supabase adapter has not been exercised against a real project yet.

A token that is still valid after deletion (it lives until `exp`) provisions a fresh, empty account on the next request. Clients should drop the session after a successful delete.

### Swapping auth providers later

The API is configured for **one issuer** today. Multi-issuer support (`AUTH_ISSUERS` as a list, each with its own JWKS) is deliberately not built yet; this is the documented swap path:

1. Add the new issuer and its JWKS to config (this is the part that needs multi-issuer support: the verifier would pick the key set by the token's `iss`).
2. Run a one-off script that inserts `identities` rows (new issuer, new subject, existing `user_id`). No trip data moves.
3. Remove the old issuer from config.

## Deploying

### Supabase (once per project: staging and prod)

1. Create the project (staging, then prod).
2. Enable the Apple provider under Authentication > Providers.
3. Copy the pooled (transaction pooler) connection string, port 6543, for `DATABASE_URL`.
4. Note the issuer (`https://<project-ref>.supabase.co/auth/v1`) for `AUTH_ISSUER` and the JWKS URL (`<issuer>/.well-known/jwks.json`) for `AUTH_JWKS_URL`. Projects still on the legacy shared secret can use `AUTH_JWT_SECRET` instead.

### Vercel

1. Create one Vercel project from this repo. `vercel.json` rewrites `/v1/(.*)` to the `api/index.ts` function and bundles `config/**`.
2. Set environment variables per target, using the templates in `env/`:
   - Preview deployments: the **dev** set (staging project, `DB_SCHEMA=dev`, `APP_ENV=dev`), with a branch-scoped override for branch `staging` (the **staging** set) that must take precedence over the generic Preview (dev) variables.
   - Production (`master`): the **prod** set.
3. `public/` is committed empty on purpose: with the "Other" framework preset Vercel serves `public/` as static output, and without it may serve the repository root. Do not delete it.

### Migrations

Migrations are **not** run on request or at function start, and **nothing in CI or Vercel runs them**. Apply them yourself against the target environment **before the new code goes live** (before promoting or merging a change that needs them):

```sh
DATABASE_URL=... DB_SCHEMA=... APP_ENV=... AUTH_ISSUER=... AUTH_JWKS_URL=... npm run migrate
```

`npm run migrate` loads the same config as the server (so all required variables must be present, including the auth ones) and prints the migrations it applied. Locally, `npm run dev` runs them for you.

`002_users.sql` is not compatible with the previous code (the old code writes trips for users that have no `users` row, which the new foreign key rejects), so deploy right after migrating. It also needs `AUTH_ISSUER` to match the `iss` of the tokens already in use, because that is the issuer it links existing users to.

### Updating the config document

Edit `config/remote-config.json` (or the file `CONFIG_FILE` points at) and ship it with a deploy. If you change a file on a long-running host, replace it atomically (write a temp file, then rename it over the original) because the file is read per request and a partial write would be served.

### First-deploy checklist

The Vercel wiring (rewrite, function entrypoint, bundled files) is covered by local tests but **has not been verified against a real Vercel deploy yet**. On the first deploy, check:

0. Run `npm run migrate` against this environment before the first request (see [Migrations](#migrations)).
1. `curl https://<preview>/v1/config` returns 200 JSON. If every route returns 404, the `/v1/(.*)` to `/api` rewrite is handing the function the `/api` path instead of the original; adjust `vercel.json` / `api/index.ts`.
2. An authenticated `GET /v1/trips` returns `{"items":[],"nextCursor":null}`, and `GET /v1/me` returns the profile (creating the user on first call).
3. `config/remote-config.json` is bundled (`includeFiles` in `vercel.json`). If `/v1/config` returns 500, check how `CONFIG_FILE` resolves in the function.
4. A missing or invalid environment variable shows up as a cold-start failure or 500 in the Vercel function logs, with a `ConfigError` message naming the variable.
5. Source files are not served: `curl -i https://<preview>/package.json` and `curl -i https://<preview>/src/app.ts` must both return 404, not the file.
6. `hono/vercel` is deprecated in Hono 4.13 and moves to `@hono/vercel` in Hono v5. Plan the swap when upgrading.

## Before release: upgrade Vercel and Supabase to Pro

**Upgrade both Vercel and Supabase to the Pro plan before release.** Vercel Hobby is for non-commercial use only. Supabase free projects pause when idle, which would make the API unavailable.

## Testing

```sh
npm test            # vitest
npm run lint        # eslint
npm run build       # tsc --noEmit (type-check only)
```

By default `npm test` runs against an **in-process PGlite database**, so no Docker is needed. Set `TEST_DATABASE_URL` to run against real Postgres instead; CI does:

```sh
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/imontour_test npm test
```

Each test file works in its own throwaway schema.

| Folder / file | Covers |
|---|---|
| `test/schemas` | Trip document validation (days, UUIDs, open strings, limits) |
| `test/domain` | Trip summary derivation (place names, start/end day) |
| `test/http` | ETag/If-Match parsing and cursor encoding |
| `test/repo` | Postgres trip and user repositories (CRUD, revisions, pagination, per-user isolation, delete cascade) |
| `test/routes` | HTTP routes: trips, `/v1/me`, config, body limit |
| `test/auth` | Token verification, user resolver (provisioning, concurrency), provider admin adapters, local key handling |
| `test/db` | Migrations, including the `002_users.sql` backfill |
| `test/env.test.ts`, `test/env.examples.test.ts` | Config loading, safety guards, `env/*.example` drift |
| `test/deps.test.ts`, `test/e2e.local.test.ts` | Dependency wiring and a full local lifecycle |
| `test/errors.test.ts` | Error mapping (Postgres invalid-input codes to 422, generic 500) |
| `test/openapi.test.ts` | OpenAPI document generation |

## OpenAPI

[`openapi.json`](openapi.json) is generated from the Zod schemas and route declarations. Regenerate it with `npm run openapi` and commit the result; CI runs `npm run openapi:check` and fails if it is out of date.

Operation ids: `listTrips`, `createTrip`, `getTrip`, `replaceTrip`, `renameTrip`, `deleteTrip`, `getMe`, `updateMe`, `deleteMe`, `getConfig`.

Notes for client generation:

- `color`, `place.type` and `timing.mode` are **open strings, never enums**. Clients must accept unknown values and ignore unknown fields. The OpenAPI descriptions list the known values.
- Day fields (`startDay`, `endDay`) are `yyyy-MM-dd` strings with no time or zone.
- The iOS `tripID` is `id` in the API.
- Ids are RFC UUIDs. In request bodies, nil or hand-made UUIDs (wrong version/variant bits) are rejected with 422; a bad id in the path is simply a 404.
- The trip `id` is returned lowercase. Destination ids are returned exactly as sent (iOS `UUID().uuidString` is uppercase), so compare ids as `UUID` values, not strings.
- Timestamps (`updatedAt`) carry fractional seconds, e.g. `2026-10-20T16:22:19.857Z`. Swift decoders need `.withFractionalSeconds`, e.g. `ISO8601DateTranscoder(options: [.withInternetDateTime, .withFractionalSeconds])` for swift-openapi-generator, or a custom `JSONDecoder.dateDecodingStrategy`.
- `schemaVersion` is an integer; only `1` exists. Treat a value above 1 as unsupported.
- `If-Match` is documented as required on PUT; a request without it gets 428.
- Authenticated operations can answer 503 when the auth key service is unreachable (see [Auth](#auth)).

## API behavior notes

- **Revisions:** every trip has an integer `revision`, returned as a quoted `ETag` (`"3"`) on GET, POST, PUT and PATCH.
- **PUT** replaces the whole document and requires `If-Match`: missing is **428**, stale is **412** with `currentRevision` in the body. `id`, `revision` and `updatedAt` in the body are ignored.
- **PATCH** only renames. `If-Match` is optional; when sent, a stale value is 412.
- **Not yours is not found:** another user's trip, or an id that is not a UUID, returns 404.
- **The profile has no revision**: `/v1/me` sends no `ETag` and ignores `If-Match` (last write wins).
- **Errors** share one shape: `{"error":{"code":"...","message":"..."}}`. A 412 adds a top-level `currentRevision`.
- **POST** takes one body schema: a trip whose `destinations` is optional (absent means `[]`, an empty trip). A client-supplied `id` and destination ids are kept; a duplicate id is 409.
- **Content type:** request bodies must be `application/json`, otherwise 415. A request with **no** `Content-Type` and no body validates as `{}`: POST creates an empty trip (201), PUT and PATCH answer 422.
- **Unknown fields** in request bodies are stripped, not stored.
- **Text:** strings containing a NUL character or an unpaired UTF-16 surrogate are rejected with 422 (Postgres cannot store them).
- **Limits:** 1 MB body (413) and at most 200 destinations (422).
- **List:** `limit` defaults to 20 (max 100); `nextCursor` is an opaque string, `null` on the last page; a bad cursor is 400. Pagination never returns a duplicate, but a trip edited between page requests (for example from another device) moves to the front and can be missing from that traversal until the list is reloaded from page 1.
- `GET /v1/config` is public, sends an `ETag` and `Cache-Control: no-cache`, and answers 304 to a matching `If-None-Match`.

## Project layout

```
api/index.ts          Vercel entrypoint (thin adapter)
src/
  server.ts           local Node server (runs migrations when APP_ENV=local)
  app.ts              builds the Hono app from dependencies
  deps.ts, env.ts     wiring and environment validation
  routes/, schemas/   HTTP routes and Zod schemas
  repo/, db/          Postgres repositories (trips, users) and client
  auth/, http/        token verification, user resolver, provider admin port + adapters, ETag and cursor helpers
  domain/             trip summary logic
db/migrations/        SQL migrations (applied in filename order)
scripts/              token, migrate, generate-openapi
config/               remote-config.json
env/                  per-environment variable templates
docker/, docker-compose.yml   local Postgres (development only)
test/                 vitest suites
openapi.json          generated API description
```

## Git workflow

Work on feature branches and open pull requests; do not merge without review. CI (`.github/workflows/ci.yml`) runs lint, type-check, tests against Postgres 16, and the OpenAPI check on every pull request and on pushes to `master`.
