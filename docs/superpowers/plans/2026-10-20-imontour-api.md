# Imontour API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `/v1` trips and config API for the Imontour iOS app: a document store with revision-checked saves, Supabase-JWT auth, four environments (local, dev, staging, prod), and a committed OpenAPI spec.

**Architecture:** A Hono app built by a pure `createApp(deps)` factory (dependencies: `TripRepo`, token verifier, remote config). Postgres stores each trip as one row with the destinations in `jsonb`. Thin adapters (`src/server.ts` for local Node, `api/index.ts` for Vercel) wire real dependencies from env vars. Nothing in `src/` outside the adapters knows about Vercel or Supabase.

**Tech Stack:** TypeScript (strict, ESM), Node 22, npm, Hono + `@hono/zod-openapi`, `@hono/node-server`, `zod`, `jose` (JWT), `postgres` (porsager, `prepare: false`), Vitest, ESLint (flat config, typescript-eslint), Docker Compose (local Postgres), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-20-imontour-api-design.md` (read it first; "Resolved details" and "Environments" are binding).

## Global Constraints

- Server is a document store: it never recomputes dates, totals, transition days or any derived value, and never sorts or reorders `destinations`.
- All routes under `/v1`; JSON; every route except `GET /v1/config` requires `Authorization: Bearer <JWT>`. Owner id is the JWT `sub`. Another user's trip is `404`, never `403`.
- Unknown `color`, `place.type`, `timing.mode` values are stored as-is (any non-empty string). Unknown fields (top-level and nested) are dropped on write.
- Days are `yyyy-MM-dd` strings and must be real calendar days. `latitude` in [-90, 90], `longitude` in [-180, 180]; `durationDays` integer >= 1; `targetYear` integer; `targetMonth` integer 1-12. Max 200 destinations, 1 MB body (`413` above). Empty `destinations` is valid.
- `schemaVersion` defaults to 1 on input; above 1 is `422`. `revision` and `updatedAt` are server-owned (input values ignored); `revision` increments by 1 per successful write.
- `ETag` is the quoted revision (`"3"`). `If-Match` accepts quoted or bare integer. PUT without `If-Match` is `428`; malformed `If-Match` is `400`; stale is `412` with the current revision in the body. `PATCH` accepts an optional `If-Match` and always bumps `revision` and `updatedAt`.
- Errors: `400` unparseable JSON/malformed header/cursor; `422` schema violation; body shape `{"error":{"code":string,"message":string}}`.
- Primary key `(user_id, id)`; `409` on duplicate id for the same user only.
- List: order `updated_at desc, id desc`, keyset pagination, opaque base64 cursor, default limit 20, max 100. Summary fields: `{id, name, destinationCount, placeNames (first 3 displayNames in array order), startDay, endDay, updatedAt}`; `startDay`/`endDay` = earliest/latest explicit `startDay`/`endDay` string across all destinations, `null` if none.
- Auth: verify locally with `jose`; exactly one of `AUTH_JWKS_URL` or `AUTH_JWT_SECRET` (HS256); enforce `iss` = `AUTH_ISSUER`, `aud` = `AUTH_AUDIENCE` (default `authenticated`); 60 s clock skew. `AUTH_LOCAL_KEY_FILE` is allowed only when `APP_ENV=local`.
- `APP_ENV` is `local | dev | staging | prod`; code never branches on it for behavior except the safety checks in `loadConfig`. No Vercel/Supabase APIs outside `api/` and docs. Database via `DATABASE_URL` and optional `DB_SCHEMA` (default `public`).
- Config document (`GET /v1/config`): static JSON file (`CONFIG_FILE`, default `config/remote-config.json`), permissive defaults, `ETag` = content hash, `If-None-Match` → `304`.
- OpenAPI 3.1 generated from the same Zod schemas, committed as `openapi.json`, with an up-to-date check.
- Git: feature branch, small commits. **Do not push and do not open a PR until the user says so** (they will ask to review the changes first). Never merge. Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; the PR description ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Review Focus

- A trip carrying a color, place type and timing mode this server has never seen must round-trip unchanged through POST, GET and PUT (Task 3, Task 8).
- Summaries when only some destinations have explicit days, when days are out of chronological order across destinations, or when none do (Task 4).
- Two PUTs racing on the same revision: exactly one `200`, the other `412`, never both applied (Task 6).
- A non-UUID `{id}` in the path, a tampered cursor, and a non-numeric `limit`: clean `404`/`400`, never a 500 (Task 8).
- Unicode and empty-string names (emoji, CJK, `""` vs `null`) and `rawInput` with quotes/newlines survive storage exactly (Task 6).
- An expired token, wrong audience, wrong issuer, or a token signed by an unknown key is `401`, not a crash (Task 7).

---

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, eslint.config.js, .gitignore, docker-compose.yml
env/{local,dev,staging,prod}.env.example
config/remote-config.json
db/migrations/001_trips.sql
src/env.ts                config parsing + safety checks
src/errors.ts             ApiError, error handler
src/schemas/trip.ts       Zod schemas (single source for validation + OpenAPI)
src/domain/summary.ts     pure: summarize(trip)
src/http/etag.ts          pure: formatEtag, parseIfMatch
src/http/cursor.ts        pure: encodeCursor, decodeCursor
src/db/client.ts          createDb, runMigrations
src/repo/trips.ts         TripRepo interface + Postgres implementation
src/auth/verifier.ts      createVerifier
src/auth/middleware.ts    bearer auth middleware
src/auth/localKeys.ts     local dev key pair + token signing (local only)
src/routes/trips.ts       trips routes
src/routes/config.ts      config route
src/app.ts                createApp(deps)
src/server.ts             local Node entrypoint
api/index.ts              Vercel entrypoint
scripts/token.ts, scripts/generate-openapi.ts
test/**                   mirrors src/; test/helpers/{db,app}.ts
.github/workflows/ci.yml, README.md, openapi.json
```

