# App Store privacy labels (draft answers for App Store Connect)

Covers what the **backend** collects; see [data-inventory.md](data-inventory.md). The app's own SDKs (analytics, crash reporting) must be added by whoever owns the iOS repo. Answers below follow Apple's categories as of 2026-10; re-check the wording in App Store Connect.

**Do you or your third-party partners collect data from this app?** Yes.

| Apple category | Data type | Collected | Linked to user | Used for tracking | Purpose |
|---|---|---|---|---|---|
| Contact Info | Email Address | Yes | Yes | No | App Functionality |
| Contact Info | Name (display name) | Yes | Yes | No | App Functionality |
| User Content | Other User Content (trips and destinations) | Yes | Yes | No | App Functionality |
| Identifiers | User ID | Yes | Yes | No | App Functionality |

Everything else (Location, Usage Data, Diagnostics, Purchases, Financial Info, Health, Contacts, Browsing History, Search History, Sensitive Info): **not collected by the backend.** Trip coordinates are places the user picks, not device location. If the app uses Core Location or a crash reporter, those categories change.

**Tracking:** No. Nothing is shared with data brokers or used for advertising.

**Privacy policy URL** and (optional) **user privacy choices URL**: use the hosted policy once it exists (see [README](README.md)).

**Account deletion:** App Review requires in-app deletion for apps with account creation. The backend side exists (`DELETE /v1/me`); the app must expose it, and the Sign in with Apple token must be revoked (backlog #3).
