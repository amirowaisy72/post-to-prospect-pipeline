# LeadHunter chat agent

Local agent that delivers Inbox chats to Facebook Messenger and
watches for replies, for the LeadHunter frontend (`src/`, Inbox
page). It runs on **your PC**, in your own Chrome, with your own
logged-in Facebook session. The agent **never asks for, handles, or
stores any Facebook password**.

**Chat only.** It never scrapes, collects, or joins anything — the
old scraping endpoints (`/collect-sources`, `/scrape`, `/sync`,
`/sources/{id}/delete`) stay registered in `main.py` but are dormant
and unused by the app; posts come from the browser extension.

## Quick start — two windows

**Window 1 — agent.** In PowerShell, in the `agent/` folder:

```powershell
$env:LEADHUNTER_CHROME_PROFILE = "G:\Web Apps\client-hunting\data\profiles\Master"
.\run-agent.bat
```

That path is Client Hunting's profile for its `Master` account
(`<client-hunting>\data\profiles\<account>`) — already signed in to
Facebook, so no sign-in is needed. Use your own account folder name
if it differs. The var must be set in the **same** window before
`run-agent.bat` — without it the agent uses its own fresh profile
(`agent/.chrome-profile/`), which is not signed in.

**Window 2 — app.** In PowerShell, in the repo root:

```powershell
& "$env:USERPROFILE\.bun\bin\bun.exe" run dev
```

Then open http://localhost:8080/ → Inbox. **Close Client Hunting
first** — one Chrome profile can only be used by one browser at a
time. The agent's browser runs **headless** — no window appears
while it works. To stop, press Ctrl+C in the agent window (the
browser closes cleanly) and close the app window.

## How it works

| Frontend action | Agent endpoint | What happens |
|---|---|---|
| **Start chat** (Inbox, New chat) | `POST /chat/start` | Opens the candidate's Messenger thread in the logged-in profile and sends the first message (typed letter by letter, split into at most 2 short messages). A first message to a stranger lands in **Message Requests** — the reply says so honestly (`messageRequests: true`). |
| **Inbox open** (polls every 10 s) | `GET /chat/threads` + `POST /chat/watch` | The app (re)starts the watcher with the active threads, the script and the Gemini key, then polls live thread states (messages, who replied last, sent/delivered/replied status). |
| **Watcher** (every ~90 s) | — | Reads Messenger inbox (+ Message Requests for approved threads not yet in the inbox). On a new reply from an **approved candidate only**, drafts a reply with Gemini (script + full chat history) and sends it. Never sends in any other thread. |
| **Stop all chatting** (Inbox) | `POST /chat/stop` | Stops the watcher and any in-flight send **immediately**; the Gemini key and watch config are forgotten. |

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

## First-run Facebook sign-in

With the already-signed-in Client Hunting profile (see above) no
sign-in is needed at all.

With the agent's own fresh profile (`agent/.chrome-profile/`), the
first chat needs a Facebook sign-in — and a headless browser has no
window to type in. So run the agent **once** with a visible window:

```powershell
$env:LEADHUNTER_HEADED=1
.\run-agent.bat
```

Sign in to Facebook in the window that opens, once. The session is
saved in `agent/.chrome-profile/` and reused for every later run —
you do not sign in again unless Facebook logs you out. If a chat
fails with "Facebook session is not signed in", sign in again the
same way (visible window, `LEADHUNTER_HEADED=1`) and try again. The
agent never asks for or stores your Facebook password.

Stopping the agent (Ctrl+C in its window) shuts the browser down
cleanly, so the next start never shows Chromium's "Restore pages?"
popup.

## Use an existing signed-in Chrome profile

The agent's own fresh profile sometimes cannot finish Facebook's
sign-in (the two-step verification page stays blank). Instead of
signing in again, point the agent at a profile that is **already
signed in** — the Client Hunting profile:

1. **Close Client Hunting first** — one Chrome profile can only be
   used by one browser at a time. If it is still running, the chat
   fails with "Chrome profile is in use — close Client Hunting
   first, then run the job again."
2. Set the env var **before** starting the agent (in the same
   PowerShell window, or via Windows env settings):
   ```powershell
   $env:LEADHUNTER_CHROME_PROFILE = "G:\Web Apps\client-hunting\data\profiles\Master"
   ```
3. Start the agent (`run-agent.bat`) — chats now need **no sign-in
   at all**.
4. To go back to the agent's own profile, unset the var
   (`Remove-Item Env:LEADHUNTER_CHROME_PROFILE`) and restart the
   agent.

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

## Files

- `main.py` — FastAPI app (lazy headless Playwright launch, clean
  shutdown on stop, one job at a time; chat endpoints + watcher
  loop; the old scraping endpoints are dormant)
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

## Tests

```bat
python -m pytest tests/ -q
```