---

### Task 1: Repo, tooling and scaffold

**Files:** Create `package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`, `.gitignore`, `docker-compose.yml`, `test/smoke.test.ts`.

**Interfaces:** Produces npm scripts: `dev`, `build` (`tsc --noEmit`), `lint`, `test`, `db:up` (`docker compose up -d --wait`), `db:down`, `token`, `openapi`, `openapi:check`. Test Postgres URL default `postgres://postgres:postgres@localhost:54329/imontour_test`, overridable by `TEST_DATABASE_URL`.

- [ ] **Step 1:** `git init -b master`, add remote `origin https://github.com/blackbird-house/imontour-api.git`. `.gitignore` covers `node_modules`, `.env*` (but not `env/*.example`), `.vercel`, `.local/`, `dist`. Commit the existing `docs/` on `master` as `docs: add API design and implementation plan`. Then `git switch -c feat/trips-api`.
- [ ] **Step 2:** Create the files above. `docker-compose.yml`: one `postgres:16` service, port `54329:5432`, user/password `postgres`, databases `imontour` (dev) and `imontour_test`, healthcheck so `--wait` works. `tsconfig`: strict, `module: NodeNext`, `target: ES2022`. `vitest.config.ts`: `include: ['test/**/*.test.ts']`, `fileParallelism: false`.
- [ ] **Step 3: Write failing smoke test** `test/smoke.test.ts`: `expect(1 + 1).toBe(2)`. Run `npm test` → PASS once tooling works; run `npm run lint` and `npm run build` → both succeed with no output errors.
- [ ] **Step 4: Commit** `chore: scaffold TypeScript project with Vitest, ESLint, docker-compose`.

### Task 2: Environment config

**Files:** Create `src/env.ts`, `test/env.test.ts`.

**Interfaces:** Produces
```ts
export type AppEnv = 'local' | 'dev' | 'staging' | 'prod'
export type AuthConfig = { issuer: string; audience: string; jwksUrl?: string; jwtSecret?: string; localKeyFile?: string }
export type Config = { appEnv: AppEnv; port: number; databaseUrl: string; dbSchema: string; auth: AuthConfig; configFile: string }
export class ConfigError extends Error {}
export function loadConfig(env: Record<string, string | undefined>): Config
```

