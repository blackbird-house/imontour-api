# Legal documents (drafts)

Backlog #7: App Store Connect needs a privacy policy URL, privacy labels, and (for most apps) terms.

| File | What |
|---|---|
| [data-inventory.md](data-inventory.md) | What the backend stores, where, and for how long. The facts the other files rely on. |
| [privacy-policy.md](privacy-policy.md) | Draft policy. Needs a lawyer and the ⟦placeholders⟧ filled in. |
| [terms.md](terms.md) | Draft terms of service. Same. |
| [app-store-privacy-labels.md](app-store-privacy-labels.md) | Draft answers for the App Store Connect questionnaire (backend side only). |

## Publishing

The privacy policy and terms are served from this repo as static pages on the API domain: `https://<api-domain>/privacy` and `https://<api-domain>/terms` (Vercel serves `public/`; `cleanUrls` in `vercel.json` drops the `.html`). Use those URLs in App Store Connect and in the app.

```sh
npm run legal        # renders docs/legal/privacy-policy.md and terms.md to public/privacy.html and terms.html
npm run legal:check  # CI: fails if a draft is published, or a finished document is missing or stale
```

The pages are **only built once every ⟦placeholder⟧ is filled in**; until then `npm run legal` refuses, removes any stale output and nothing is served (`/privacy` is a 404). To publish: fill the placeholders in the two markdown files (after a lawyer's review), run `npm run legal`, commit `docs/legal` and `public/` together. To change the text later, edit the markdown and run `npm run legal` again; CI fails if the pages are stale.

Open items before App Store submission: fill the placeholders, lawyer review, confirm the Apple token revoke against a real account (backlog #3), and re-check these files against the iOS app's own data collection. Data export is handled by hand through the private admin endpoint (see the data inventory).
