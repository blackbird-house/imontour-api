# Legal documents (drafts)

Backlog #7: App Store Connect needs a privacy policy URL, privacy labels, and (for most apps) terms.

| File | What |
|---|---|
| [data-inventory.md](data-inventory.md) | What the backend stores, where, and for how long. The facts the other files rely on. |
| [privacy-policy.md](privacy-policy.md) | Draft policy. Needs a lawyer and the ⟦placeholders⟧ filled in. |
| [terms.md](terms.md) | Draft terms of service. Same. |
| [app-store-privacy-labels.md](app-store-privacy-labels.md) | Draft answers for the App Store Connect questionnaire (backend side only). |

These are **not served** yet. To publish, the URLs must be stable and public (they go into App Store Connect and the app). Options, cheapest first: static pages in `public/` of this repo served on the API domain (e.g. `/privacy`, `/terms`, with `cleanUrls` in `vercel.json`), or a separate marketing site. That is an open decision, as is who the legal entity is.

Open items before App Store submission: fill the placeholders, lawyer review, decide on a data export (or a manual process), confirm the Apple token revoke (backlog #3), and re-check these files against the iOS app's own data collection.
