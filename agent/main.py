"""LeadHunter agent — FastAPI app.

Local-only tool: bind to 127.0.0.1 (see run-agent.bat). The frontend
calls it from the user's PC, where the agent drives the user's own
logged-in Chrome/Facebook session via a persistent Playwright profile
(``agent/.chrome-profile`` by default, or the dir named by the
``LEADHUNTER_CHROME_PROFILE`` env var — e.g. the already-signed-in
Client Hunting profile, so no Facebook sign-in is needed). The
browser runs headless by default — no window appears, the work is
silent, exactly like Client Hunting; set ``LEADHUNTER_HEADED=1``
for the rare case a fresh Facebook sign-in is needed in a visible
window. The user signs in to Facebook once (unless the profile is
already signed in — see ``LEADHUNTER_CHROME_PROFILE``); the agent
NEVER asks for or stores a password.

Two jobs live here now: the old scraping endpoints (dormant — the
app no longer calls them) and the Inbox live-chat agent
(``/chat/*``): it opens Messenger chats for approved candidates,
sends the first message per the script, and watches Messenger for
their replies, drafting each reply with Gemini. See ``chat.py`` for
the safety rails (approval gate, daily cap, stop).

One running job at a time globally — a second start returns 409.
The browser is launched lazily on the first job (Playwright is
imported INSIDE the launcher, never at module top) and the same page
is reused across jobs.
"""

from __future__ import annotations

import os
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse

