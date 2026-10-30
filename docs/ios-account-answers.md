# Answers to the iOS app's account requirements

Reply to `docs/api/account-requirements.md` in [blackbird-house/imontour](https://github.com/blackbird-house/imontour) (written 2026-10-30), checked against this repo's `develop` branch on 2026-10-30. Item numbers match theirs.

**Short version.** No new endpoint, and the contract they rely on (section 1 of their request) is unchanged. Two of their assumptions do not hold as written (items 8 and 9, below). Everything marked **Owner** needs a person with access to Vercel, Supabase or Apple; it cannot be checked from the code.

| # | Answer | Status |
|---|---|---|
| 1 | The repo declares Apple and Google in [`supabase/config.toml`](../supabase/config.toml), pushed with `npm run supabase:push`. Only the **staging** Supabase project exists (backlog 8), so "which projects" is one. Whether it is pushed and works on a device is not verifiable here. | **Owner**: run `npm run supabase:diff`, then sign in from a device and report |
| 2 | Code is built and tested with a mocked Apple ([README](../README.md#account-deletion-and-sign-in-with-apple)). The four `APPLE_*` variables must be set in Vercel, then delete from a dev or TestFlight build and look for the app in Settings > Apple Account > Sign in with Apple. `APPLE_CLIENT_ID` must be the bundle id the code was issued for. | **Owner**: set variables, run the check |
| 3 | Same: `AUTH_ADMIN_URL` and `AUTH_ADMIN_SERVICE_KEY` must be set; the adapter has not run against a real project. After deleting, signing in again with the same Google account must give a new user id. | **Owner**: set variables, run the check |
| 4 | Today there is **one** deployed environment: `https://imontour-api.vercel.app`, schema `dev`, staging Supabase project. Dev, Staging and Production can all point there until the prod project exists (needs Pro, backlog 4 and 8). The Supabase project URL and anon key are in the staging project's dashboard (Settings > API); they are not in this repo. | **Owner**: hand over the Supabase URL and anon key |
| 5 | Agreed, and it gates the first TestFlight build (backlog 1). Not decided yet. Once it is, the `/privacy` and `/terms` URLs (item 11) follow from it. | **Owner**: choose and attach the domain |
| 6 | Not written down anywhere in this repo: `supabase/config.toml` does not set JWT expiry, rotation, reuse interval, inactivity timeout or time-box, so the hosted project is on whatever its dashboard shows (Supabase defaults unless someone changed them). The API does not depend on any of it: it checks only `iss`, `aud`, `exp` (60 s clock tolerance) and `sub`. | **Owner**: read Authentication > Sessions and JWT settings and post the values. We will tell the app first before turning a timeout on |
| 7 | Confirmed. `displayName` max 100 is counted in **UTF-16 code units** (`String.length`, same as Swift's `utf16.count`). `locale` max 35 with the pattern `^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$`, so `_` is accepted and stored as sent. Also: the server does **not** trim, and `""` is a valid `displayName`; a NUL or unpaired surrogate is a 422. | Done |
| 8 | `DELETE /v1/me` already answers **204 on a repeat** while the token is valid: the token is verified locally, so a deleted account's token keeps working until `exp`, and the call re-provisions an empty user and deletes it again. It never answers 404. Now stated in the contract and covered by a test. **So the app's "404 means already deleted" branch never fires on DELETE; just treat 204.** On a retry, send a fresh Apple code (the first may have been used). | Done in this change |
| 9 | **Not as the contract said.** `GET` and `PATCH /v1/me` do not answer 404 for a deleted user whose token is still valid: the first authenticated request provisions a **fresh, empty account** (200). 404 only happens in a race with a concurrent delete. The contract text is corrected. A token that outlives a deletion on another device therefore looks like a new account, not a signed-out one. See "Decision needed" below. | Corrected; **decision needed** |
| 10 | `email` is copied from the token's `email` claim when the account is first created and never updated. It is `null` when the claim is missing, empty, over 320 characters or has a NUL, for any provider. For Hide My Email the token should carry Apple's relay address, which is what Supabase puts in `email`; that is expected but not verified against a real account. | Done; relay case unverified |
| 11 | Routes `/privacy` and `/terms` exist, but `public/` is empty because the drafts in [`docs/legal`](legal/README.md) still have 18 placeholders. Final URLs will be `<final API domain>/privacy` and `/terms`. | **Owner**: fill placeholders, lawyer review, `npm run legal` |
| 12 | There is **no rate limiting** (backlog 13). Proposal: when added, answer `429` with `Retry-After` and the usual error envelope, and add `429` to the contract then. Until it is in `openapi.yaml`, treat it as "any other status". | Not built |

## Questions

- **`GET /v1/me` on every launch?** Fine for the API: it is one indexed read. Latency is the cost today (about 0.45 s per database call, backlog 9), so showing the cached profile first and refreshing in the background is the better experience. Their call.
- **`PATCH` with an unchanged value:** the API does not compare, so it always bumps `updatedAt`. Sending only changed fields avoids that.
- **Test user on staging without Apple or Google:** yes. In the staging project create an email user (Authentication > Users, "Auto Confirm User") and use the password grant shown in the [README](../README.md) to get a real `access_token` **and `refresh_token`**, so expiry and refresh can be exercised for real. Anonymous Supabase users are rejected with 401 on purpose.

## Decision needed (item 9)

A deleted account's token stays valid until `exp` (about an hour by default), and today it silently creates a new empty account. Options:

1. **Keep it** and tell the app: on delete, drop the session on every device; a second device may briefly see an empty account. No code change.
2. **Refuse to re-provision** for tokens issued before the deletion (keep a small record of deleted identities, answer 401 for a token with `iat` before the deletion time). Then `GET`/`PATCH` really say "gone" and the app's quiet sign-out works, at the price of a new table and a migration.

Recommendation: option 1 for now. It is safe, and the app already clears its own session on a successful delete. Revisit if multi-device sign-in becomes common.
