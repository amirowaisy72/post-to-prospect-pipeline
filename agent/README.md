# LeadHunter scraping agent

Local agent that scrapes Facebook groups/pages for the LeadHunter
frontend (`src/`, Data Sourcing page). It runs on **your PC**, in your
own Chrome, with your own logged-in Facebook session. The agent
**never asks for, handles, or stores any Facebook password**.

## Setup

1. Install **Python 3.14** from https://www.python.org/downloads/
   (tick "Add python to PATH" during install).
2. Double-click **`run-agent.bat`** in this folder. It installs the
   dependencies, installs Chromium for Playwright (first run only),
   then serves the agent at **http://127.0.0.1:8001**.
3. Keep that window open while LeadHunter is scraping.

Manual equivalent (same folder):

```bat
pip install -r requirements.txt
python -m playwright install chromium
python -m uvicorn main:app --host 127.0.0.1 --port 8001
```

## First-run Facebook sign-in

The first time you start a Scrap or Sync, a Chrome window opens.
**Sign in to Facebook there once.** The session is saved in
`agent/.chrome-profile/` and reused for every later job — you do not
sign in again unless Facebook logs you out. If a job fails with
"Facebook session is not signed in", sign in again in that Chrome
window and run the job again.

## How Scrap / Sync / Stop map to the frontend

| Frontend button | Agent endpoint | What happens |
|---|---|---|
| **Scrap** (per source) | `POST /scrape` | Collects **new posts only** from the source feed (already-known post URLs are skipped), then extracts each post fully — every comment and reply — and saves it to `leadhunter.db`. |
| **Sync** (per source / per post) | `POST /sync` | Re-opens each known post (all of a source, or one post) and **merges** new comments/replies into the stored post; nothing already saved is duplicated. Updates `lastSyncedAt`. |
| **Stop** | `POST /stop` | The current post is always finished and saved first; the job then ends with status `stopped` and the next post is never started. |

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
- `POST /scrape` `{"sourceId", "sourceUrl", "sourceName"?, "accountId",
  "limit"?}` → `202 {"jobId"}` (`400` when `sourceUrl` is missing/invalid)
- `POST /sync` `{"sourceId"? | "postId"?, "sourceUrl"?, "postUrl"?,
  "accountId"}` — exactly one of `sourceId`/`postId` → `202 {"jobId"}`
  (`400` otherwise)
- `POST /stop` `{"jobId"}` → `{"jobId", "status": "stop-requested"}`
  (`404` unknown job)
- `GET /jobs` → `{"jobs": [...]}`
- `GET /jobs/{jobId}` → `{"job": {...}, "posts": [...]}` (`404` unknown job)

Job object: `{"id", "kind": "scrape"|"sync", "sourceId", "postId",
"accountId", "status": "running"|"stop-requested"|"done"|"incomplete"|
"stopped"|"failed", "postsProcessed", "newPosts", "startedAt",
"finishedAt", "error", "verification": [...], "message"}`.

Posts use the frontend `PostData` shape, plus timestamps:
`{"id", "sourceId", "accountId", "postUrl", "author": {"name", "url"},
"text", "comments": [{"author": {"name", "url"}, "text",
"postedAt", "postedAtLabel", "replies": [...]}], "collectedAt",
"lastSyncedAt"}`.

## Files

- `main.py` — FastAPI app (lazy Playwright launch, one job at a time)
- `facebook.py` — FacebookWorker (session check, feed collection,
  exhaustive dialog extraction; no Playwright import at module top)
- `jobs.py` — scrape/sync runners, comment merge, count verification
- `db.py` — SQLite storage (`leadhunter.db`, stdlib only)
- `timestamps.py` — exact-description + label-fallback timestamp parsing
- `tests/test_agent.py` — pytest suite (fake page, no network/browser)

## Tests

```bat
python -m pytest tests/ -q
```
