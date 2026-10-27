# Data inventory (what the backend stores)

Source of truth for the privacy policy and the App Store privacy labels. Written 2026-10-27 from the code and migrations; the iOS app may collect more on the device (analytics, crash reports), which this file does not cover. Update it in the same change as any schema or logging change.

## What we store

| Data | Where | Why | Linked to the user | Deleted by |
|---|---|---|---|---|
| Email address | `users.email`, copied from the sign-in token at first sign-in; also held by Supabase Auth | Informational; identifies the account | Yes | `DELETE /v1/me` |
| Display name | `users.display_name`, set by the user (max 100 chars) | Shown in the app | Yes | `DELETE /v1/me` |
| Locale | `users.locale` | Language of the app | Yes | `DELETE /v1/me` |
| Internal user id, sign-in provider and provider subject | `users.id`, `identities` | Maps a sign-in (Apple, Google) to the account | Yes | `DELETE /v1/me` |
| Trips: name, destinations (places, coordinates, dates, notes the user types), timestamps | `trips.destinations` (jsonb, max 1 MB per trip) | The app's core function: saving trips | Yes | `DELETE /v1/me` (cascade) |
| Request metadata (IP address, path, status, user agent) | Vercel function logs | Operating and debugging the API | Not by us; the logs have no user id | Vercel's log retention (Hobby is short; confirm on Pro) |

Not collected by the backend: precise device location (coordinates in trips are places the user chose, not where they are), contacts, photos, advertising identifiers, analytics, payment data. No data is sold or used for tracking.

## Where it lives

- Postgres and Auth: Supabase, region `eu-west-1` (Ireland). Staging today; a prod project is still to be created (backlog #4, #8).
- API runtime and logs: Vercel (function currently in `iad1`, US East, so request metadata is processed in the US until the region moves, backlog #9).
- Sign-in: Apple and Google. They tell us who the user is; we send them nothing except, on account deletion, the revoke request (backlog #3, not verified yet).

## Gaps the policy has to be honest about

1. **Data export is manual.** Users ask by email; the operator runs the private `POST /v1/admin/export` (README, "Data export"), after confirming the requester owns the account, and sends the JSON back. Needs `ADMIN_API_KEY` on the environment. There is deliberately no export endpoint for users.
2. **Apple token revoke on deletion** is implemented (`X-Apple-Authorization-Code`, README) but not yet verified against Apple (backlog #3).
3. **Log retention** period is not known; fill it in after the Pro upgrade.
4. **Backups** (backlog #10) will hold deleted data for the backup window once enabled; the policy should say so.
