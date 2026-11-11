"""LeadHunter scraping agent — FastAPI app.

Local-only tool: bind to 127.0.0.1 (see run-agent.bat). The frontend
calls it from the user's PC, where the agent drives the user's own
logged-in Chrome/Facebook session via a persistent Playwright profile
(``agent/.chrome-profile``). The user signs in to Facebook once in
that Chrome window; the agent NEVER asks for or stores a password.

One running job at a time globally — a second start returns 409.
The browser is launched lazily on the first job (Playwright is
imported INSIDE the launcher, never at module top) and the same page
is reused across jobs.
"""

from __future__ import annotations

import threading
from pathlib import Path
from urllib.parse import urlparse

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

app = FastAPI(title="leadhunter-agent", version=VERSION)
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
_playwright = None


# ----------------------------------------------------------------------
# Browser (lazy — Playwright imported inside the function only)
# ----------------------------------------------------------------------
def _get_page():
    """Launch (once) the persistent Chrome profile and return its page.

    headless=False so the user can see the window and sign in to
    Facebook there on first run; the session persists in
    agent/.chrome-profile. The same page is reused across jobs.
    """
    global _page, _playwright
    if _page is not None:
        return _page
    from playwright.sync_api import sync_playwright

    _playwright = sync_playwright().start()
    profile = _AGENT_DIR / ".chrome-profile"
    context = _playwright.chromium.launch_persistent_context(
        user_data_dir=str(profile),
        headless=False,
        args=["--disable-blink-features=AutomationControlled"],
    )
    _page = context.pages[0] if context.pages else context.new_page()
    return _page


# ----------------------------------------------------------------------
# Job plumbing
# ----------------------------------------------------------------------
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
        page = _get_page()
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
# Endpoints
# ----------------------------------------------------------------------
@app.get("/health")
def health():
    return {"ok": True, "service": "leadhunter-agent",
            "version": VERSION, "facebook": "unknown"}


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


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8001)
