# installer/seed/ — the owner's data that ships inside the .exe

This folder holds the two seed files the installer bundles. They are
applied **only on a fresh install, when the target PC has no data
yet** — on an update they are never copied over existing data.

## The two files

| File | What it is | Where it comes from |
| --- | --- | --- |
| `leadhunter.db` | The agent's SQLite database: chat threads, chat messages, jobs, sources. | The owner's PC: `agent\leadhunter.db` (copy the file as-is). |
| `leadhunter.db.b64` | The same database, base64-encoded as text — because the push path is text-only, the binary `.db` cannot be pushed directly. The workflow decodes it back to `leadhunter.db` at build time (and checks the SQLite header). | Generated from `leadhunter.db` with `base64 -w0`. |

Both files are in place now. If either is missing at build time, the
| `leadhunter-v2.json` | The app's data: accounts, sources, leads, inbox threads, settings — everything the app shows. | Exported from the owner's browser (see below). |

Both files are in place now. If either is missing at build time, the
workflow logs a warning and the installer ships without that seed —
the app then starts empty, as before.

## How to export leadhunter-v2.json (owner only)

1. On the owner's PC, open the app at http://localhost:8080/.
2. Open the browser console (F12 → Console).
3. Paste this one line and press Enter — it downloads
   `leadhunter-v2.json` exactly as stored in this browser:

```js
const s = JSON.parse(localStorage.getItem('leadhunter:v2') || '{}'); const b = new Blob([JSON.stringify(s)], {type: 'application/json'}); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'leadhunter-v2.json'; a.click();
```

4. Put the downloaded file in this folder as `leadhunter-v2.json`.

## Security — read this

- **The seed carries the owner's Gemini API key, on purpose.**
  The owner explicitly decided the partner's app should open with
  his key already filled in Configurations. Consequence: anyone
  who gets this `.exe` can use his key and his Gemini quota — do
  not forward the installer to anyone the owner would not trust
  with the key. The partner can replace the key with their own in
  Configurations at any time.
- **Never put `agent/profiles/` here.** That folder holds the
  owner's logged-in Facebook session. The partner signs in to
  Facebook himself, once, from Agent Control. A shared Facebook
  session would log the partner in as the owner.
- These seed files contain the owner's business data. They are
  committed to this **private** repo so the GitHub Actions build
  can bundle them — they are visible to repo collaborators only.
  If this repo is ever made public, delete both files from this
  folder first.

## How the seed is used

- Build: `.github/workflows/build-windows-installer.yml` copies
  `leadhunter.db` → `build/payload/agent/leadhunter.db` and
  `leadhunter-v2.json` → `build/payload/public/seed.json`
  (only when the files exist here).
- Install: `installer/setup-helper.ps1` copies the seed database
  to `{app}\agent\leadhunter.db` and the seed file to
  `{app}\public\seed.json`, **only when no copy exists there yet**.
- First launch: the app's store (`src/lib/store.tsx`, see
  `installer/seed-import.patch`) loads `/seed.json` only when the
  browser has no saved data yet, then saves it to localStorage.
  After that the seed file is never read again.
