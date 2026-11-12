# LeadHunter chat agent

Local agent that delivers Inbox chats to Facebook Messenger and
watches for replies, for the LeadHunter frontend (`src/`, Inbox
page). It runs on **your PC**, in its own Chrome, with your own
logged-in Facebook session. The agent **never asks for, handles, or
stores any Facebook password**.

**Chat only.** It never scrapes, collects, or joins anything — the
old scraping endpoints (`/collect-sources`, `/scrape`, `/sync`,
`/sources/{id}/delete`) stay registered in `main.py` but are dormant
and unused by the app; posts come from the browser extension.

**Browser — exactly like Client Hunting.** All Playwright calls run
on ONE dedicated browser thread owned by `browser.py`
(`BrowserManager`, single-worker executor); every endpoint, the
watcher loop and the job threads dispatch browser work to it and
never touch Playwright themselves. That is what fixed the live
"Cannot switch to a different thread" / "Sync API inside the
asyncio loop" errors. The agent also owns its own Chrome profile
under `agent/profiles/<account>` — one profile per account, never
another app's profile. The session check distinguishes "page did
not load" (`empty`) from "not signed in" (`logged_out`), so a
failure message never says "sign in" when the page simply did not
load.

## Quick start — one double-click

Double-click **`start.bat`** in the repo root. It opens two windows:

