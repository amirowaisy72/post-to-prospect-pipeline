"""LeadHunter agent — FastAPI app.

Local-only tool: bind to 127.0.0.1 (see run-agent.bat). The frontend
calls it from the user's PC, where the agent drives the user's own
logged-in Chrome/Facebook session via a persistent Playwright
profile the agent OWNS (``agent/profiles/<account>`` — see
``browser.py``). The browser runs headless by default — no window
appears, the work is silent, exactly like Client Hunting. First
run: open Agent Control → "Sign in to Facebook" and sign in
yourself once in the visible window; the session stays saved in
the profile afterwards and the agent never asks for or stores a
password. No other app's Chrome profile is ever used.

Browser threading (the fix for the live "Cannot switch to a
different thread" / "Sync API inside the asyncio loop" errors):
ALL Playwright calls run on ONE dedicated browser thread owned by
``browser.BROWSER``. FastAPI endpoints, the watcher loop and job
threads only ever dispatch work to it via ``run_with_page`` — no
sync Playwright call is made from the asyncio loop or any other
thread, ever.

Two jobs live here now: the old scraping endpoints (dormant — the
app no longer calls them) and the Inbox live-chat agent
(``/chat/*``): it opens Messenger chats for approved candidates,
sends the first message per the script, and watches Messenger for
their replies, drafting each reply with Gemini. See ``chat.py`` for
the safety rails (approval gate, daily cap, stop).

One running job at a time globally — a second start returns 409.
The browser is launched lazily on the first job (Playwright is
imported INSIDE the browser manager, never at module top) and the
same page is reused across jobs.
"""

from __future__ import annotations

import asyncio
import os
import threading
import time
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import chat
import db
import jobs
from browser import BROWSER, profile_dir
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from facebook import FacebookWorker

__all__ = ["app"]

VERSION = "0.1.0"
_AGENT_DIR = Path(__file__).resolve().parent

db.init_db(_AGENT_DIR / "leadhunter.db")


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    """Close the browser cleanly when the agent stops.

    Uvicorn runs this on SIGINT/SIGTERM (Ctrl+C in run-agent.bat)
    and on normal shutdown: the browser manager closes every
    context and stops Playwright, so the next launch never shows
    Chromium's "Restore pages?" popup and no zombie Chromium holds
    the profile.
    """
    yield
    BROWSER.shutdown()