- [ ] **Step 1: Write failing tests** in `test/env.test.ts`: valid dev env parses; missing `DATABASE_URL` throws `ConfigError`; `APP_ENV=qa` throws; both `AUTH_JWKS_URL` and `AUTH_JWT_SECRET` set throws; neither set throws (unless `APP_ENV=local` with `AUTH_LOCAL_KEY_FILE`); `AUTH_LOCAL_KEY_FILE` with `APP_ENV=prod` throws; `APP_ENV=prod` with `DATABASE_URL` host `localhost`/`127.0.0.1` throws; defaults: `AUTH_AUDIENCE='authenticated'`, `DB_SCHEMA='public'`, `PORT=3000`, `CONFIG_FILE='config/remote-config.json'`.
- [ ] **Step 2:** Run → FAIL (module missing).
- [ ] **Step 3:** Implement `loadConfig` with Zod parsing of the env record, then the cross-field checks above, throwing `ConfigError` with a message naming the variable.
- [ ] **Step 4:** Run `npm test -- env` → PASS. **Step 5: Commit** `feat: add environment config with safety checks`.

### Task 3: Trip schemas

**Files:** Create `src/schemas/trip.ts`, `test/schemas/trip.test.ts`.

**Interfaces:** Produces Zod schemas and inferred types:
```ts
export const CURRENT_SCHEMA_VERSION = 1
export const dayString: z.ZodString            // yyyy-MM-dd, real calendar day
export const destinationSchema, placeSchema, timingSchema
export const tripInputSchema      // POST (full) / PUT body: {schemaVersion?, id?, name?, destinations[]}
export const newTripNameOnlySchema // {name?}
export const tripSchema           // response: input + {id, revision, updatedAt}
export const tripSummarySchema, tripListSchema // {items, nextCursor}
export const renameSchema         // {name: string|null}
export const errorSchema
export type Trip, TripInput, TripSummary, Destination
```
`tripInputSchema` strips unknown keys (Zod default) and ignores `revision`/`updatedAt`.

- [ ] **Step 1: Write failing tests**: accepts the spec's example trip; accepts `color: 'chartreuse'`, `place.type: 'island'`, `timing.mode: 'sabbatical'` and returns them unchanged; rejects `startDay: '2026-02-30'`, `'2026-4-1'`, `'2026-04-01T00:00'`; rejects latitude 91, longitude -181, `durationDays: 0`, `targetMonth: 13`; rejects 201 destinations, accepts 200 and 0; `schemaVersion: 2` fails and absent defaults to 1; unknown key `foo` at top level and inside a destination is stripped; `name: ''` is kept as `''`, `name: null` kept as `null`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement schemas with `@hono/zod-openapi`'s `z` (so `.openapi()` metadata can be attached later). Day validity: regex plus round-trip through `Date.UTC`.
- [ ] **Step 4:** Run → PASS. **Step 5: Commit** `feat: add trip Zod schemas`.

### Task 4: Pure helpers (summary, ETag, cursor)

**Files:** Create `src/domain/summary.ts`, `src/http/etag.ts`, `src/http/cursor.ts`; tests in `test/domain/summary.test.ts`, `test/http/etag.test.ts`, `test/http/cursor.test.ts`.

**Interfaces:** Produces
```ts
export function summarize(t: Pick<Trip,'id'|'name'|'updatedAt'|'destinations'>): TripSummary
export function formatEtag(revision: number): string                     // '"3"'
export function parseIfMatch(header: string | undefined): number | 'missing' | 'invalid'
export type Cursor = { updatedAt: string; id: string }
export function encodeCursor(c: Cursor): string
export function decodeCursor(s: string): Cursor | null                    // null if tampered/invalid
```

