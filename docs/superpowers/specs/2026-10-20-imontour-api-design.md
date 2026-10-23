# Imontour API: design

Date: 2026-10-20. Status: draft for approval.

## Intent

Imontour is a native iOS/macOS SwiftUI trip-planning app (repo `blackbird-house/imontour`). Until now it kept one trip on the device (ADR-0014, "no backend"). The product now needs trips saved on a backend: a user has many trips, sees them as a list, and opening one shows its destinations and dates. The iOS app becomes a function of what the backend holds.

This repo (`blackbird-house/imontour-api`) is that backend. The frontend drives it: endpoints exist because a screen needs them. The iOS repo's CLAUDE.md and ADR-0014 still say "no backend"; writing the superseding ADR is the iOS side's job, not this repo's.

## Core design rule

**The server is a document store.** The client applies every trip rule: anchoring, reordering, recoloring, derived dates, totals, transition days. The server never recomputes or derives anything. It validates shape, stores what it is sent, and returns it in array order.

## Goals

- Store many trips per user; list, read, create, replace, rename, delete.
- Safe concurrent saves (revision check).
- A remote config document for force-upgrade and feature flags.
- An OpenAPI 3.1 spec the iOS side can generate or check a client against.
- Free-tier hosting now; cheap and easy to scale later.
- Hosting-agnostic: moving off Vercel or Supabase is a configuration change.

## Non-goals (v1)

- Offline support or sync. v1 requires a connection. The client may add a local cache later; the revision design already allows it.
- Server-side trip rules, date math, or any stored derived value (totals, transition days, trip length).
- Sharing, collaboration, or public trips. A trip belongs to exactly one user.
- Place search proxy (`/places/suggest`, `/places/search`): optional, later. See "Later".

## Anti-goals

- Rejecting a trip because of a value the server does not know (new color name, new timing mode, new place type). Unknown values are stored as-is.
- Reordering or sorting destinations. Array order is trip order.
- Silently losing an edit (hence If-Match / 412 instead of last-write-wins).
- Host lock-in: no Vercel- or Supabase-specific APIs in core logic.

## Decisions (settled with the user)

| # | Decision |
|---|---|
| Stack | TypeScript, Hono, Postgres. Trips stored as `jsonb`. |
| Hosting | Vercel (API) and Supabase (Postgres + Auth). Both on **free tiers until release**. Before release both must go to Pro (Vercel Hobby is non-commercial; Supabase free projects pause when idle). Claude must remind the user. |
| Portability | All environment-specific values come from env vars. Database via a plain Postgres connection string; auth via generic JWT verification (issuer and JWKS URL from env). The Vercel entrypoint is a thin adapter. |
| Auth | Sign in with Apple through Supabase Auth. The iOS app sends the Supabase JWT as `Authorization: Bearer`. The API verifies it and uses `sub` as the owner id. |
| Offline | v1 online-only. |
| Concurrency | `If-Match` / `412` on replace, as below. |
| List summaries | No derived totals. `startDay`/`endDay` are the earliest/latest explicit day found. |
| Migration | The iOS app uploads its existing local trip once on first sign-in (a normal `POST /v1/trips` with the full trip). No special endpoint. |

## API contract

All routes are under `/v1`, JSON, authenticated except `/v1/config`.

### Trip detail shape (mirrors iOS `TripDocument` v1)

```
{
  "schemaVersion": 1,
  "id": "uuid",
  "name": "string | null",
  "revision": 3,
  "updatedAt": "2026-10-20T09:00:00.000Z",
  "destinations": [
    {
      "id": "uuid",
      "rawInput": "string",
      "color": "coral",
      "place": {
        "displayName": "Tokyo",
        "type": "city",
        "latitude": 35.68,
        "longitude": 139.69,
        "geocodeSourceID": "string | null",
        "countryCode": "JP | null"
      },
      "timing": {
        "mode": "explicitDates",
        "startDay": "2026-04-01 | null",
        "endDay": "2026-04-05 | null",
        "durationDays": 5,
        "targetYear": null,
        "targetMonth": null,
        "isPlaceholder": false
      }
    }
  ]
}
```

Rules:
- `timing.mode` known values: `explicitDates`, `durationOnly`, `fuzzyMonth` (from iOS `Timing.swift`). `place.type` known values: `city`, `country`, `region` (from `Place.swift`). The OpenAPI spec documents these as known values but the server **stores any string**.
- `color` is a name string (today coral, amber, lime, teal, sky, indigo, violet, rose; the palette may grow). Never reject unknown names.
- Days are `yyyy-MM-dd` strings with no time or zone. The server validates the format of `startDay`/`endDay` when present.
- Unknown fields are ignored on input (not an error). Whether they are preserved on output is the builder's call (see below).
- Destination `id`s are client-generated UUIDs. `schemaVersion` is stored with the trip; the server accepts the version it knows and rejects higher ones with 422.
- `revision` and `updatedAt` are server-owned: input values are ignored.

