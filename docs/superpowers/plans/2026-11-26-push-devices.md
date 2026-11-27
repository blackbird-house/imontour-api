# Push notifications stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Devices table, `PUT`/`DELETE /v1/me/devices/{installId}`, an APNs sender and a test-push route, so the iOS app can register and we can verify delivery.

**Architecture:** A `devices` table (cascade-deleted with the user), a `DeviceRepo` and a `PushSender` interface injected through `Deps` like the Apple revoker. The real sender signs an ES256 provider token with `jose` and posts over `node:http2` through a replaceable transport, so every test runs against fakes.

**Tech Stack:** TypeScript, Hono + `@hono/zod-openapi`, `postgres`, `jose`, vitest (PGlite), existing generators (`npm run openapi`, `npm run collection`).

**Spec:** `docs/superpowers/specs/2026-11-26-push-devices-design.md`

## Global Constraints

- Branch `feat/push-devices` (already created from `develop`). Commit locally after each task; **do not push** and do not open a PR until asked.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- No new npm dependencies. APNs auth uses `jose`; transport uses `node:http2`.
- Device endpoints require the bearer token; a guest never calls them.
- Wire format exactly as in `imontour/docs/api/push-requirements.md` §1: `apnsToken` hex at most 200 characters; `apnsEnvironment` `development`|`production`; `platform` `ios`|`ipados`|`macos`; `tripStartLeadDays` one of 0, 1, 3, 7; `preferences` a flat `string -> boolean | integer | string | null` object whose unknown keys are kept; user cap 20 devices.
- Errors use the existing `{ error: { code, message } }` envelope; a bad value is `422` and the message names the field (the ZodError path does this already).
- `PUT` answers `200`, `DELETE` always `204`. Test route: `404` when `APP_ENV=prod`.
- Every change that adds an env var, endpoint or file layout updates `README.md` in the same change (project rule). `npm run openapi:check` and `npm run collection:check` must be clean.
- Never send or log a device token anywhere except to APNs.

## Review Focus

1. A second user `PUT`s an `installId` the first user owns: the record moves, and the first user's later `DELETE` answers `204` without removing it. (Task 3 route test.)
2. The 21st device drops the least recently active one and never the row just written. (Task 1.)
3. A token with non-hex characters or 201 characters, a `tripStartLeadDays` of 2, a nested object inside `preferences`, and a time zone like `Mars/Base` are each `422` naming the field. (Task 3.)
4. The test route for an `installId` that belongs to someone else answers `404`, and in prod answers `404` even when push is not configured. (Task 4.)
5. A sender that throws, or APNs answering a retryable failure, is `502`, never `500`; a dead token removes the record and answers `409`. (Task 4.)

---

## File structure

- Create `db/migrations/004_devices.sql`: the table, index, RLS.
- Create `src/schemas/device.ts`: zod schemas and types for the body and the stored record.
- Create `src/repo/devices.ts`: `DeviceRepo`.
- Create `src/push/types.ts`: `PushSender`, `PushTarget`, `PushMessage`, `PushResult`, `PushDeps`.
- Create `src/push/apns.ts`: `createApnsSender` and the default HTTP/2 transport.
- Create `src/routes/devices.ts`: the three routes.
- Modify `src/env.ts`, `src/deps.ts`, `src/app.ts`, `src/openapi.ts`, `src/collection.ts`, `src/schemas/user.ts` (export the locale regex), `test/helpers/app.ts`, `test/db/migrate.test.ts`, `test/openapi.test.ts`, `test/env.test.ts`.
- Create tests: `test/repo/devices.test.ts`, `test/push/apns.test.ts`, `test/routes/devices.test.ts`.
- Modify docs: `README.md`, `env/*.env.example` (four files), `docs/legal/data-inventory.md`, `docs/legal/app-store-privacy-labels.md`.
- Regenerate: `openapi.yaml`, `bruno/`.

---

### Task 1: Devices table and repository

**Files:**
- Create: `db/migrations/004_devices.sql`, `src/schemas/device.ts`, `src/repo/devices.ts`
- Modify: `src/schemas/user.ts` (export `LOCALE`), `test/db/migrate.test.ts`
- Test: `test/repo/devices.test.ts`

