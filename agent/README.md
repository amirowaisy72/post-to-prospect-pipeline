# LeadHunter scraping agent

Local agent that scrapes Facebook groups/pages for the LeadHunter
frontend (`src/`, Data Sourcing page). It runs on **your PC**, in your
own Chrome, with your own logged-in Facebook session. The agent
**never asks for, handles, or stores any Facebook password**.

## Quick start — one double-click

Double-click **`start.bat`** in the **repo root**. It does everything,
no typing:

1. Starts the agent in a "LeadHunter Agent" window
   (http://127.0.0.1:8001).
2. Starts the app in a "LeadHunter App" window
   (http://localhost:8080).
3. Opens the app in your browser.

It also sets the Chrome profile for you (the already-signed-in
Client Hunting profile, so no Facebook sign-in is needed) and finds
`bun` / `python` by itself when they are not on PATH. **Close
Client Hunting first** — one Chrome profile can only be used by one
browser at a time. The agent's browser runs **headless** — no window
appears while it works. To stop everything, press Ctrl+C in the
agent window (the browser closes cleanly) and close the app window.

## Setup

1. Install **Python 3.14** from https://www.python.org/downloads/
   (tick "Add python to PATH" during install).
2. Double-click **`start.bat`** in the repo root (preferred), or
   **`run-agent.bat`** in this folder for the agent alone. Either
   installs the dependencies, installs Chromium for Playwright
   (first run only), then serves the agent at
   **http://127.0.0.1:8001**.
3. Keep that window open while LeadHunter is scraping.

Manual equivalent (same folder):

```bat
pip install -r requirements.txt
python -m playwright install chromium
python -m uvicorn main:app --host 127.0.0.1 --port 8001
```

## First-run Facebook sign-in

The agent's browser runs **headless** by default — no window
appears, the work is silent, exactly like Client Hunting. With the
already-signed-in Client Hunting profile (see below) no sign-in is
needed at all.

With the agent's own fresh profile (`agent/.chrome-profile/`), the
first Scrap or Sync needs a Facebook sign-in — and a headless
browser has no window to type in. So run the agent **once** with a
visible window:

```powershell
$env:LEADHUNTER_HEADED=1
.\run-agent.bat
```

Sign in to Facebook in the window that opens, once. The session is
saved in `agent/.chrome-profile/` and reused for every later job —
you do not sign in again unless Facebook logs you out. If a job
fails with "Facebook session is not signed in", sign in again the
same way (visible window, `LEADHUNTER_HEADED=1`) and run the job
again. The agent never asks for or stores your Facebook password.

Stopping the agent (Ctrl+C in its window) shuts the browser down
cleanly, so the next start never shows Chromium's "Restore pages?"
popup.

## Use an existing signed-in Chrome profile

The agent's own fresh profile sometimes cannot finish Facebook's
sign-in (the two-step verification page stays blank). Instead of
signing in again, point the agent at a profile that is **already
signed in** — the Client Hunting profile:

1. **Close Client Hunting first** — one Chrome profile can only be
   used by one browser at a time. If it is still running, the job
   fails with "Chrome profile is in use — close Client Hunting
   first, then run the job again."
2. Set the env var **before** starting the agent (in the same
   PowerShell window, or via Windows env settings):
   ```powershell
   $env:LEADHUNTER_CHROME_PROFILE = "G:\Web Apps\client-hunting\data\profiles\Master"
   ```
   That path is Client Hunting's profile for its `Master` account
   (`<client-hunting>\data\profiles\<account>`). Use your own
   account folder name if it differs.
3. Start the agent (`run-agent.bat`) — Add Source / Scrap / Sync
   now need **no sign-in at all**.
4. To go back to the agent's own profile, unset the var
   (`Remove-Item Env:LEADHUNTER_CHROME_PROFILE`) and restart the
   agent.

## How Scrap / Sync / Stop map to the frontend

| Frontend button | Agent endpoint | What happens |
|---|---|---|
| **Add Source** (Data Sourcing) | `POST /collect-sources` | Searches Facebook for groups/pages matching the **keyword** (the dialog's Name field), applies the **comments gate** (a source whose posts carry fewer than `minComments`, default 3, is dead — never saved, never counts toward the target) and the **member gate** (known member count below `minMembers`, default 100, is skipped; a count that cannot be read never blocks a run), **joins** the good groups (pages are recorded, not joined), and saves them as sources. The joined sources come back on the finished job's `result.sources`. One search pass per run — press Add Source again for more. |
| **Scrap** (per source) | `POST /scrape` | Collects **new posts only** from the source feed (already-known post URLs are skipped), then extracts each post fully — every comment and reply — and saves it to `leadhunter.db`. |
| **Sync** (per source / per post) | `POST /sync` | Re-opens each known post (all of a source, or one post) and **merges** new comments/replies into the stored post; nothing already saved is duplicated. Updates `lastSyncedAt`. |
| **Stop** | `POST /stop` | The current post is always finished and saved first; the job then ends with status `stopped` and the next post is never started. |
| **Delete** (per source) | `POST /sources/{id}/delete` | **Leaves** the group (or unfollows the page) on Facebook **first**, then removes the source — and its collected posts — from `leadhunter.db`. If the leave fails, the row is **not** removed and the response says so (try Delete again). Refuses with `409` while a job is running. |

One job runs at a time — starting a second returns `409`.

## Completeness — no comment or reply is missed

For every post the agent:

1. Reads the post's stated comment total (dialog stats, e.g.
   "229 comments", or the Comment button's aria-label).
2. Scrolls the post dialog until that many top-level comments have
   loaded, or until 5 consecutive scrolls bring nothing new and no
   "Loading..." placeholders remain.
3. Clicks **every** "View N replies" / "View more comments" /
   "View more answers" button until a full pass clicks 0 (replies
   that appear can contain further nested buttons; the cap is 200
   clicks per post), then scrolls again — repeating until a full
   scroll+expand pass adds nothing new.
4. Verifies the count: collected (top-level comments + all replies)
   against the stated total.

Each job carries a `verification` array — one entry per post touched:

```json
{"postUrl": "...", "expectedComments": 229, "collectedComments": 229,
 "missing": 0, "complete": true}
```

Job statuses: `running`, `stop-requested`, `done` (every touched post
verified complete), **`incomplete`** (finished, but at least one post
mismatched — the collected data is still imported and `message` says
plainly what is missing, e.g. "collected 8 of 10 — 2 missing"),
`stopped`, `failed`. When the stated total could not be read at all,
`expectedComments`/`missing` are `null` and `complete` is `true` —
no total is invented.

## Timestamps

Facebook shows a relative label ("5d", "19h") next to each comment,
but the **exact time is in the timestamp's title / description**
("Wednesday 11 November 2026 at 05:43"). The agent uses the exact
time first; only when it is missing does it fall back to the label
("5d" → collection time minus 5 days, "Yesterday" → minus 1 day,
"Just now" → now). The label fallback is **approximate by nature** —
a "5d" label covers that whole day — so the original label is always
kept in `postedAtLabel` next to the computed `postedAt`.

## Endpoints

- `GET /health` → `{"ok": true, "service": "leadhunter-agent",
  "version": "0.1.0", "facebook": "unknown"}`
- `POST /collect-sources` `{"keyword", "type": "group"|"page"|"both",
  "maxNew"?, "accountId"?, "minComments"?, "minMembers"?}` → `202 {"jobId"}`
  (`400` when `keyword` is missing/empty or `type` is invalid). The
  finished job's `result` is `{"sources": [{id, name, type, url,
  memberCount, joinedByAccountId}]}`.
- `POST /sources/{id}/delete` → `{"ok": true, "left": true, "detail": ...}`
  (`404` unknown source, `409` a job is running, `502` the leave failed
  and the row was kept)
- `POST /scrape` `{"sourceId", "sourceUrl", "sourceName"?, "accountId",
  "limit"?}` → `202 {"jobId"}` (`400` when `sourceUrl` is missing/invalid)
- `POST /sync` `{"sourceId"? | "postId"?, "sourceUrl"?, "postUrl"?,
  "accountId"}` — exactly one of `sourceId`/`postId` → `202 {"jobId"}`
  (`400` otherwise)
- `POST /stop` `{"jobId"}` → `{"jobId", "status": "stop-requested"}`
  (`404` unknown job)
- `GET /jobs` → `{"jobs": [...]}`
- `GET /jobs/{jobId}` → `{"job": {...}, "posts": [...]}` (`404` unknown job)

Job object: `{"id", "kind": "scrape"|"sync"|"collect", "sourceId", "postId",
"accountId", "status": "running"|"stop-requested"|"done"|"incomplete"|
"stopped"|"failed", "postsProcessed", "newPosts", "startedAt",
"finishedAt", "error", "verification": [...], "message", "result"}`.

Posts use the frontend `PostData` shape, plus timestamps:
`{"id", "sourceId", "accountId", "postUrl", "author": {"name", "url"},
"text", "comments": [{"author": {"name", "url"}, "text",
"postedAt", "postedAtLabel", "replies": [...]}], "collectedAt",
"lastSyncedAt"}`.

## Files

- `main.py` — FastAPI app (lazy headless Playwright launch, clean
  shutdown on stop, one job at a time)
- `facebook.py` — FacebookWorker (session check, feed collection,
  exhaustive dialog extraction; keyword search, comments gate,
  join/leave — ported from the tested client-hunting finder, see the
  "Ported from client-hunting" section at the top of the search code;
  no Playwright import at module top)
- `jobs.py` — scrape/sync/collect runners, comment merge, count
  verification, source delete (leave-then-remove)
- `db.py` — SQLite storage (`leadhunter.db`, stdlib only)
- `timestamps.py` — exact-description + label-fallback timestamp parsing
- `tests/test_agent.py` — pytest suite (fake page, no network/browser)

## Tests

```bat
python -m pytest tests/ -q
```