- [ ] **Step 1: Write failing tests.** Summary: no destinations → count 0, `placeNames []`, both days null; four destinations → `placeNames` is the first three in array order; explicit days `2026-06-10..2026-06-12` in destination 1 and `2026-04-01..2026-04-03` in destination 2 → `startDay '2026-04-01'`, `endDay '2026-06-12'` (not array order); only some destinations have days → min/max of those present; a destination with only `startDay` counts; none → null/null; `durationDays`/`fuzzyMonth` timings contribute nothing. ETag: `formatEtag(3) === '"3"'`; `parseIfMatch('"3"') === 3`, `('3') === 3`, `(undefined) === 'missing'`, `('abc')`, `('"3')`, `('-1')`, `('1.5')` → `'invalid'`. Cursor: round-trip equality; `decodeCursor('not base64!!')` and valid base64 of non-JSON and JSON missing fields → `null`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; min/max by plain string comparison (valid days sort lexicographically). **Step 4:** Run → PASS. **Step 5: Commit** `feat: add summary, ETag and cursor helpers`.

### Task 5: Database client, migration, test harness

**Files:** Create `db/migrations/001_trips.sql`, `src/db/client.ts`, `test/helpers/db.ts`, `test/db/migrate.test.ts`.

**Interfaces:** Produces
```ts
export type Db = ReturnType<typeof postgres>   // porsager sql tag
export function createDb(databaseUrl: string): Db   // options: prepare:false, max small, idle_timeout
export function runMigrations(db: Db, schema: string): Promise<string[]>  // returns applied filenames
// test/helpers/db.ts
export function createTestSchema(): Promise<{ db: Db; schema: string; drop(): Promise<void> }>
```
Queries always qualify tables with `db(schema)` identifier; never rely on `search_path` (poolers drop it).

- [ ] **Step 1: Write failing test** `migrate.test.ts`: in a fresh schema `runMigrations` applies `001_trips.sql` and returns `['001_trips.sql']`; running again returns `[]`; table `trips` has PK `(user_id, id)` and index on `(user_id, updated_at desc, id desc)`. Needs `npm run db:up` first.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Write `001_trips.sql` per the spec data model (`user_id uuid`, `id uuid`, `name text null`, `schema_version int`, `revision int`, `destinations jsonb`, `created_at`/`updated_at timestamptz`); a `schema_migrations(filename primary key)` table tracks applied files, each file runs in a transaction. `createTestSchema` creates schema `t_<random>`, migrates it, and `drop()` cascades.
- [ ] **Step 4:** Run → PASS. **Step 5: Commit** `feat: add Postgres client, migrations and test harness`.

### Task 6: Trip repository

**Files:** Create `src/repo/trips.ts`, `test/repo/trips.test.ts`.

**Interfaces:** Consumes `Db`, `summarize`, cursor helpers, schema types. Produces
```ts
export type WriteResult = { kind: 'ok'; trip: Trip } | { kind: 'stale'; currentRevision: number } | { kind: 'missing' }
export interface TripRepo {
  list(userId: string, opts: { limit: number; cursor?: Cursor }): Promise<{ items: TripSummary[]; nextCursor: Cursor | null }>
  get(userId: string, id: string): Promise<Trip | null>
  create(userId: string, input: TripInput): Promise<Trip>               // throws DuplicateTripError
  replace(userId: string, id: string, expectedRevision: number, input: TripInput): Promise<WriteResult>
  rename(userId: string, id: string, name: string | null, expectedRevision?: number): Promise<WriteResult>
  remove(userId: string, id: string): Promise<boolean>
}
export class DuplicateTripError extends Error {}
export function createTripRepo(db: Db, schema: string): TripRepo
```
`create` generates `id` (`crypto.randomUUID()`) if absent, revision starts at 1. `replace` is one `UPDATE ... WHERE user_id AND id AND revision = $expected RETURNING`; on zero rows, a follow-up `SELECT revision` distinguishes `stale` from `missing`. `list` fetches `limit + 1` rows with keyset `(updated_at, id) < (cursor)`.