**Interfaces:**
- Produces (`src/schemas/device.ts`): `deviceInputSchema`, `deviceSchema` (input fields plus `createdAt`, `updatedAt`, both ISO), types `DeviceInput`, `Device`; `installIdParamSchema = z.object({ installId: z.uuid() })`.
- Produces (`src/repo/devices.ts`):
  - `MAX_DEVICES_PER_USER = 20`
  - `interface DeviceRepo { upsert(userId: string, installId: string, input: DeviceInput, topic: string | null): Promise<Device>; remove(userId: string, installId: string): Promise<void>; getPushTarget(userId: string, installId: string): Promise<PushTarget | null> }`
  - `createDeviceRepo(db: Db, schema: string): DeviceRepo`
  - `PushTarget` is imported from `src/push/types.ts` (`{ token: string; environment: 'development' | 'production'; topic: string | null }`); create that file now with all the push types listed in Task 2's Interfaces, since this task needs `PushTarget`.

- [ ] **Step 1: Write the failing tests** in `test/repo/devices.test.ts` (same harness as `test/repo/users.test.ts`, users made with `insertUser`):
  - `upserts a device and returns the stored record with createdAt and updatedAt`
  - `a second upsert of the same installId updates in place and keeps createdAt`
  - `the same installId upserted by another user moves to that user` (the first user's `remove` then deletes nothing: `getPushTarget` for the new owner still returns it)
  - `remove deletes only the caller's own record and is a no-op otherwise`
  - `getPushTarget returns token, environment and topic for the owner and null for anyone else`
  - `keeps at most 20 devices per user, dropping the least recently active, never the one just written` (insert 21 with ascending `lastActiveAt`, the 21st carrying the oldest `lastActiveAt` of all: it must survive and the next-oldest is the one dropped)
  - `deleting the user deletes their devices`
  - Update `test/db/migrate.test.ts`: add `'004_devices.sql'` to `MIGRATIONS`, and `'devices'` to the sorted table list in the RLS test.

- [ ] **Step 2: Run to verify failure**
  Run: `npx vitest run test/repo/devices.test.ts test/db/migrate.test.ts`
  Expected: FAIL (module and migration missing).

- [ ] **Step 3: Implement.**
  - `004_devices.sql` with the `{{schema}}` placeholder like 001: columns exactly as in the spec ("Table `devices`"); `install_id uuid primary key`; `user_id uuid not null references {{schema}}.users (id) on delete cascade`; `preferences jsonb not null default '{}'`; `created_at`/`updated_at timestamptz not null default now()`; index `devices_user_idx` on `(user_id, last_active_at desc)`; and `alter table {{schema}}.devices enable row level security;` (003 only covered the tables that existed then).
  - `deviceInputSchema` fields: `apnsToken` (`/^[0-9a-fA-F]+$/`, 1 to 200), `apnsEnvironment`, `platform`, `appVersion` (max 32), `locale` (reuse the exported `LOCALE` regex and `MAX_LOCALE_LENGTH`), `timeZone` (max 64, valid when `new Intl.DateTimeFormat('en', { timeZone })` does not throw), `lastActiveAt` (`z.iso.datetime()`), `preferences` (record as in Global Constraints, at most 50 keys, key max 64, string value max 200, plus a `superRefine` that rejects a `tripStartLeadDays` not in 0, 1, 3, 7 with `path: ['preferences', 'tripStartLeadDays']`). Add `.openapi` examples matching the iOS doc.
  - `upsert`: one transaction; `insert … on conflict (install_id) do update` setting every column and `user_id`, `updated_at = now()`, not touching `created_at`; then delete the user's rows beyond `MAX_DEVICES_PER_USER` ordered by `last_active_at desc, updated_at desc`, excluding `install_id`. Return `Device` with ISO timestamps.

- [ ] **Step 4: Run to verify pass**
  Run: `npx vitest run test/repo/devices.test.ts test/db/migrate.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add db src test
  git commit -m "feat(push): devices table and repository"
  ```

---

### Task 2: APNs sender

**Files:**
- Create: `src/push/apns.ts` (and `src/push/types.ts` if Task 1 did not)
- Test: `test/push/apns.test.ts`

**Interfaces:**
- Produces (`src/push/types.ts`):
  - `PushTarget` (see Task 1)
  - `PushMessage = { title: string; body: string; kind: string; collapseId?: string; expiresAt?: Date }`
  - `PushResult = { kind: 'delivered' } | { kind: 'token_invalid'; reason: string } | { kind: 'failed'; status: number | null; reason: string }`
  - `interface PushSender { send(target: PushTarget, message: PushMessage): Promise<PushResult> }` (never rejects)
  - `PushDeps = { sender: PushSender | null; topic: string | null; testRouteEnabled: boolean }`
- Produces (`src/push/apns.ts`):
  - `type ApnsConfig = { teamId: string; keyId: string; privateKey: string }` (literal `\n` accepted like `appleRevoke.ts`)
  - `type ApnsTransport = (req: { origin: string; path: string; headers: Record<string, string>; body: string; timeoutMs: number }) => Promise<{ status: number; body: string }>`
  - `createApnsSender(config: ApnsConfig, transport?: ApnsTransport, now?: () => number): PushSender`

- [ ] **Step 1: Write the failing tests** in `test/push/apns.test.ts` with a fake transport that records requests and returns scripted responses, and a P-256 key made with jose `generateKeyPair('ES256', { extractable: true })` + `exportPKCS8`:
  - `posts to the sandbox host for a development token and the production host otherwise`
  - `sends the documented request`: path `/3/device/<token>`, headers `apns-topic` (the target's topic), `apns-push-type: alert`, `apns-priority: 10`, `apns-collapse-id` and `apns-expiration` (epoch seconds) when given, and the body `{"aps":{"alert":{"title":…,"body":…},"sound":"default"},"kind":…}`
  - `signs the provider token with ES256, kid = keyId, iss = teamId, and sends it as "bearer <jwt>"` (decode with `decodeProtectedHeader`/`decodeJwt`)
  - `reuses the provider token for 50 minutes, then signs a new one` (inject `now`)
  - `200 is delivered`
  - `410 is token_invalid`; `400 BadDeviceToken` and `400 DeviceTokenNotForTopic` are token_invalid
  - `400 PayloadTooLarge, 403 ExpiredProviderToken, 429 and 500 are failed with the status and reason`, and a 403 `ExpiredProviderToken` makes the next send sign a fresh token
  - `a transport that throws is failed with status null, not a rejection`
  - `a target with a null topic is failed without calling the transport`

- [ ] **Step 2: Run to verify failure**
  Run: `npx vitest run test/push/apns.test.ts`
  Expected: FAIL (module missing).

- [ ] **Step 3: Implement `createApnsSender`.** Hosts: `https://api.sandbox.push.apple.com` for `development`, `https://api.push.apple.com` for `production`. Provider token via `importPKCS8` + `SignJWT` (`{ alg: 'ES256', kid }`, `iss`, `iat`), cached for 50 minutes. Classify as in the tests (`reason` comes from the response JSON `{ "reason": … }`, empty string when the body is not JSON). The default transport opens `http2.connect(origin)`, makes one POST, collects the body, closes the session, and enforces `timeoutMs` (5000); any error rejects so the sender can map it to `failed`.

- [ ] **Step 4: Run to verify pass**
  Run: `npx vitest run test/push/apns.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add src/push test/push
  git commit -m "feat(push): APNs sender over HTTP/2 with token auth"
  ```

---

### Task 3: Config, wiring and the device endpoints

**Files:**
- Create: `src/routes/devices.ts`
- Modify: `src/env.ts`, `src/deps.ts`, `src/app.ts`, `src/openapi.ts`, `test/helpers/app.ts`, `test/env.test.ts`, `env/dev.env.example`, `env/local.env.example`, `env/staging.env.example`, `env/prod.env.example`
- Test: `test/routes/devices.test.ts`, `test/env.test.ts`

**Interfaces:**
- Consumes: `DeviceRepo`, `PushDeps`, `createApnsSender`, schemas from Tasks 1 and 2.
- Produces:
  - `Config.apns?: { teamId: string; keyId: string; privateKey: string; topic: string }` from env `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY`, `APNS_TOPIC`: all four or none (same error style as the Apple group: "… must be set together").
  - `Deps.devices: DeviceRepo` and `Deps.push: PushDeps`.
  - `buildDeps` sets `push = { sender: config.apns ? createApnsSender(…) : null, topic: config.apns?.topic ?? null, testRouteEnabled: config.appEnv !== 'prod' }`.
  - `registerDeviceRoutes(app: MeApp, devices: DeviceRepo, push: PushDeps): void`, with operationIds `putDevice` and `deleteDevice`, tag `Devices`, security `bearerAuth`.
  - `app.ts`: the auth middleware and the body limit for `PUT`/`POST` now cover `/v1/me/*` (replace the two `/v1/me` registrations; `/v1/me/*` also matches `/v1/me`).
  - `test/helpers/app.ts`: `stubDeps` gets `devices` (unused stubs) and `push: { sender: null, topic: null, testRouteEnabled: true }`; `createTestApp` uses `createDeviceRepo` and a recording fake sender exposed as `sent` plus a settable `pushResult`, with `topic: 'com.test.app'`. `src/openapi.ts` gets the matching Proxy entries.

- [ ] **Step 1: Write the failing tests.**
  - `test/env.test.ts`: `loads APNs credentials only when all four are set` and `rejects a partial APNs group` (mirror the Apple tests).
  - `test/routes/devices.test.ts` (use `createTestApp`, `t.request`, a `validBody()` helper):
    - `PUT creates the device and returns 200 with the record plus createdAt and updatedAt`, storing the topic from config
    - `PUT is idempotent and updates fields on the same installId`
    - `PUT as another user moves the device, and the previous owner's DELETE leaves it in place` (Review Focus 1)
    - `PUT without a token is 401`, `PUT with a non-JSON body is 415`, `malformed JSON is 400`
    - 422 table test: `apnsToken` with a `g`, `apnsToken` of 201 characters, `apnsEnvironment: 'sandbox'`, `platform: 'android'`, `timeZone: 'Mars/Base'`, `locale: 'not a locale'`, `lastActiveAt: 'yesterday'`, `preferences.tripStartLeadDays: 2`, `preferences.nested: {}`, each asserting `error.message` starts with the field path (Review Focus 3)
    - `unknown preference keys are stored and returned`
    - `a non-UUID installId is rejected the same way GET /v1/trips/not-a-uuid is` (copy that status from the existing trips test)
    - `DELETE answers 204 for an existing, a missing and someone else's device, and removes only the caller's own`
    - `DELETE /v1/me removes the account's devices`

- [ ] **Step 2: Run to verify failure**
  Run: `npx vitest run test/routes/devices.test.ts test/env.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement** the env group, deps wiring, `registerDeviceRoutes` (`PUT` calls `devices.upsert(userId, installId, body, push.topic)`; `DELETE` calls `devices.remove`, then `c.body(null, 204)`), the `app.ts` changes and the helper updates. Document `422`, `400`, `401`, `413`, `415`, `500`, `503` responses like `me.ts`. Add the four commented `APNS_*` variables with a one-line explanation to each `env/*.env.example` (the env examples test ignores comments).

- [ ] **Step 4: Run to verify pass**
  Run: `npx vitest run test/routes test/env.test.ts test/env.examples.test.ts && npm run build && npm run lint`
  Expected: PASS, no type or lint errors.

- [ ] **Step 5: Commit**
  ```bash
  git add src env test
  git commit -m "feat(push): PUT and DELETE /v1/me/devices/{installId}"
  ```

---

### Task 4: Test push route

**Files:**
- Modify: `src/routes/devices.ts`
- Test: `test/routes/devices.test.ts`

**Interfaces:**
- Consumes: `DeviceRepo.getPushTarget`, `DeviceRepo.remove`, `PushDeps`, `PushSender`.
- Produces: operationId `testDevicePush`, `POST /v1/me/devices/{installId}/test`, no request body, responses `200` (delivered), `404`, `409`, `502`, `503`, plus the common `401`, `500`.

- [ ] **Step 1: Write the failing tests** (the fake sender's `pushResult` is settable):
  - `delivers a literal-text push to the caller's own device and answers 200` (assert `sent[0]` has the stored token, environment and topic, a fixed title `Imontour`, body `Test notification`, kind `test`, and no trip content)
  - `404 for an installId that belongs to someone else` and for a missing one (nothing is sent)
  - `404 when testRouteEnabled is false, even with no sender configured` (build the app with `push.testRouteEnabled = false`)
  - `503 when no sender is configured` (testRouteEnabled true, sender null)
  - `a token_invalid result removes the record and answers 409` (a following `getPushTarget` returns null)
  - `a failed result answers 502` and `a sender that throws answers 502, not 500`
  - `401 without a token`

- [ ] **Step 2: Run to verify failure**
  Run: `npx vitest run test/routes/devices.test.ts`
  Expected: FAIL (route missing).

- [ ] **Step 3: Implement the route.** Order of checks: route disabled (404), device lookup for the caller (404), sender configured (503), then send and map the result. Use `ApiError` with codes `not_found`, `conflict`, `bad_gateway`, `push_unavailable`; add `badGateway` and `serviceUnavailable` helpers to `src/errors.ts` only if the existing ones do not fit. Describe the prod behavior in the route description.

- [ ] **Step 4: Run to verify pass**
  Run: `npx vitest run test/routes/devices.test.ts && npm run build && npm run lint`
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add src test
  git commit -m "feat(push): test-push route, off in prod"
  ```

---

### Task 5: Contract, generated files and docs

**Files:**
- Modify: `src/collection.ts`, `test/openapi.test.ts`, `test/api/contract.test.ts`, `README.md`, `docs/legal/data-inventory.md`, `docs/legal/app-store-privacy-labels.md`
- Regenerate: `openapi.yaml`, `bruno/`

**Interfaces:**
- Consumes: the three operationIds `putDevice`, `deleteDevice`, `testDevicePush`.
- Produces: `EXAMPLES` entries for those three (`test/collection.test.ts` fails until each operation has one); `toRequestPath` maps `{installId}` to the fixed sample id `00000000-0000-4000-8000-000000000001`; `putDevice` example body is the iOS doc's sample with a short hex token.

- [ ] **Step 1: Update tests first.** In `test/openapi.test.ts`, extend the agreed operationIds list and any tag expectations with the three new operations. In `test/api/contract.test.ts` add: `PUT device answers 200 with the stored record and a second PUT is idempotent`, `DELETE device is 204 twice`, `device routes without a token are 401`, `test push for an unknown installId is 404`. Clean up the created device in the suite's cleanup.

- [ ] **Step 2: Run to verify failure**
  Run: `npx vitest run test/openapi.test.ts test/collection.test.ts test/api`
  Expected: FAIL (stale openapi.yaml, missing examples).

- [ ] **Step 3: Implement.** Add the `EXAMPLES` and path mapping; run `npm run openapi` and `npm run collection`. Docs: README gets a "Push notifications (devices)" section near "Profile endpoints" (the three endpoints, the `APNS_*` variables in the Variables table, what the Apple Developer portal needs: a `.p8` key with APNs enabled, its key id and team id, the Push Notifications capability per App ID, the topic per environment, the note that the topic is one value per API deployment so a build with another bundle id gets its token dropped by APNs, and that the test route is off in prod). `data-inventory.md` gains rows for the device token, platform, app version, locale, time zone, notification choices and `last_active_at` (purpose: sending notifications; removed with the account; in `devices`); update `app-store-privacy-labels.md` with the device identifier and notification choices linked to the account. Mark in the design doc's header that stage 1 is implemented.

- [ ] **Step 4: Run the whole suite**
  Run: `npm run format && npm test && npm run build && npm run lint && npm run openapi:check && npm run collection:check`
  Expected: all PASS and clean.

- [ ] **Step 5: Commit**
  ```bash
  git add -A
  git commit -m "feat(push): contract, generated client files and docs for devices"
  ```