### Endpoints

- `GET /v1/trips?limit&cursor` → summaries, newest first (by `updatedAt`). Item: `{id, name, destinationCount, placeNames (first 3 destination displayNames, in array order), startDay, endDay, updatedAt}`. `startDay`/`endDay` = earliest/latest **explicit** day across all destinations' `startDay`/`endDay`, `null` if none. Response: `{items, nextCursor}`; `nextCursor` null on the last page.
- `POST /v1/trips` → body `{name?}` (creates an empty trip) or a full trip (creates it, keeping the client's `id` and destination ids; a client `id` is kept in either form). `201` with the trip, `ETag` = revision, `Location` header. If a trip with that `id` already exists for the user: `409`.
- `GET /v1/trips/{id}` → full trip, `ETag` = revision. Another user's trip is `404`, never `403`.
- `PUT /v1/trips/{id}` → replaces the whole trip. Requires `If-Match` (missing: `428`). Stale: `412` with the current revision in the body. Success: `200` with the new trip and new `ETag`. Revision increments by 1 per successful write.
- `PATCH /v1/trips/{id}` → body `{name}` only (string or null). Does not require `If-Match`; it still bumps the revision.
- `DELETE /v1/trips/{id}` → `204`. Deleting a missing trip is `404`.
- `GET /v1/config` → `{schemaVersion, minimumSupportedVersion, recommendedVersion, flags: {key: {value, rolloutPercent}}}`, with `ETag` (`304` on `If-None-Match`). Public, no auth. May be a static document served from a file or env. Missing or malformed version fields mean "no constraint" and the client fails open, so the server never needs to error here.

Errors use one JSON shape: `{error: {code, message}}`.

### Later (not v1)

Place search proxy `GET /places/suggest?q=` and `/places/search?q=` over GeoNames, mirroring the Place fields. GeoNames quota is shared: 10,000 requests/day, 1,000/hour, so it needs caching and rate limiting. Out of scope until the iOS app asks for it.

## Data model (builder may refine)

One table `trips`: primary key `(user_id, id)`, `name text null`, `schema_version int`, `revision int`, `destinations jsonb` (the destinations array, stored as received), `created_at`, `updated_at`; index on `(user_id, updated_at desc, id)`. Every query filters by `user_id` from the verified JWT. Replace is `UPDATE ... WHERE id=$1 AND user_id=$2 AND revision=$3`. Plain Postgres: no `auth` schema, no RLS in v1 (see "Resolved details").

## Constraints

- Free tiers of Vercel and Supabase for now.
- Serverless: use Supabase's pooled connection string; no long-lived connection assumptions.
- Tests ship with the code. A README documents setup and run commands and every env var.
- Git hygiene: feature branch, small commits, open a PR against `blackbird-house/imontour-api`, **do not merge it**.
- OpenAPI spec is generated from the same Zod schemas that validate requests, committed as `openapi.yaml` (first generated as `openapi.json`, switched to YAML on 2026-10-23), with a check that it is up to date.

## Left to the builder

- Hono project layout, Zod/OpenAPI library choice, migration tool, test setup (Postgres in a container, or pg-mem/PGlite).
- Cursor format for pagination, limit defaults and max.
- Whether unknown fields are preserved or dropped on write.
- Request size limits, rate limiting, logging format.
- Name of the Vercel adapter and `vercel.json` details.

## Resolved details

Added after a builder review. Everything here is **Claude's call** (not a decision the user made); the user can change any of it.

**Auth verification**
- Verify tokens locally, never by calling Supabase per request. Use `jose`.
- Primary mode: asymmetric keys from a JWKS URL (`AUTH_JWKS_URL`). Fallback for legacy projects: a shared HS256 secret (`AUTH_JWT_SECRET`). Exactly one of the two must be set; the app fails to start otherwise.
- Enforce `iss` = `AUTH_ISSUER` and `aud` = `AUTH_AUDIENCE` (default `authenticated`, Supabase's value). Clock skew tolerance 60 s. Owner id = `sub`.
- Tests sign tokens with a locally generated key pair and serve a local JWKS, so they exercise the real verification path.

**RLS**
- **Superseded by migration `003_enable_rls.sql`** (RLS on, no policies, `anon`/`authenticated` grants revoked) because on Supabase the `public` schema is reachable through the Data API with the public anon key. The API itself is unaffected (it connects as the table owner). Original note: not a v1 deliverable. The API connects with a privileged role that bypasses RLS, so RLS would add nothing and would complicate tests. Isolation is enforced in code: every query filters on `user_id`, and a test proves user A cannot read, change or delete user B's trip. RLS can be added later if clients ever query the database directly.

**POST /v1/trips**
- The POST body is one schema (`CreateTripBody`): a trip input whose `destinations` is optional. An absent `destinations` is `[]`, so `{name?}`, `{}` and no body create an empty trip. A client `id` is kept whenever it is sent (also without `destinations`), and `schemaVersion` is validated in every case. When present, `destinations` must be an array (possibly empty).
- Full trip: the client's `id` and destination ids are kept. `id` is optional; the server generates one if absent. `schemaVersion` defaults to 1 if absent; a higher version than the server knows is `422`.
- Primary key is `(user_id, id)`, so two users can hold the same id. `409` applies only to a duplicate for the same user and leaks nothing about other users.

**Top-level fields**
- The iOS `TripDocument` v1 has exactly: `schemaVersion`, `tripID`, `name`, `destinations` (confirmed in `TripDocument.swift`). The API contract names `tripID` as `id`; the iOS client maps between them. Unknown top-level and nested fields are dropped on write (ignored on input, not stored).

**Validation**
- `400` for unparseable JSON or a malformed `If-Match`; `422` for a body that parses but breaks the schema.
- Required: destination `id` (uuid), `rawInput`, `color`, `place.displayName`, `place.type`, `place.latitude`, `place.longitude`, `timing.mode`, `timing.isPlaceholder`. Optional/nullable: `name`, `geocodeSourceID`, `countryCode`, `startDay`, `endDay`, `durationDays`, `targetYear`, `targetMonth`.
- `latitude` in [-90, 90], `longitude` in [-180, 180]; `durationDays`, `targetYear`, `targetMonth` are integers (`targetMonth` 1-12; `durationDays` at least 1). `color`, `place.type` and `timing.mode` are any non-empty string.
- Empty `destinations` is valid. Limits: at most 200 destinations and a 1 MB body.
- `ETag` is the revision as a quoted string (`"3"`). `If-Match` accepts the quoted form and a bare integer. Missing `If-Match` on PUT is `428`.

**PATCH**
- Returns the full trip, bumps `revision` and `updatedAt`. The documented contract is an unconditional rename (no `If-Match`): behind Vercel a `PATCH` carrying `If-Match` gets a platform 412 after the rename was applied (found on the first real deploy), so it was removed from `openapi.yaml`. The server still honours a stale `If-Match` when called directly. A rename therefore makes a concurrent in-flight PUT based on the old revision return `412`, and the client reloads. This is intended.

**GET /v1/config**
- A static JSON file in the repo, with permissive defaults: no minimum or recommended version and an empty `flags` object. `ETag` is a hash of the content; supports `If-None-Match` → `304`. Contents are owned by the user and edited by changing the file (or pointing `CONFIG_FILE` at another).

**Pagination**
- Order `updated_at desc, id desc`, keyset pagination on those two columns, opaque base64 cursor. Default limit 20, max 100. Keyset pagination never returns a duplicate; a trip edited between page requests (for example from another device) moves to the front and can be missing from that traversal until the list is reloaded from page 1.

**Tooling and delivery**
- Node 22 LTS, npm. Vitest. Integration tests run against a real Postgres (docker-compose locally, a service container in CI).
- A GitHub Actions workflow runs lint, type-check, tests and the OpenAPI up-to-date check on pull requests.
- Creating the Vercel and Supabase projects is a manual step for the user, documented in the README. Nothing in the build requires them to exist; deployment is verified later.
- Repo hygiene: `git init`, remote `https://github.com/blackbird-house/imontour-api.git`, feature branch, small commits, open a PR, do not merge.

## Environments (added at approval)

Four environments: **local, dev, staging, prod**. They mirror the iOS app's Dev / Staging / Production schemes, plus local for the developer's machine.

- Selected by `APP_ENV` = `local | dev | staging | prod`. The code never branches on the environment name for behavior; it only reads the env vars below. `APP_ENV` is used for logging labels and to refuse unsafe combinations (for example `prod` with a local database URL).
- Each environment has its own database, its own auth project (own JWKS URL, issuer, audience) and its own config document. No data is shared between environments.
- **local:** runs entirely on the developer's machine with no cloud account. `docker compose up` starts Postgres; migrations run automatically; a dev-only token helper (`npm run token`) signs JWTs with a local key pair and the API serves or trusts the matching local JWKS, so the iOS app or curl can call the API without Sign in with Apple. The helper and the local key are refused when `APP_ENV` is not `local`.
- **dev, staging, prod:** each is a Vercel deployment target plus a Supabase project, configured only through env vars (see `.env.example` per environment; real values live in Vercel/Supabase, never in git).
- Supabase layout (user decision): only two Supabase projects, **staging** and **prod**. `local` uses Docker Postgres. `dev` runs on the staging project in its own schema (`DB_SCHEMA=dev`), so dev and staging data stay separate. The code only takes a connection string and `DB_SCHEMA`, so giving dev its own project later is a config change.
- Pushing (user decision): do not push or open a PR until the user asks to review the changes first.
- Vercel maps naturally: preview deployments for dev, a staging branch for staging, main for prod, each with its own env var set.
