# Push notifications, stage 1: devices, endpoints, APNs sender, test push

Date: 2026-11-26. Status: awaiting approval.

Source: the iOS request in `imontour/docs/api/push-requirements.md` (spec `docs/features/push-notifications.md`, ADR-0025: the API sends over APNs directly, no Firebase).

## Why

The app cannot register for server push until the API accepts a device record, and nothing can be tested on a real phone until the API can send one. Stage 1 unblocks the iOS network adapter and lets us verify delivery on dev and staging. It builds no reminder logic.

## Staging of the whole feature

1. **This doc:** devices table, `PUT`/`DELETE /v1/me/devices/{installId}`, APNs sender, test push.
2. Reminder scheduler (ledger, lateness rule, "skip fresh local schedule"). Needs an external tick; Vercel Hobby crons run once a day, so the choice (Vercel Pro, Supabase `pg_cron`, GitHub Actions) is made at the start of stage 2.
3. Announcement tool.

## Goals

- `PUT /v1/me/devices/{installId}` (idempotent upsert, moves the record to the caller if another user owned it) and `DELETE` (always `204`), both in `openapi.yaml`, the Bruno collection and the black-box contract suite.
- A `devices` table whose shape serves stage 2 without a migration for new settings.
- An APNs sender that can deliver one alert push and tells the caller what happened (delivered, token dead, retryable failure).
- `POST /v1/me/devices/{installId}/test` to push to the caller's own device.
- Account deletion removes the account's devices.

## Non-goals

- Reminders, the ledger, announcements, the 90-day purge (it needs a tick, so it lands with the scheduler).
- `429` and `Retry-After` on the new endpoints. No rate limiter exists (backlog #13); the iOS doc ranks this low. Revisit with the limiter.
- Silent push, Android, web push.

## Anti-goals

- A dead token retried forever, or a Staging token sent with the Production topic.
- Any trip content in a push payload.
- The test route reachable in production.

## Approaches considered

- **APNs client:** (A) our own, `jose` for the ES256 provider token plus `node:http2`, no new dependency, behind an injectable interface like the Apple revoke code; (B) a library such as `apns2`, less code but a dependency that is mostly one HTTP/2 call and unverified in a Vercel function. **Chosen: A.**
- **Test push:** (A) `POST /v1/me/devices/{installId}/test`, `404` when `APP_ENV=prod`, caller's own device only; (B) operator route behind `ADMIN_API_KEY`. **Chosen: A.**

## Design

**Table `devices`** (migration 004): `install_id uuid primary key`, `user_id uuid not null references users(id) on delete cascade`, `apns_token text`, `apns_environment text` (`development`|`production`), `apns_topic text`, `platform text` (`ios`|`ipados`|`macos`), `app_version text`, `locale text`, `time_zone text`, `last_active_at timestamptz`, `preferences jsonb not null default '{}'`, `created_at`, `updated_at`. Index on `user_id`. The foreign key cascade is what removes devices on `DELETE /v1/me`; no change to that route, but a contract test proves it.

**`PUT`:** validates the body as in the iOS doc: token is hex and at most 200 characters; locale is BCP 47 with a hyphen; `timeZone` is a real IANA zone (checked with `Intl.DateTimeFormat`); `lastActiveAt` is ISO 8601; `preferences` is a flat object of string to boolean, integer, string or null, unknown keys kept; `tripStartLeadDays` must be 0, 1, 3 or 7. A bad value is `422` naming the field. Upsert on `install_id`, setting `user_id` to the caller. The topic is stored on the record, taken from config. After the upsert, a user with more than 20 devices has the least recently active ones dropped. Response `200` with the stored record plus `createdAt` and `updatedAt`.

**`DELETE`:** `204` whether or not the record exists or belongs to someone else; it only deletes a row owned by the caller.

**APNs sender:** a `PushSender` interface in `deps` (real and fake, same pattern as the Apple revoke code). The real one signs a provider token from the `.p8` key (cached about 50 minutes), picks the host from the record's `apns_environment`, sets `apns-topic` from the record, and returns one of `delivered`, `token_invalid` (`410`, `BadDeviceToken`, `DeviceTokenNotForTopic`: the caller deletes the record) or `failed` (retryable). New optional env vars `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY`, `APNS_TOPIC`. Absent: push is disabled, the device endpoints still work, and the test route answers `503`.

**Test route:** looks up the caller's device, sends an alert push with a literal title and body (no trip content), maps the result to `200` (delivered), `404` (no such device for the caller, or `APP_ENV=prod`), `409` (token was invalid and the record is now removed), `502` (APNs failed), `503` (push not configured).

**Docs and housekeeping (same change, per project rules):** README (env vars, endpoints), `openapi.yaml` regenerated and `openapi:check` clean, Bruno collection regenerated, the push credentials added to `env/*.env.example`, and a privacy note in `docs/legal` listing the new data (token, platform, app version, locale, time zone, notification choices).

## Left to the builder

Exact error codes and message text (follow the existing envelope), file layout under `src/routes` and `src/repo` (follow `me.ts` and `users.ts`), the fake sender's shape, and test coverage (unit tests with the fake sender; contract tests for the endpoints, the owner move, the 20-device cap and the delete cascade).

## Needs from you, outside the code

An APNs auth key (`.p8`) with its key id and team id, and the Push Notifications capability on each App ID. Without them stage 1 is built and tested with the fake sender, and the first real delivery waits for the key.