app = FastAPI(title="leadhunter-agent", version=VERSION, lifespan=_lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # local-only tool on 127.0.0.1
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

_lock = threading.Lock()
_running_job_id: str | None = None
_stop_flags: dict[str, bool] = {}
_page = None
_context = None
_playwright = None

# Agent Control page state (see the /agent/* endpoints below).
# _LOG_LINES is a small in-memory ring of the most recent agent log
# lines (last 50) — the console window is still the full log.
_LOG_LINES: deque[str] = deque(maxlen=50)
_LOG_LOCK = threading.Lock()
# Last session check run from the Agent Control page (or the reload
# button): {"state", "at", "detail"} — empty until the first check.
_LAST_SESSION_CHECK: dict = {}
_MESSAGES_URL = "https://www.facebook.com/messages"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def agent_log(message: str) -> None:
    """One agent log line: kept in the ring for GET /agent/logs and
    printed to the console window (same "[leadhunter] ..." format
    as the plain prints elsewhere)."""
    line = f"{_now_iso()} {message}"
    with _LOG_LOCK:
        _LOG_LINES.append(line)
    print(f"[leadhunter] {message}", flush=True)


# ----------------------------------------------------------------------
# Browser — owned by browser.BROWSER (see browser.py)
# ----------------------------------------------------------------------
# ALL Playwright calls run on ONE dedicated browser thread owned by
# BROWSER (the Client Hunting pattern). Nothing in this file ever
# touches Playwright directly: job threads, the watcher loop and the
# endpoints dispatch work through BROWSER.run_with_page, and async
# endpoints use asyncio.to_thread so the asyncio loop never runs a
# sync Playwright call itself. That is the fix for the live
# "Cannot switch to a different thread" (greenlet) and "Sync API
# inside the asyncio loop" errors.
FACEBOOK_LOGIN_URL = "https://www.facebook.com/login"


def _browser_account(account_id: str = "") -> str:
    """Account key for the agent's own browser profile: the explicit
    id, else the watching account, else "default". One profile per
    account, under agent/profiles/ — never another app's profile."""
    account_id = (account_id or "").strip()
    if account_id:
        return account_id
    watching = chat.watch_account_id()
    return watching or "default"


def _job_view(row: dict) -> dict:
    return {
        "id": row["id"],
        "kind": row["kind"],
        "sourceId": row.get("source_id"),
        "postId": row.get("post_id"),
        "accountId": row.get("account_id") or "",
        "status": row["status"],
        "postsProcessed": row.get("posts_processed") or 0,
        "newPosts": row.get("new_posts") or 0,
        "startedAt": row.get("started_at"),
        "finishedAt": row.get("finished_at"),
        "error": row.get("error"),
        # Per-post count verification (see jobs.py): one entry per
        # post the job touched. "incomplete" means a finished job
        # with at least one mismatched post — the data is still
        # imported, and `message` says plainly what is missing.
        "verification": row.get("verification") or [],
        "message": row.get("message"),
        # Collect jobs store their joined sources here:
        # {"sources": [{id, name, type, url, memberCount,
        #               joinedByAccountId}]}.
        "result": row.get("result"),
    }


def _person_view(name, url):
    return {"name": name or "", "url": url or ""}


def _post_view(post: dict) -> dict:
    """Stored post -> exact frontend PostData shape (plus timestamps)."""
    comments = []
    for c in post.get("comments") or []:
        replies = [
            {
                "author": _person_view(r.get("author_name"), r.get("author_url")),
                "text": r.get("text") or "",
                "postedAt": r.get("posted_at"),
                "postedAtLabel": r.get("posted_at_label") or "",
            }
            for r in (c.get("replies") or [])
        ]
        comments.append({
            "author": _person_view(c.get("author_name"), c.get("author_url")),
            "text": c.get("text") or "",
            "postedAt": c.get("posted_at"),
            "postedAtLabel": c.get("posted_at_label") or "",
            "replies": replies,
        })
    return {
        "id": post["id"],
        "sourceId": post.get("source_id"),
        "accountId": post.get("account_id") or "",
        "postUrl": post.get("post_url") or "",
        "author": _person_view(post.get("author_name"), post.get("author_url")),
        "text": post.get("text") or "",
        "comments": comments,
        "collectedAt": post.get("collected_at"),
        "lastSyncedAt": post.get("last_synced_at"),
    }


def _run_job_thread(job_id, kind, payload):
    """Background thread for one job; clears the running slot at the end.

    The whole job runs on the browser thread (BROWSER.run_with_page,
    fresh tab) — this thread never touches Playwright itself.
    """
    global _running_job_id
    try:
        job = db.get_job(job_id) or {}
        account_id = _browser_account(job.get("account_id") or "")

        def _run(page):
            worker = FacebookWorker()
            job_row = db.get_job(job_id) or {}
            job_row.update(payload)
            should_stop = lambda: _stop_flags.get(job_id, False)  # noqa: E731
            note = agent_log
            if kind == "scrape":
                jobs.run_scrape(worker, page, db, job_row, should_stop,
                                note=note)
            elif kind == "collect":
                jobs.run_collect_sources(worker, page, db, job_row,
                                         should_stop, note=note)
            else:
                jobs.run_sync(worker, page, db, job_row, should_stop,
                              note=note)

        BROWSER.run_with_page(account_id, False, _run, fresh=True)
    except Exception as exc:  # noqa: BLE001 - job failure, not a crash
        try:
            from datetime import datetime, timezone

            db.update_job(job_id, status="failed",
                          finished_at=datetime.now(timezone.utc).isoformat(),
                          error=str(exc))
        except Exception:
            pass
    finally:
        with _lock:
            if _running_job_id == job_id:
                _running_job_id = None


def _start_job(kind, payload, job_row):
    """Create the job row and start its thread. Returns (job_id, 409?)
    — (None, True) when another job is already running."""
    global _running_job_id
    from datetime import datetime, timezone

    with _lock:
        if _running_job_id is not None:
            return None, True
        job_id = db.create_job(
            kind,
            source_id=job_row.get("source_id"),
            post_id=job_row.get("post_id"),
            account_id=job_row.get("account_id") or "",
            started_at=datetime.now(timezone.utc).isoformat(),
        )
        _running_job_id = job_id
        _stop_flags[job_id] = False
    thread = threading.Thread(
        target=_run_job_thread, args=(job_id, kind, payload), daemon=True)
    thread.start()
    return job_id, False


def _valid_facebook_url(url) -> bool:
    if not isinstance(url, str) or not url.strip():
        return False
    try:
        parsed = urlparse(url.strip())
    except Exception:
        return False
    return parsed.scheme in ("http", "https") and "facebook.com" in parsed.netloc.lower()


# ----------------------------------------------------------------------
# Inbox live chat (see chat.py for the rails)
# ----------------------------------------------------------------------
_chat_start_busy = False
_chat_start_thread_id = ""
_watch_thread = None


def _chat_watch_loop():
    """Background loop: one watch pass every WATCH_POLL_SECONDS
    while watching. Each pass runs on the browser thread
    (BROWSER.run_with_page) — the loop thread never touches
    Playwright itself; the single-worker executor serialises passes
    against chat starts. A dead browser is relaunched by the
    browser manager. The loop exits when watching stops —
    chat.request_stop() clears the watch and sets the flag, so one
    stop ends everything."""
    while True:
        if not chat.is_watching() or chat.stop_requested():
            return
        try:
            account = _browser_account(chat.watch_account_id())

            def _pass(page):
                worker = FacebookWorker()
                chat.watch_once(worker, page, note=agent_log)

            BROWSER.run_with_page(account, False, _pass)
        except Exception as exc:  # noqa: BLE001 - pass failed, loop retries
            agent_log(f"chat watch pass failed: {exc}")
        for _ in range(chat.WATCH_POLL_SECONDS):
            if not chat.is_watching() or chat.stop_requested():
                return
            time.sleep(1)


def _ensure_watch_thread():
    global _watch_thread
    if _watch_thread is not None and _watch_thread.is_alive():
        return
    _watch_thread = threading.Thread(target=_chat_watch_loop, daemon=True)
    _watch_thread.start()


def _run_chat_start(payload):
    """Background thread for one chat start; clears the busy flag.

    Records the send's stage trail (chat.set_send_stage) so the app
    can show where a send sits instead of one frozen "Sending…":
    "queued" while it waits for the browser thread, "opening browser"
    while the page is (re)launched, then chat.start_chat takes over
    — all on the browser thread.
    """
    global _chat_start_busy, _chat_start_thread_id
    message_id = payload.get("messageId") or ""
    chat.set_send_stage(message_id, "queued")
    try:
        chat.set_send_stage(message_id, "opening browser")
        account = _browser_account(payload.get("accountId") or "")

        def _start(page):
            worker = FacebookWorker()
            chat.start_chat(worker, page, payload, note=agent_log)

        BROWSER.run_with_page(account, False, _start, fresh=True)
    except Exception as exc:  # noqa: BLE001 - start failure, not a crash
        chat.set_send_stage(message_id, "failed", str(exc))
        try:
            db.set_chat_thread(payload.get("threadId"), status="failed",
                               last_error=str(exc))
        except Exception:
            pass
    finally:
        _chat_start_busy = False
        _chat_start_thread_id = ""


# ----------------------------------------------------------------------
# Endpoints
# ----------------------------------------------------------------------
@app.get("/health")
def health():
    return {"ok": True, "service": "leadhunter-agent",
            "version": VERSION, "facebook": "unknown",
            "chat": {"watching": chat.is_watching(),
                     "threads": len(db.list_chat_threads())}}


@app.post("/scrape")
async def scrape(request: Request):
    body = await request.json() if request.headers.get("content-length") else {}
    if not isinstance(body, dict):
        body = {}
    source_url = body.get("sourceUrl")
    if not _valid_facebook_url(source_url):
        return JSONResponse(
            status_code=400,
            content={"detail": "sourceUrl is missing or not a valid Facebook URL"})
    job_id, busy = _start_job(
        "scrape",
        {
            "source_url": source_url,
            "source_name": body.get("sourceName"),
            "source_type": body.get("sourceType"),
            "limit": body.get("limit"),
        },
        {
            "source_id": body.get("sourceId"),
            "account_id": body.get("accountId"),
        },
    )
    if busy:
        return JSONResponse(
            status_code=409,
            content={"detail": "another job is already running"})
    return JSONResponse(status_code=202, content={"jobId": job_id})


@app.post("/collect-sources")
async def collect_sources(request: Request):
    """Keyword search + collect (same rules as client-hunting).

    Body: {keyword, type ("group" | "page" | "both"), maxNew,
    accountId, minComments, minMembers}. Searches Facebook for
    matching groups/pages, applies the comments gate (default 3)
    and the member gate (default 100), joins the good groups and
    returns them on the finished job's ``result.sources``. One job
    at a time — 409 while another job runs. No URL input anywhere:
    the keyword is the search, exactly like the Add Source dialog.
    """
    body = await request.json() if request.headers.get("content-length") else {}
    if not isinstance(body, dict):
        body = {}
    keyword = (body.get("keyword") or "").strip()
    if not keyword:
        return JSONResponse(
            status_code=400,
            content={"detail": "keyword is required"})
    type_ = (body.get("type") or "group").strip().lower()
    if type_ not in ("group", "page", "both"):
        return JSONResponse(
            status_code=400,
            content={"detail": "type must be group, page or both"})
    try:
        max_new = int(body.get("maxNew") or 10)
    except (TypeError, ValueError):
        max_new = 10
    max_new = max(1, min(max_new, 50))
    try:
        min_comments = int(body.get("minComments") or 3)
    except (TypeError, ValueError):
        min_comments = 3
    try:
        min_members = int(body.get("minMembers") or 100)
    except (TypeError, ValueError):
        min_members = 100
    job_id, busy = _start_job(
        "collect",
        {
            "keyword": keyword,
            "type": type_,
            "max_new": max_new,
            "min_comments": min_comments,
            "min_members": min_members,
        },
        {
            "account_id": body.get("accountId"),
        },
    )
    if busy:
        return JSONResponse(
            status_code=409,
            content={"detail": "another job is already running"})
    return JSONResponse(status_code=202, content={"jobId": job_id})


@app.post("/sources/{source_id}/delete")
async def delete_source_endpoint(source_id: str):
    """Leave the group / unfollow the page on Facebook, then remove
    the source (and its posts) from the agent DB. The row is removed
    ONLY when the Facebook action succeeded — on failure the row
    stays and the response says so (same rule as client-hunting).
    Synchronous; refuses with 409 while a job is running, since the
    job owns the browser page.
    """
    source = db.get_source_by_id(source_id)
    if source is None:
        return JSONResponse(status_code=404, content={"detail": "unknown source"})
    with _lock:
        if _running_job_id is not None:
            return JSONResponse(
                status_code=409,
                content={"detail": "another job is already running"})
    try:
        account = _browser_account(source.get("account_id") or "")

        def _delete(page):
            worker = FacebookWorker()
            return jobs.delete_source(worker, page, db, source_id)

        # Async endpoint: the browser work runs off the event loop
        # (asyncio.to_thread) on the single browser thread.
        result = await asyncio.to_thread(
            BROWSER.run_with_page, account, False, _delete)
    except Exception as exc:  # noqa: BLE001 - report, do not crash
        return JSONResponse(status_code=500, content={"detail": str(exc)})
    if not result.get("ok"):
        return JSONResponse(status_code=502, content=result)
    return result


@app.post("/sync")
async def sync(request: Request):
    body = await request.json() if request.headers.get("content-length") else {}
    if not isinstance(body, dict):
        body = {}
    has_source = bool(body.get("sourceId"))
    has_post = bool(body.get("postId"))
    if has_source == has_post:  # exactly one of sourceId/postId is required
        return JSONResponse(
            status_code=400,
            content={"detail": "exactly one of sourceId or postId is required"})
    job_id, busy = _start_job(
        "sync",
        {
            "source_url": body.get("sourceUrl"),
            "post_url": body.get("postUrl"),
        },
        {
            "source_id": body.get("sourceId"),
            "post_id": body.get("postId"),
            "account_id": body.get("accountId"),
        },
    )
    if busy:
        return JSONResponse(
            status_code=409,
            content={"detail": "another job is already running"})
    return JSONResponse(status_code=202, content={"jobId": job_id})


@app.post("/stop")
async def stop(request: Request):
    body = await request.json() if request.headers.get("content-length") else {}
    if not isinstance(body, dict):
        body = {}
    job_id = body.get("jobId")
    row = db.get_job(job_id) if job_id else None
    if row is None:
        return JSONResponse(status_code=404, content={"detail": "unknown job"})
    _stop_flags[job_id] = True
    if row.get("status") == "running":
        db.update_job(job_id, status="stop-requested")
    return {"jobId": job_id, "status": "stop-requested"}


@app.get("/jobs")
def list_jobs_endpoint():
    return {"jobs": [_job_view(row) for row in db.list_jobs()]}


@app.get("/jobs/{job_id}")
def get_job_endpoint(job_id: str):
    row = db.get_job(job_id)
    if row is None:
        return JSONResponse(status_code=404, content={"detail": "unknown job"})
    if row.get("post_id"):
        post = db.get_post_by_id(row["post_id"])
        posts = [_post_view(post)] if post else []
    elif row.get("source_id"):
        posts = [_post_view(p) for p in db.get_posts_for_source(row["source_id"])]
    else:
        posts = []
    return {"job": _job_view(row), "posts": posts}


# ----------------------------------------------------------------------
# Inbox live chat
# ----------------------------------------------------------------------
@app.post("/chat/start")
async def chat_start_endpoint(request: Request):
    """Send the first message to a newly approved candidate.

    Body: {accountId, threadId, messageId, profileUrl, profileName,
    sourceType, sourceText, firstMessage, dailyCap}. Runs in the
    background (browser work takes ~10-30s); poll GET /chat/threads
    for the delivery result on the app's messageId. 409 while a
    scraping job runs (it owns the page) or another chat start is
    in flight. The daily cap is enforced in chat.start_chat.
    """
    global _chat_start_busy, _chat_start_thread_id
    body = await request.json() if request.headers.get("content-length") else {}
    if not isinstance(body, dict):
        body = {}
    thread_id = (body.get("threadId") or "").strip()
    first_message = (body.get("firstMessage") or "").strip()
    profile_url = (body.get("profileUrl") or "").strip()
    if not thread_id or not first_message or not profile_url:
        return JSONResponse(
            status_code=400,
            content={"detail": "threadId, profileUrl and firstMessage are required"})
    if not _valid_facebook_url(profile_url):
        return JSONResponse(
            status_code=400,
            content={"detail": "profileUrl is not a valid Facebook URL"})
    with _lock:
        if _running_job_id is not None:
            return JSONResponse(
                status_code=409,
                content={"detail": "another job is already running"})
        if _chat_start_busy:
            return JSONResponse(
                status_code=409,
                content={"detail": "a chat start is already running"})
        _chat_start_busy = True
        _chat_start_thread_id = thread_id
    try:
        daily_cap = int(body.get("dailyCap") or 0)
    except (TypeError, ValueError):
        daily_cap = 0
    payload = {
        "accountId": body.get("accountId") or "",
        "threadId": thread_id,
        "messageId": body.get("messageId") or "",
        "profileUrl": profile_url,
        "profileName": body.get("profileName") or "",
        "sourceType": body.get("sourceType") or "comment",
        "sourceText": body.get("sourceText") or "",
        "firstMessage": first_message,
        "dailyCap": daily_cap,
    }
    thread = threading.Thread(target=_run_chat_start, args=(payload,),
                              daemon=True)
    thread.start()
    return JSONResponse(status_code=202,
                        content={"threadId": thread_id, "status": "starting"})


@app.post("/chat/watch")
async def chat_watch_endpoint(request: Request):
    """Start (or replace) the Messenger watcher.

    Body: {accountId, threads: [{threadId, profileUrl, profileName,
    sourceType, sourceText}], script, geminiKey, model, dailyCap}.
    The watch list IS the approval gate: only these threads are ever
    opened or replied to. The Gemini key is held in memory only and
    cleared on stop; it is never written to disk or logged. 400 when
    the key is missing — without it the watcher cannot draft replies.
    """
    body = await request.json() if request.headers.get("content-length") else {}
    if not isinstance(body, dict):
        body = {}
    account_id = (body.get("accountId") or "").strip()
    if not account_id:
        return JSONResponse(
            status_code=400, content={"detail": "accountId is required"})
    threads = body.get("threads") or []
    if not isinstance(threads, list):
        return JSONResponse(
            status_code=400, content={"detail": "threads must be a list"})
    gemini_key = (body.get("geminiKey") or "").strip()
    if not gemini_key:
        return JSONResponse(
            status_code=400,
            content={"detail": "geminiKey is required to draft replies"})
    script = body.get("script") or {}
    if not isinstance(script, dict):
        return JSONResponse(
            status_code=400, content={"detail": "script must be an object"})
    try:
        daily_cap = int(body.get("dailyCap") or 0)
    except (TypeError, ValueError):
        daily_cap = 0
    clean_threads = []
    for t in threads:
        if not isinstance(t, dict) or not (t.get("threadId") or "").strip():
            continue
        clean_threads.append({
            "threadId": t["threadId"].strip(),
            "profileUrl": (t.get("profileUrl") or "").strip(),
            "profileName": (t.get("profileName") or "").strip(),
            "sourceType": (t.get("sourceType") or "comment").strip(),
            "sourceText": (t.get("sourceText") or "").strip(),
        })
    # Rows for new threads (never reset an existing row's status).
    for t in clean_threads:
        if db.get_chat_thread(t["threadId"]) is None:
            db.upsert_chat_thread(
                t["threadId"], account_id, t["profileUrl"], t["profileName"],
                t["sourceType"], t["sourceText"], status="starting")
    # Threads of THIS account that dropped out of the watch list
    # (marked done in the app) stop being watched.
    watched_ids = {t["threadId"] for t in clean_threads}
    for row in db.list_chat_threads(account_id):
        if (row["id"] not in watched_ids
                and row.get("status") in ("active", "starting")):
            db.set_chat_thread(row["id"], status="done")
    chat.set_watch({
        "accountId": account_id,
        "threads": clean_threads,
        "script": script,
        "geminiKey": gemini_key,
        "model": (body.get("model") or chat.DEFAULT_MODEL).strip(),
        "dailyCap": daily_cap,
    })
    _ensure_watch_thread()
    return {"watching": True, "threads": len(clean_threads)}


def _message_stage_fields(message_id: str) -> dict:
    """Send-stage fields for one message id (GET /chat/threads)."""
    stage = chat.get_send_stage(message_id)
    if not stage:
        return {"sendStage": None, "sendStageSince": None,
                "sendStageDetail": None}
    return {"sendStage": stage.get("stage"),
            "sendStageSince": stage.get("since"),
            "sendStageDetail": stage.get("detail") or None}


@app.get("/chat/threads")
def chat_threads_endpoint():
    """Live chat state for the app to poll: every thread with its
    messages (delivery per message id, so the app can match the
    first message it composed) and whether the watcher runs."""
    out = []
    for row in db.list_chat_threads():
        messages = db.list_chat_messages(row["id"])
        out.append({
            "threadId": row["id"],
            "accountId": row.get("account_id") or "",
            "profileUrl": row.get("profile_url") or "",
            "profileName": row.get("profile_name") or "",
            "status": row.get("status") or "starting",
            "messengerThreadUrl": row.get("messenger_thread_url"),
            "lastError": row.get("last_error"),
            "messages": [{
                "id": m["id"],
                "role": m.get("role"),
                "text": m.get("text") or "",
                "delivery": m.get("delivery"),
                "sentAt": m.get("sent_at"),
                # Send-stage trail for this message (first-message send
                # only): current stage + when it entered it + the plain
                # failure reason. Null until the send starts.
                **_message_stage_fields(m["id"]),
            } for m in messages],
        })
    return {"threads": out, "watching": chat.is_watching()}


@app.post("/chat/stop")
async def chat_stop_endpoint():
    """Stop ALL chatting immediately: the watcher loop exits and any
    in-flight first message aborts between steps. The watch list,
    script and Gemini key are forgotten — nothing resumes until the
    app sends a new watch list."""
    chat.request_stop()
    return {"watching": False}


@app.post("/chat/forget")
async def chat_forget_endpoint(request: Request):
    """Forget one deleted chat thread: stop its in-flight send, drop
    it from the watch list, and delete its rows + stage trail, so a
    fresh chat with the same person starts clean. The app calls this
    before deleting locally. Never touches Facebook. `forgotten` is
    False when the agent never knew the thread (already forgotten, or
    the app created it while the agent was down) — still a success;
    `sendStopped` is False only when a send for this thread was still
    running after a 10 s wait, and the app's delete goes ahead anyway.
    """
    body = await request.json() if request.headers.get("content-length") else {}
    if not isinstance(body, dict):
        body = {}
    thread_id = (body.get("threadId") or "").strip()
    if not thread_id:
        return JSONResponse(
            status_code=400, content={"detail": "threadId is required"})
    # Stop first, delete after: mark it forgotten so the send aborts
    # at its next stop check, then give an in-flight send for THIS
    # thread a bounded moment to stop before the rows go.
    chat.mark_thread_forgotten(thread_id)
    send_stopped = True
    if _chat_start_busy and _chat_start_thread_id == thread_id:
        deadline = time.time() + 10
        while _chat_start_busy and time.time() < deadline:
            time.sleep(0.2)
        send_stopped = not _chat_start_busy
    forgotten = chat.forget_thread(thread_id)
    return {"forgotten": forgotten, "sendStopped": send_stopped}


# ----------------------------------------------------------------------
# Agent Control page (see src/routes/agent-control.tsx)
# ----------------------------------------------------------------------
# Every browser call here dispatches to BROWSER.run_with_page via
# asyncio.to_thread — the async endpoints never run a sync Playwright
# call on the event loop themselves (that was the live "Sync API
# inside the asyncio loop" error on Re-check session).
def _record_session_check(state: str, detail: dict) -> dict:
    """Record the last session check for GET /agent/status."""
    global _LAST_SESSION_CHECK
    _LAST_SESSION_CHECK = {"state": state, "at": _now_iso(),
                           "detail": detail}
    return _LAST_SESSION_CHECK


async def _read_body_account(request: Request) -> str:
    """Optional accountId from a POST body ("" when absent)."""
    try:
        body = await request.json() if request.headers.get("content-length") else {}
    except Exception:
        body = {}
    if not isinstance(body, dict):
        return ""
    return (body.get("accountId") or "").strip()


@app.get("/agent/status")
def agent_status_endpoint(accountId: str = ""):
    """Agent Control status: process up, Chrome profile, headless /
    headed, browser state, watching + watched threads, last session
    check, sends today for the account. Never launches a browser —
    the browser field only reports the cached page."""
    account_id = _browser_account(accountId)
    today = datetime.now(timezone.utc).date().isoformat()
    profile = profile_dir(account_id)
    return {
        "online": True,
        "profile": str(profile),
        "profileExists": profile.exists(),
        "headed": BROWSER.headed(account_id),
        "browser": BROWSER.browser_state(account_id),
        "watching": chat.is_watching(),
        "watchedThreads": chat.watched_count(),
        "chatStartBusy": _chat_start_busy,
        "lastSessionCheck": _LAST_SESSION_CHECK or None,
        "sendsToday": chat.count_sent_today(account_id),
        "sendsTodayDate": today,
    }


@app.post("/agent/session-check")
async def agent_session_check_endpoint(request: Request):
    """Re-check the Facebook session on the Messenger page — the
    same check a send runs. A dead browser is relaunched first;
    the result names the state + the structured detail, so the
    page can say plainly what to do next ("Session OK" or
    "Abhi bhi empty — browser restart karein")."""
    account = _browser_account(await _read_body_account(request))

    def _check(page):
        worker = FacebookWorker()
        state = worker.verify_session(page, {"note": agent_log},
                                      target_url=_MESSAGES_URL)
        detail = worker.session_diagnostic(page)
        record = _record_session_check(state, detail)
        agent_log(f"session check: {state} "
                  f"(url={detail['url']}, body_len={detail['body_len']})")
        return {"state": state, "at": record["at"], "detail": detail}

    try:
        return await asyncio.to_thread(
            BROWSER.run_with_page, account, False, _check)
    except Exception as exc:  # noqa: BLE001 - check failure, not a crash
        return JSONResponse(
            status_code=502,
            content={"detail": f"session check failed: {exc}"})


@app.post("/agent/browser-relaunch")
async def agent_browser_relaunch_endpoint(request: Request):
    """Close the Chromium browser and launch it fresh from the same
    profile (the signed-in session lives in the profile dir). This
    restarts the BROWSER only — the agent process itself keeps
    running; restarting that needs the run-agent.bat window."""
    account = _browser_account(await _read_body_account(request))
    try:
        alive = await asyncio.to_thread(BROWSER.relaunch, account)
    except Exception as exc:  # noqa: BLE001 - launch failure, plain message
        return JSONResponse(status_code=502,
                            content={"detail": str(exc)})
    agent_log(f"browser relaunched (alive: {'yes' if alive else 'no'})")
    return {"relaunched": True,
            "browser": "alive" if alive else "dead",
            "profile": str(profile_dir(account)),
            "headed": BROWSER.headed(account)}


@app.post("/agent/reload")
async def agent_reload_endpoint(request: Request):
    """Load the Messenger page fresh (forced navigation, not the
    cached page) and re-check the session. The fix when the page is
    stale/hung but the browser connection is alive."""
    account = _browser_account(await _read_body_account(request))

    def _reload(page):
        worker = FacebookWorker()
        loaded = worker._load(page, _MESSAGES_URL, {"note": agent_log},
                              "reload", timeout_ms=45000)
        detail = worker.session_diagnostic(page)
        state = worker.check_session(page, {"note": agent_log})
        return loaded, state, detail

    try:
        loaded, state, detail = await asyncio.to_thread(
            BROWSER.run_with_page, account, False, _reload)
    except Exception as exc:  # noqa: BLE001 - launch failure, plain message
        return JSONResponse(status_code=502,
                            content={"detail": str(exc)})
    record = _record_session_check(state, detail)
    agent_log(f"Messenger reloaded (loaded: {'yes' if loaded else 'no'}, "
              f"session: {state})")
    return {"reloaded": loaded, "state": state, "at": record["at"],
            "detail": detail}


@app.post("/agent/signin")
async def agent_signin_endpoint(request: Request):
    """Open a VISIBLE Chrome window for the account so the USER signs
    in to Facebook himself — exactly like Client Hunting's
    POST /api/accounts/{id}/signin. No password is ever asked for,
    stored, or changed by the agent. The window is left open
    afterwards; the session stays saved in the agent's own profile
    (agent/profiles/<account>) and later runs are headless. After
    signing in, press Relaunch browser to go back to silent headless
    (the sign-in window's context stays headed until relaunched)."""
    account = _browser_account(await _read_body_account(request))
    try:
        await asyncio.to_thread(
            BROWSER.open_for_signin, account, FACEBOOK_LOGIN_URL)
    except Exception as exc:  # noqa: BLE001 - launch failure, plain message
        return JSONResponse(status_code=502,
                            content={"detail": str(exc)})
    agent_log(f"sign-in window opened for account {account}")
    return {"ok": True, "accountId": account,
            "profile": str(profile_dir(account)),
            "detail": "Browser opened — sign in to Facebook yourself in "
                      "that window, then press Relaunch browser."}


@app.post("/agent/unwatch")
def agent_unwatch_endpoint():
    """Stop watching only: the watcher loop exits after its current
    check; in-flight sends are NOT stopped (use Stop all chatting
    for that)."""
    chat.clear_watch()
    agent_log("watching stopped from Agent Control")
    return {"watching": False}


@app.get("/agent/logs")
def agent_logs_endpoint():
    """Last ~50 agent log lines (newest last)."""
    with _LOG_LOCK:
        lines = list(_LOG_LINES)
    return {"lines": lines}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8001)