- [ ] **Step 1: Write failing tests** (real DB via `createTestSchema` in `beforeAll`): create then get returns identical destinations incl. unknown color/type/mode; revision 1 after create, 2 after replace; replace with wrong revision → `stale` with current revision, row unchanged; replace missing id → `missing`; **race**: `Promise.all` of two `replace` calls with the same expected revision → exactly one `ok` and one `stale`; user B `get`/`replace`/`rename`/`remove` on user A's id → `null`/`missing`/`missing`/`false`; user B can create the same `id` as A without error; same user creating twice → `DuplicateTripError`; `rename` bumps revision and `updatedAt`, honors `expectedRevision` when given and ignores when absent; names `''`, `'東京 🗼'`, and `rawInput` with `"`, `\n`, `\\` round-trip exactly; list returns newest first, pagination across 5 trips with `limit: 2` visits each once (create-order controlled by setting `updated_at` explicitly via SQL), `nextCursor` null on the last page.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS. **Step 5: Commit** `feat: add Postgres trip repository`.

### Task 7: Auth (verifier, middleware, local keys)

**Files:** Create `src/auth/verifier.ts`, `src/auth/middleware.ts`, `src/auth/localKeys.ts`, `src/errors.ts`, `scripts/token.ts`, `test/auth/verifier.test.ts`, `test/helpers/tokens.ts`.

**Interfaces:** Consumes `AuthConfig`. Produces
```ts
export type VerifyToken = (token: string) => Promise<{ userId: string }>   // throws UnauthorizedError
export function createVerifier(auth: AuthConfig): VerifyToken
export class ApiError extends Error { constructor(status: number, code: string, message: string) }
export function errorHandler(err: Error, c: Context): Response              // maps ApiError, ZodError→422, others→500 generic
export function bearerAuth(verify: VerifyToken): MiddlewareHandler          // sets c.set('userId', string); 401 on failure
// localKeys.ts (local only)
export function ensureLocalKeyFile(path: string): Promise<void>             // generates ES256 key pair JSON if absent
export function signLocalToken(path: string, opts: { sub: string; iss: string; aud: string; expiresIn?: string }): Promise<string>
```
`npm run token -- [sub]` prints a bearer token for `APP_ENV=local` (refuses otherwise); default `sub` is a fixed dev UUID.

- [ ] **Step 1: Write failing tests** using a generated ES256 key pair and `createLocalJWKSet` (tests inject the key set; production code uses `createRemoteJWKSet` for `jwksUrl`): valid token → `{userId: sub}`; expired → `UnauthorizedError`; wrong `aud`; wrong `iss`; signed by a different key; `alg: none`; HS256 token accepted when `jwtSecret` configured and rejected when only JWKS is configured; token expiring 30 s ago accepted (skew), 90 s ago rejected; middleware: missing header, `Basic x`, empty bearer → 401 with `{error:{code:'unauthorized',...}}`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement with `jose` (`jwtVerify` with `issuer`, `audience`, `clockTolerance: 60`, `algorithms` restricted to ES256/RS256/EdDSA for JWKS and HS256 for secret). `localKeyFile` mode builds the key set from the file.
- [ ] **Step 4:** Run → PASS. **Step 5: Commit** `feat: add JWT verification, auth middleware and local token helper`.

### Task 8: App and trip routes

**Files:** Create `src/app.ts`, `src/routes/trips.ts`, `test/helpers/app.ts`, `test/routes/trips.test.ts`.

**Interfaces:** Consumes `TripRepo`, `VerifyToken`, `RemoteConfigSource` (Task 9; use a stub `() => ({ body, etag })` until then via the `deps` type). Produces
```ts
export type Deps = { repo: TripRepo; verify: VerifyToken; remoteConfig: RemoteConfigSource }
export function createApp(deps: Deps): OpenAPIHono
```
`test/helpers/app.ts` builds the app over a `createTestSchema` repo with a fixed key pair and returns `{ app, tokenFor(userId): Promise<string>, request(path, init) }`.
Route behavior is exactly the spec's "Endpoints" plus "Resolved details"; every route is defined with `createRoute` so Task 10 can emit OpenAPI.