- **LeadHunter App** — the app (`bun run dev`, http://localhost:8080/)
- **LeadHunter Agent** — the chat agent (`run-agent.bat`,
  http://127.0.0.1:8001)

No env var, no typing. Keep both windows open while LeadHunter is
running; close them (or Ctrl+C in each) to stop. If `start.bat`
says Bun was not found, install it once in PowerShell
(`irm bun.sh/install.ps1 | iex`) and double-click again.

Manual start (if you prefer two windows by hand):

**Window 1 — agent.** In PowerShell, in the `agent/` folder:

```powershell
.\run-agent.bat
```

The agent runs **headless** — no window appears while it works. To stop, press Ctrl+C in the agent window (the browser closes cleanly) and close the app window.

**Window 2 — app.** In PowerShell, in the repo root:

```powershell
& "$env:USERPROFILE\.bun\bin\bun.exe" run dev
```

Then open http://localhost:8080/ → Inbox.

## First-run Facebook sign-in (once only)

The agent's own profile starts empty — it is not signed in to
Facebook yet. Sign in **once**, yourself, in a visible window:

1. Start the agent (`run-agent.bat`) and the app as above.
2. In LeadHunter, open **Agent Control** and press **"Sign in to
   Facebook"**. A Chrome window opens at the Facebook login page.
3. Sign in yourself in that window. The agent never asks for or
   stores your password — type it only in Facebook's own page.
4. Leave the window open, go back to Agent Control and press
   **"Relaunch browser"** — the agent goes back to silent headless
   with your session saved in `agent/profiles/<account>`.

After that you never sign in again unless Facebook logs you out —
then repeat the same four steps. If a chat fails with "Facebook
session is not signed in", that is the `logged_out` state: sign in
again the same way. If it fails with "Facebook page did not load",
the browser is fine but the page did not load — press **"Relaunch
browser"** instead; do not sign in again.

Stopping the agent (Ctrl+C in its window) shuts the browser down
cleanly, so the next start never shows Chromium's "Restore pages?"
popup.

## How it works

| Frontend action | Agent endpoint | What happens |
|---|---|---|
| **Start chat** (Inbox, New chat) | `POST /chat/start` | Opens the candidate's Messenger thread in the logged-in profile and sends the first message (typed letter by letter, split into at most 2 short messages). A first message to a stranger lands in **Message Requests** — the reply says so honestly (`messageRequests: true`). |
| **Inbox open** (polls every 10 s) | `GET /chat/threads` + `POST /chat/watch` | The app (re)starts the watcher with the active threads, the script and the Gemini key, then polls live thread states (messages, who replied last, sent/delivered/replied status). |
| **Watcher** (every ~90 s) | — | Reads Messenger inbox (+ Message Requests for approved threads not yet in the inbox). On a new reply from an **approved candidate only**, drafts a reply with Gemini (script + full chat history) and sends it. Never sends in any other thread. |
| **Stop all chatting** (Inbox) | `POST /chat/stop` | Stops the watcher and any in-flight send **immediately**; the Gemini key and watch config are forgotten. |
| **Agent Control** | `GET /agent/status`, `POST /agent/session-check`, `POST /agent/browser-relaunch`, `POST /agent/reload`, `POST /agent/signin`, `POST /agent/unwatch`, `GET /agent/logs` | Status, session re-check, browser relaunch/reload, first-run sign-in window, stop watching, recent log lines. |

Every message the agent sends is saved in `leadhunter.db`
(`chat_threads` / `chat_messages`) and shown in the app with its
delivery — `sent`, `failed`, `pending-messenger` (sending),
`received` (candidate reply).

## Safety

- **Approved threads only.** The watcher matches threads by exact
  thread URL from its own DB — a thread the app never started is
  never answered, even if it has unread messages.
- **Daily cap.** Enforced per account from the Facebook account's
  age (Configurations → Agent URL section is only the URL; the cap
  comes from the account's Facebook created date on the Accounts
  page): under 3 days 0, days 3–7: 12/day, days 8–14: 25/day, day
  15+: 45/day. The cap is checked before every send.
- **Stop switch.** `POST /chat/stop` halts the watcher mid-loop and
  cancels in-flight sends; the Inbox has a "Stop all chatting"
  button.
- **Gemini key.** The app sends it per request over localhost only.
  The agent holds it **in memory only** — it is never written to
  disk or to any log. Stopping forgets it.
- **Human pacing.** First and reply messages are typed letter by
  letter (35–80 ms per keystroke), at most 2 short messages at a
  time, and a send counts only if the message is still present
  after a reload.
- **Honest limits.** There is no official Messenger API for personal
  profiles — this is browser automation, so Facebook layout changes
  or a session loss can break it, and sending too fast risks a
  restriction. The agent runs only while your PC and its window are
  up.

## Endpoints

- `GET /health` → `{"ok": true, "service": "leadhunter-agent",
  "version": "0.1.0", "facebook": "unknown", "chat": {"watching": false, "threads": 0}}`
- `POST /chat/start` `{"accountId", "threadId", "messageId",
  "profileUrl", "profileName", "sourceType": "comment"|"post",
  "sourceText", "firstMessage", "dailyCap"}` → `202 {"threadId",
  "status": "sent"|"failed", "messageRequests": true|false}`
  (`400` bad input, `409` a job is running or another start is in
  flight, `503` the agent is not signed in to Facebook)
- `POST /chat/watch` `{"accountId", "threads": [{"threadId",
  "profileUrl", "profileName", "sourceType", "sourceText"}],
  "script", "geminiKey", "model"?, "dailyCap"}` → `{"watching": true,
  "threads": N}` (`400` without `geminiKey`/`accountId` or with no
  threads). Replaces the whole watch list: threads dropped from the
  list are marked done.
- `GET /chat/threads` → `{"threads": [{"threadId", "accountId",
  "profileUrl", "profileName", "status", "messengerThreadUrl",
  "lastError", "messages": [{"id", "role": "agent"|"candidate",
  "text", "delivery": "sent"|"failed"|"pending-messenger"|"received"|
  "in-app", "sentAt"}]}], "watching": true|false}`
- `POST /chat/stop` → `{"watching": false}` — stops all chatting
  immediately and forgets the Gemini key and watch config.
- `POST /agent/signin` `{"accountId"}` → `{"ok": true,
  "accountId", "profile", "detail"}` — opens the visible sign-in
  window for the account (see "First-run Facebook sign-in").
- `GET /agent/status` `?accountId=` → `{"online", "profile",
  "profileExists", "headed", "browser", "watching",
  "watchedThreads", "chatStartBusy", "lastSessionCheck",
  "sendsToday", "sendsTodayDate"}` — never launches a browser.
- `POST /agent/session-check` `{"accountId"}` → `{"state", "at",
  "detail"}` — re-checks the session on the Messenger page.
- `POST /agent/browser-relaunch` `{"accountId"}` → `{"relaunched",
  "browser", "profile", "headed"}` — restarts the browser only.
- `POST /agent/reload` `{"accountId"}` → `{"reloaded", "state",
  "at", "detail"}` — reloads the Messenger page, re-checks.
- `POST /agent/unwatch` → `{"watching": false}` — stops watching
  only. `GET /agent/logs` → `{"lines": [...]}` — last ~50 lines.

## Files

- `main.py` — FastAPI app (one job at a time; chat endpoints +
  watcher loop; Agent Control endpoints; the old scraping
  endpoints are dormant). Every browser call dispatches to
  `browser.BROWSER` — nothing here touches Playwright directly.
- `browser.py` — BrowserManager: ONE dedicated browser thread
  (single-worker executor) owns all sync Playwright calls; one
  persistent Chromium context per account under
  `agent/profiles/<account>`; `open_for_signin` for the first-run
  visible window. Ported from Client Hunting's `app/auth.py`.
- `facebook.py` — FacebookWorker (session check, Messenger:
  `open_chat_with_profile`, `read_messenger_threads`,
  `read_thread_messages`, `send_thread_message` — ported from the
  tested client-hunting Messenger code)
- `chat.py` — chat logic (Gemini drafting, daily cap bands,
  `watch_once`, `start_chat`; the Gemini key lives in memory only)
- `jobs.py` — dormant scrape/sync/collect runners (unused by the app)
- `db.py` — SQLite storage (`leadhunter.db`, stdlib only;
  `chat_threads` / `chat_messages` tables)
- `timestamps.py` — exact-description + label-fallback timestamp
  parsing (scraping, dormant)
- `tests/test_agent.py` — pytest suite (fake page, no network/browser)
- `tests/test_chat.py` — chat pytest suite (fake chat page; covers
  thread matching, cap enforcement, stop, key never on disk)
- `tests/test_browser.py` — browser-thread pytest suite (single
  thread dispatch, profile dir, sign-in window, no other app's
  profile anywhere in agent code)

## Tests

```bat
python -m pytest tests/ -q
```