import chat
import db
import jobs
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
    and on normal shutdown: the Playwright context is closed and
    the driver stopped, so the next launch never shows Chromium's
    "Restore pages?" popup and no zombie Chromium holds the profile.
    """
    yield
    _close_browser()


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


# ----------------------------------------------------------------------
# Browser (lazy — Playwright imported inside the function only)
# ----------------------------------------------------------------------
PROFILE_IN_USE_MESSAGE = (
    "Chrome profile is in use — close Client Hunting first, "
    "then run the job again."
)


class ProfileInUseError(RuntimeError):
    """The chosen Chrome profile is locked by another running browser."""


def resolve_chrome_profile() -> Path:
    """Resolve the persistent Chrome profile dir for the agent.

    ``LEADHUNTER_CHROME_PROFILE`` (an absolute path) overrides the
    default ``agent/.chrome-profile`` — point it at an already-signed-in
    profile (e.g. the Client Hunting profile) so no Facebook sign-in
    is needed. Unset, empty, or whitespace-only means the default.
    ``~`` and env vars in the value are expanded; Windows backslash
    paths are accepted as-is.
    """
    raw = os.environ.get("LEADHUNTER_CHROME_PROFILE") or ""
    raw = raw.strip()
    if not raw:
        return _AGENT_DIR / ".chrome-profile"
    expanded = os.path.expandvars(os.path.expanduser(raw))
    return Path(expanded)


def _is_profile_in_use_error(exc: BaseException) -> bool:
    """True when a launch failure is Chromium's profile lock.

    A locked user-data-dir surfaces as "already in use" /
    "SingletonLock" / "profile ... in use" in Playwright's error text.
    """
    msg = str(exc).lower()
    return ("already in use" in msg or "singleton" in msg
            or ("profile" in msg and "in use" in msg))


def _headed_env() -> bool:
    """True when LEADHUNTER_HEADED requests a visible browser window.

    Headless is the default (silent, like client-hunting). Set
    ``LEADHUNTER_HEADED=1`` (1/true/yes, case-insensitive) for the
    rare case a fresh Facebook sign-in is needed in a visible window.
    """
    return (os.environ.get("LEADHUNTER_HEADED") or "").strip().lower() in (
        "1", "true", "yes")


_DEAD_CONNECTION_MARKERS = (
    "closed",
    "connection closed",
    "browser closed",
    "target closed",
)


def _is_dead_connection_error(exc: BaseException) -> bool:
    """True when an exception means the browser connection is dead.

    Playwright reports a dead browser as "Playwright connection
    closed" (and variants: browser closed, target closed). Any such
    error means the cached page/context is a corpse: it must be
    relaunched, never reused.
    """
    msg = str(exc).lower()
    return any(marker in msg for marker in _DEAD_CONNECTION_MARKERS)


def _browser_is_alive(page) -> bool:
    """True when the cached page's browser connection is still live.

    ``page.is_closed()`` alone cannot tell: it is local state, so
    a page whose Chromium process died still reports "not closed"
    — and every real call then throws "Playwright connection
    closed" (the live second-press failure: body_len=-1, every
    selector read "error"). ``browser.is_connected()`` is a local
    check of the connection itself, so it spots a dead browser
    instantly with no roundtrip. Any failure of the probe counts
    as dead — a page we cannot even probe is not worth reusing;
    relaunching from the profile dir is safe (the session lives
    there) and cheap compared with reusing a corpse.
    """
    try:
        if page.is_closed():
            return False
    except Exception:
        return False
    try:
        browser = page.context.browser
        return browser is not None and bool(browser.is_connected())
    except Exception:
        return False


def _close_browser():
    """Close the Playwright browser/context cleanly, if launched.

    Called on app shutdown (see ``_lifespan``) and when a dead page
    is rebuilt, so the next launch never shows Chromium's
    "Restore pages?" popup and no zombie Chromium holds the profile.
    Never raises.
    """
    global _page, _context, _playwright
    for obj in (_page, _context):
        try:
            if obj is not None:
                obj.close()
        except Exception:
            pass
    _page = None
    _context = None
    if _playwright is not None:
        try:
            _playwright.stop()
        except Exception:
            pass
        _playwright = None


def _get_page():
    """Launch (once) the persistent Chrome profile and return its page.

    Headless by default — no browser window appears, the work is
    silent, exactly like Client Hunting (``LEADHUNTER_HEADED=1``
    forces a visible window for a fresh sign-in). The session
    persists in the profile dir (see :func:`resolve_chrome_profile`).
    The same page is reused across jobs; a page that died (browser
    crashed or closed) is rebuilt on the next call. A dead browser
    connection is detected first — ``page.is_closed()`` cannot tell,
    so the cached page is probed with ``browser.is_connected()``;
    when the connection is dead the browser is relaunched from the
    same profile (the signed-in session lives in the profile dir),
    never silently reused. When the profile is locked by another
    browser the launch raises :class:`ProfileInUseError` with a
    plain message instead of crashing — the agent stays up and a
    later job retries the launch.
    """
    global _page, _context, _playwright
    if _page is not None:
        if _browser_is_alive(_page):
            return _page
        # Page closed, or its browser process died (connection
        # closed) — drop everything and relaunch below.
        print("[leadhunter] Browser page is dead — relaunching",
              flush=True)
        _close_browser()
    from playwright.sync_api import sync_playwright

    _playwright = sync_playwright().start()
    profile = resolve_chrome_profile()
    headed = _headed_env()
    print(f"[leadhunter] Browser: "
          f"{'headed (visible window)' if headed else 'headless'}",
          flush=True)
    print(f"[leadhunter] Chrome profile: {profile} "
          f"(exists: {'yes' if profile.exists() else 'no'})", flush=True)
    try:
        _context = _playwright.chromium.launch_persistent_context(
            user_data_dir=str(profile),
            headless=not headed,
            viewport={"width": 1280, "height": 800},
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-first-run",
                "--no-default-browser-check",
            ],
        )
    except Exception as exc:
        _playwright.stop()
        _playwright = None
        _context = None
        if _is_profile_in_use_error(exc):
            raise ProfileInUseError(PROFILE_IN_USE_MESSAGE) from exc
        raise
    _page = _context.pages[0] if _context.pages else _context.new_page()
    return _page


# ----------------------------------------------------------------------
# Job plumbing
# ----------------------------------------------------------------------
def _fresh_page():
    """Return a brand-new tab for the next job.

    A tab that just scrolled a huge Facebook feed is often hung or
    half-dead; reusing it made the 2nd Scrap fail with "page did
    not load (state: empty)". Every job therefore starts on a clean
    tab (the same state as the very first job after start). The
    session/cookies live in the profile, so nothing is lost.

    If opening the new tab fails because the browser connection
    died ("Playwright connection closed"), the browser is
    relaunched from the same profile and the fresh tab comes from
    the new browser — the dead page is NEVER silently returned.
    Any other new-tab failure still falls back to the existing
    page. A relaunch failure surfaces (ProfileInUseError / launch
    error) instead of a silent dead page.
    """
    global _page
    page = _get_page()
    context = _context
    if context is None:
        return page
    try:
        new_page = context.new_page()
    except Exception as exc:
        if not _is_dead_connection_error(exc):
            return page
        # The browser connection died after the job's page was
        # made: drop everything and relaunch from the same profile,
        # then take the fresh tab from the new browser.
        print("[leadhunter] Browser connection died while opening a "
              "new tab — relaunching", flush=True)
        _close_browser()
        return _get_page()
    try:
        page.close()
    except Exception:
        pass
    _page = new_page
    return new_page


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
    """Background thread for one job; clears the running slot at the end."""
    global _running_job_id
    try:
        page = _fresh_page()
        worker = FacebookWorker()
        job = db.get_job(job_id) or {}
        job.update(payload)
        should_stop = lambda: _stop_flags.get(job_id, False)  # noqa: E731
        note = lambda msg: print(f"[leadhunter] {msg}", flush=True)  # noqa: E731
        if kind == "scrape":
            jobs.run_scrape(worker, page, db, job, should_stop, note=note)
        elif kind == "collect":
            jobs.run_collect_sources(worker, page, db, job, should_stop,
                                     note=note)
        else:
            jobs.run_sync(worker, page, db, job, should_stop, note=note)
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
_chat_browser_lock = threading.Lock()
_chat_start_busy = False
_watch_thread = None


def _chat_watch_loop():
    """Background loop: one watch pass every WATCH_POLL_SECONDS
    while watching. The browser lock serialises it against chat
    starts; a dead browser is relaunched by _get_page(). The loop
    exits when watching stops — chat.request_stop() clears the
    watch and sets the flag, so one stop ends everything."""
    while True:
        if not chat.is_watching() or chat.stop_requested():
            return
        try:
            with _chat_browser_lock:
                page = _get_page()
                worker = FacebookWorker()
                note = lambda msg: print(f"[leadhunter] {msg}", flush=True)  # noqa: E731
                chat.watch_once(worker, page, note=note)
        except Exception as exc:  # noqa: BLE001 - pass failed, loop retries
            print(f"[leadhunter] chat watch pass failed: {exc}", flush=True)
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
    "queued" while it waits for the browser lock, "opening browser"
    while the page is (re)launched, then chat.start_chat takes over.
    """
    global _chat_start_busy
    message_id = payload.get("messageId") or ""
    chat.set_send_stage(message_id, "queued")
    try:
        with _chat_browser_lock:
            chat.set_send_stage(message_id, "opening browser")
            page = _fresh_page()
            worker = FacebookWorker()
            note = lambda msg: print(f"[leadhunter] {msg}", flush=True)  # noqa: E731
            chat.start_chat(worker, page, payload, note=note)
    except Exception as exc:  # noqa: BLE001 - start failure, not a crash
        chat.set_send_stage(message_id, "failed", str(exc))
        try:
            db.set_chat_thread(payload.get("threadId"), status="failed",
                               last_error=str(exc))
        except Exception:
            pass
    finally:
        _chat_start_busy = False


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
        page = _get_page()
        worker = FacebookWorker()
        result = jobs.delete_source(worker, page, db, source_id)
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
    global _chat_start_busy
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


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8001)