- [ ] **Step 1: Write failing route tests** (via `app.request`): `POST` name-only → 201, `ETag: "1"`, `Location: /v1/trips/<id>`, empty destinations; `POST` full trip keeps client `id` and destination ids; `{name:'x', destinations: []}` is treated as full; unknown color/type/mode round-trip through POST → GET; duplicate `id` same user → 409, other user → 201; `GET` other user's trip → 404; `GET /v1/trips/not-a-uuid` → 404 and `PUT`/`PATCH`/`DELETE` likewise; `GET /v1/trips?limit=abc`, `limit=0`, `limit=101`, `cursor=garbage` → 400; list items have exactly the summary keys; `PUT` without `If-Match` → 428, `If-Match: abc` → 400, stale → 412 with `{error:{code:'precondition_failed'}, currentRevision}`, correct → 200 with new `ETag` `"2"`; `PUT` body with `revision: 99` ignores it; `PATCH {name:'New'}` → 200 full trip, revision bumped; `PATCH` with stale `If-Match` → 412; `PATCH {}` → 422; `DELETE` → 204 then `GET` → 404; body > 1 MB → 413; 201 destinations → 422; invalid JSON → 400; no token → 401 on every trips route.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement routes; body-size limit via Hono's `bodyLimit` (1 MB); path `id` validated with `z.string().uuid()` but a failure maps to 404, not 422. Wire `errorHandler`.
- [ ] **Step 4:** Run → PASS. **Step 5: Commit** `feat: add trips routes`.

### Task 9: Remote config endpoint

**Files:** Create `config/remote-config.json`, `src/routes/config.ts`, `test/routes/config.test.ts`.

**Interfaces:** Produces
```ts
export type RemoteConfigSource = () => Promise<{ body: unknown; etag: string }>
export function createFileConfigSource(path: string): RemoteConfigSource   // reads file, ETag = quoted sha256 prefix of content
export function configRoute(source: RemoteConfigSource): OpenAPIHono        // GET /v1/config, public
```
Default document: `{"schemaVersion":1,"flags":{}}` (no version fields = no constraint).

- [ ] **Step 1: Write failing tests**: `GET /v1/config` with no token → 200 with the document and an `ETag`; second request with `If-None-Match` of that ETag → 304 with empty body; changing the file content changes the ETag; a file containing `{"minimumSupportedVersion":"1.2.0","flags":{"x":{"value":true,"rolloutPercent":50}}}` is served verbatim; missing file → 500 `{error:{code:'internal'}}`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement and mount in `createApp`. **Step 4:** Run → PASS. **Step 5: Commit** `feat: add remote config endpoint`.

### Task 10: OpenAPI generation

**Files:** Create `scripts/generate-openapi.ts`, `openapi.json`, `test/openapi.test.ts`.

**Interfaces:** `npm run openapi` writes `openapi.json` (stable key order, 2-space indent) from `createApp` with stub deps via `app.getOpenAPI31Document`; `npm run openapi:check` regenerates in memory and exits non-zero if it differs from the committed file.

- [ ] **Step 1: Write failing test** `test/openapi.test.ts`: the generated document is `openapi: 3.1.x`; contains paths `/v1/trips`, `/v1/trips/{id}`, `/v1/config`; `/v1/trips/{id}` has `get/put/patch/delete`; `PUT` documents `If-Match` and responses `200, 400, 401, 404, 412, 422, 428`; security scheme `bearerAuth` (http bearer JWT) applies to trips routes and not to `/v1/config`; `color`, `place.type`, `timing.mode` are `type: string` with known values in `description` or `examples` (no `enum`, so generated clients accept new values); committed `openapi.json` equals the generated one.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; add `.openapi({description, example})` metadata in `src/schemas/trip.ts` as needed. Run `npm run openapi` and commit the output.
- [ ] **Step 4:** Run → PASS. **Step 5: Commit** `feat: generate and check OpenAPI spec`.

### Task 11: Entrypoints and environments

**Files:** Create `src/server.ts`, `api/index.ts`, `vercel.json`, `env/{local,dev,staging,prod}.env.example`, `test/e2e.local.test.ts`.

