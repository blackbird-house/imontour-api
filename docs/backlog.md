# Backend backlog

What is left after the first deployed version, written down on 2026-10-23 so we can go through it together. Nothing here blocks local work. "Why it matters" is the reason to do it; "When" says what it waits for.

Status of the API today: all seven trip/profile/config operations are built, deployed to one Vercel environment (Production target, `APP_ENV=dev`, `DB_SCHEMA=dev`, staging Supabase project) and the black-box contract suite passes against it. See [README](../README.md) for how it runs.

## 1. Before real users (decide early, costly to change later)

| # | Item | Why it matters | When |
|---|---|---|---|
| 1 | **Custom API domain** (e.g. `api.<yourdomain>`) instead of `imontour-api.vercel.app` | The iOS app will hard-code the base URL. Changing it later means an app release and a period where old apps break. A custom domain also lets us move hosts without touching the app. | Before the first TestFlight build. A custom domain on Vercel is allowed on Hobby. |
| 2 | **Sign in with Apple actually configured in Supabase** (Services ID, team ID, key, redirect URL) | Without it no real user can sign in, and every authenticated route returns 401. Not verified yet. | Before the first TestFlight build |
| 3 | **Revoke the Apple token on account deletion** | Apple requires that deleting an account in the app also revokes the user's Sign in with Apple token. Supabase does not do it, so the API now does: `DELETE /v1/me` takes `X-Apple-Authorization-Code` and revokes through Apple's REST API (see README). **To finish:** set the four `APPLE_*` variables, make the iOS app send the header, and verify with a real account that the app disappears from the user's Apple Account settings. | Before App Store submission |
| 4 | **Real data must not live in the `dev` schema** | Today the only environment is `dev` in the staging project. Whatever users create there would have to be migrated into the prod project at launch. | Create the prod project and cut over before users arrive. Needs Pro. |
| 5 | **Per-user limits** (max trips per user, max total size) | A trip is capped at 1 MB and 200 destinations, but one user can create unlimited trips. That is a cheap way to fill the database. | Before public release |
| 6 | **Trip document `schemaVersion` upgrade plan** | The server accepts only `schemaVersion: 1` and rejects `2` with 422. When the app needs v2, server and app must roll out in a safe order, and old app versions must keep working. | Before the first change to the trip document |
| 7 | **Privacy policy and terms URLs, App Store privacy labels** | App Store Connect requires them. We store email, locale and trip data in the EU (`eu-west-1`). Data deletion exists; data export does not. | Before App Store submission |

## 2. Operations (mostly need a paid plan)

| # | Item | Why it matters | When |
|---|---|---|---|
| 8 | **Prod Supabase project + staging/prod variable sets in Vercel** | The README describes dev, staging and prod; only one environment exists. | Pro upgrade |
| 9 | **Vercel Function Region next to the database** (`dub1` or `lhr1`) | The function runs in `iad1` (US East) and the database is in `eu-west-1`: about 0.45 s per database call instead of about 0.1 s. | Pro upgrade |
| 10 | **Database backups and point-in-time recovery** | Without them an accidental delete or bad migration is unrecoverable. | Pro upgrade |
| 11 | **Error tracking, log retention and alerts** | Nothing tells us the API is failing; we find out from users. Vendor choice is deferred (see the platform audit). Unexpected 500s now log `request <id>:` plus the error, so a tracker can be wired to that one place (`errorHandler`). | Before release |
| 12 | ~~**Health endpoint + uptime monitor**~~ | Done: `GET /v1/health` (database check, 200/503). Still to do: create the uptime monitor itself once the custom domain is final. | Monitor: before release |
| 13 | **Rate limiting / abuse protection** | None today. Vercel firewall rules and spend caps are the usual answer. Without a cap a loop or an attacker can run up a bill. | Before public release; likely needs Pro |
| 14 | **Release housekeeping**: rotate the service-role key that was pasted in a chat, delete `.local/api-test-token`, upgrade Vercel and Supabase to Pro | Deliberately postponed until first release. | Release prep |
| 15 | **Automate or gate migrations** | Migrations are run by hand before a deploy that needs them. Forgetting one means 500s in production. A CI gate ("migrations for this change were applied") or a documented release checklist would close it. | Before the second schema change |
| 16 | **Migration rollback plan** | Migrations are forward-only. We should know, per migration, how to back out. | With #15 |

## 3. Engineering hygiene

| # | Item | Why it matters |
|---|---|---|
| 17 | **Dependency updates and `npm audit` in CI** (Dependabot or Renovate) | The API is internet-facing; known-vulnerable packages should surface automatically. |
| 18 | **Verify the database certificate** (`ssl: 'require'` encrypts but does not check the chain) | Needs Supabase's CA bundle. Protects against a man-in-the-middle between Vercel and the database. |
| 19 | **Pool size under serverless concurrency** | Each function instance opens up to 5 connections (`max: 5`); many instances at once could exhaust the Supabase pooler's limit. Likely fine at small scale; revisit with load. |
| 20 | ~~**Request IDs in logs**~~ | Done: `X-Request-Id` on every response; 500 log lines quote it. Ordinary request logging stays Vercel's. |
| 21 | **Scheduled run of the black-box suite** against the deployed API | A cheap synthetic check: it already exists and passes. Needs a dedicated test user and token handling. |
| 22 | **Swap `hono/vercel` for `@hono/vercel`** | The current import is deprecated and goes away in Hono v5. |
| 23 | **JSON 404 for paths outside `/v1`** | Vercel answers those with its own plain-text page before the app runs. Harmless for the app; a catch-all rewrite would fix it. |
| 24 | **Trip list reads the full `destinations` data** to build summaries | Fine at realistic sizes (worst case about 100 MB per page at the 1 MB cap); extract only needed fields in SQL if trips get large. |
| 25 | **Startup failure logs the raw error object** | Low risk; log `message` and `code` only. |
| 26 | **Atomic reads of the config file** | The config file is read per request; editing in place during a write could serve a partial document. Only matters on long-running hosts. |

## 4. Driven by the iOS app

| # | Item | Notes |
|---|---|---|
| 27 | **Offline behavior, migration of the existing local trip, the trip list** | The three open decisions in the iOS repo's ADR-0015. Each will likely change the API. |
| 28 | **Place-search proxy over GeoNames** (`/places/suggest`, `/places/search`) | Optional in the design; protects the shared GeoNames quota (10,000 a day, 1,000 an hour). Build when the app asks. |
| 29 | **Swift client generation from `openapi.yaml`** | May turn up contract changes. Operation ids are fixed. |
| 30 | **Real remote config values** | `GET /v1/config` serves `schemaVersion` and empty flags. Minimum and recommended app versions and feature flags are added when the app needs them. |
| 31 | **Decide how the app handles `503`** | The API answers 503 when the auth key service is unreachable, so the app should retry instead of signing the user out. Agree this when building the client. |

## Things we decided not to do, and why

- **Last-write-wins for everything:** rejected; `PUT` uses `If-Match` so a second device cannot silently erase edits.
- **`If-Match` on `PATCH`:** removed from the contract, because Vercel answers it with a platform 412 after the rename was applied.
- **Row-level security policies:** RLS is on with no policies (the API connects as the table owner). Add policies only if clients ever query the database directly.
