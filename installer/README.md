# LeadHunter — Windows installer (v1.0.0)

One `.exe` installs everything LeadHunter needs on a Windows PC.
No manual commands, no separate downloads, no admin rights.

## Install

1. Double-click `LeadHunter-Setup-1.0.0.exe`.
   - Windows SmartScreen says "Windows protected your PC" (the
     installer is unsigned) → **More info → Run anyway**.
2. Pick the install folder (default `C:\Users\<you>\AppData\Local\LeadHunter`)
   and let the setup run. It downloads and installs, in this order:
   Bun, Python 3.14, the agent's Python packages, Playwright Chromium,
   the frontend dependencies, **Ollama + both models**.
3. When it finishes, tick "Launch LeadHunter" — two windows open
   (the app and the chat agent) and the browser opens
   http://localhost:8080/.

## What it downloads (first install only)

| Thing | Size |
| --- | --- |
| Bun | ~37 MB |
| Python 3.14 | ~32 MB |
| Python packages (FastAPI, uvicorn, Playwright, httpx) | ~50 MB |
| Playwright Chromium | ~300 MB |
| Frontend dependencies (node_modules) | ~623 MB |
| Ollama | ~1.6 GB |
| Ollama model qwen2.5:1.5b | ~986 MB |
| Ollama model llama3.1:8b | ~4.9 GB |

Downloads run in parallel with several connections each, resume if
the connection drops, and are SHA-256 verified. Total first install
is roughly 8–9 GB of downloads — most of it is Ollama and the two
models. A second install on the same PC downloads almost nothing:
every component already present is skipped.

## First run (once)

1. **Configurations** (bottom left): pick the AI provider.
   - **Ollama** (recommended): both models are already installed —
     pick `qwen2.5:1.5b` (small, fast) or `llama3.1:8b` (bigger,
     better chat). No key needed.
   - **Gemini**: the owner's key already comes filled in from the
     seed data — it works as-is. Replace it with your own key in
     Configurations any time you want.
2. **Agent Control → "Sign in to Facebook"**: a Chrome window opens —
   **sign in yourself** with your own Facebook account. The installer
   never asks for your Facebook password and never stores it. After
   that the session stays saved and the agent runs headless.

## Your data travels with the installer

This installer was built with the owner's data already inside it.
On a **fresh install** the app opens with exactly that data:
accounts, sources, leads, chats, jobs and settings — the same as on
the owner's PC. Nothing is sent anywhere; the data is only on this PC.

## Updates

When a new `LeadHunter-Setup-<version>.exe` arrives, just run it.
It updates in place:

- Only files that actually changed are downloaded and replaced.
- Bun, Python, Chromium, Ollama and both models are skipped when
  already installed — no big re-downloads.
- Your data is **never wiped**: your Facebook session, your
  database and everything in the app stays exactly as it was.
- The app must be closed (both windows) while the update runs —
  the installer asks you to close it first.

## Daily use

- Start: double-click **Run-LeadHunter.bat** (or the desktop /
  Start Menu icon). Two windows open; the browser opens the app.
- Stop: close both windows (or Ctrl+C in each).
- The app is at http://localhost:8080/, the agent at
  http://127.0.0.1:8001 — both only on this PC, nothing is exposed
  to the internet.

## If something fails

- The installer shows the reason and writes a full trail to
  `installer\setup.log` inside the install folder. Run the installer
  again once the reason is fixed.
- **Ollama is mandatory.** If Ollama or either model cannot be
  installed, the setup stops on purpose — LeadHunter cannot run
  without it.
- **Never share your Facebook password** with anyone, and never
  paste it anywhere except Facebook's own sign-in page. The
  installer's seed includes the owner's Gemini key already filled
  in (the owner's explicit choice) — do not forward this installer
  to anyone the owner would not trust with that key.

## What is NOT shared with this installer

- The owner's Facebook session (the `agent/profiles/` folder) is
  never bundled — you sign in to Facebook yourself, once.
- Uninstalling leaves your database and Facebook session behind
  (with a note); delete them yourself only if you really want
  your data gone.