**Interfaces:** `buildDeps(config: Config): Deps` in `src/server.ts`-adjacent module `src/deps.ts` (creates `Db`, runs nothing, builds repo, verifier, config source). `src/server.ts`: loads `.env` for local via `node --env-file`, calls `loadConfig`, on `APP_ENV=local` runs migrations and `ensureLocalKeyFile`, then serves with `@hono/node-server`. `api/index.ts`: `export default handle(createApp(buildDeps(loadConfig(process.env))))` using `hono/vercel`; no migrations at request time (migrations run via `npm run migrate`, a script added here). `vercel.json` rewrites `/v1/(.*)` to `/api`.

- [ ] **Step 1: Write failing e2e test** `e2e.local.test.ts`: with `APP_ENV=local` env set in-process and the test Postgres, build the app via `buildDeps`, mint a token with `signLocalToken`, then POST a full trip, GET it, GET the list, PUT with `If-Match`, DELETE, and assert statuses `201, 200, 200, 200, 204`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. Each `env/*.example` lists every variable with comments (`APP_ENV`, `DATABASE_URL`, `DB_SCHEMA`, `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_JWKS_URL` or `AUTH_JWT_SECRET`, `CONFIG_FILE`, `PORT`); local points at docker-compose and `AUTH_LOCAL_KEY_FILE=.local/jwks.json`; dev/staging/prod use placeholders (dev uses the staging project's pooled URL with `DB_SCHEMA=dev`) for a Supabase pooled URL and `https://<project-ref>.supabase.co/auth/v1` issuer.
- [ ] **Step 4:** Run `npm test` → PASS. Manually: `npm run db:up && cp env/local.env.example .env && npm run dev`, then `curl -H "Authorization: Bearer $(npm run -s token)" localhost:3000/v1/trips` → `{"items":[],"nextCursor":null}`.
- [ ] **Step 5: Commit** `feat: add local server, Vercel entrypoint and per-environment examples`.

### Task 12: README and CI

**Files:** Create `README.md`, `.github/workflows/ci.yml`.

- [ ] **Step 1:** README sections: what this is; quick start for local (docker, `.env`, migrate, dev, token, curl examples); the four environments and which variables each needs (table of every env var); how to create the Supabase project (enable Apple provider, copy pooled connection string, JWKS/issuer values) and the Vercel project (env vars per target, Preview=dev, `staging` branch, `master`=prod); the Supabase layout (two projects, staging and prod; dev runs on the staging project with `DB_SCHEMA=dev`); **a bold reminder to upgrade Vercel and Supabase to Pro before release**; running tests; regenerating OpenAPI; deployment migration step (`npm run migrate` against the target `DATABASE_URL`); pointer to the spec.
- [ ] **Step 2:** `ci.yml` on `pull_request` and push to `master`: Node 22, `npm ci`, Postgres 16 service container, `npm run lint`, `npm run build`, `npm test` (with `TEST_DATABASE_URL`), `npm run openapi:check`.
- [ ] **Step 3:** Verify locally: `npm run lint && npm run build && npm test && npm run openapi:check` → all exit 0. **Step 4: Commit** `docs: add README and CI workflow`.

### Task 13: Hand over for review (no push)

- [ ] **Step 1:** Run the full check: `npm run lint && npm run build && npm test && npm run openapi:check` → all exit 0. Confirm `git status` is clean and the history on `feat/trips-api` is small, readable commits.
- [ ] **Step 2:** Do **not** push and do **not** open a PR. Report to the user: the branch name, commit list, how to run locally, and the list of builder calls from the spec's "Resolved details". Wait for the user to ask to push; then (and only then) push, `gh pr create --base master` with the closing line from Global Constraints, never merge, and bind the PR with the app's PR tools.
- [ ] **Step 3:** Remind the user to upgrade Vercel and Supabase to Pro before release.

---

## Self-review notes

- Spec coverage: endpoints (Tasks 8, 9), data model and RLS decision (5, 6), auth (7), validation limits (3, 8), environments (2, 11), OpenAPI (10), README/CI/git (12, 13), Pro-upgrade reminder (12, 13, memory). Place-search proxy is explicitly out of v1.
- Names consistent across tasks: `TripRepo`, `WriteResult`, `Deps`, `VerifyToken`, `RemoteConfigSource`, `createTestSchema`, `signLocalToken`.
