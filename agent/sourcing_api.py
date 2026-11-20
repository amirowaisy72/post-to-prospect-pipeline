"""Data Sourcing read/write API used by the Data Sourcing pages.

Sources and posts live in the agent's sqlite DB; the app reads them
page by page from here instead of keeping thousands of posts in the
browser's localStorage. Scraping, syncing, stopping and collecting
still go through the job endpoints in main.py (/scrape, /sync,
/collect-sources, /stop, /jobs).
"""

from __future__ import annotations

import uuid
from urllib.parse import urlparse

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse


def _source_view(row: dict) -> dict:
    return {
        "id": row["id"],
        "name": row.get("name") or "",
        "type": row.get("type") or "group",
        "url": row.get("url") or "",
        "memberCount": row.get("member_count"),
        "status": row.get("status") or "joined",
        "accountId": row.get("joined_by_account_id") or "",
        "lastScrapedAt": row.get("last_scraped_at"),
        "postCount": int(row.get("post_count") or 0),
    }


def build_router(db, post_view, is_busy, run_browser=None) -> APIRouter:
    r = APIRouter()

    @r.get("/sources")
    def list_sources(accountId: str = ""):
        sql = (
            "SELECT s.*, (SELECT COUNT(*) FROM posts p WHERE p.source_id = s.id) "
            "AS post_count FROM sources s"
        )
        args: tuple = ()
        if accountId:
            sql += " WHERE s.joined_by_account_id = ?"
            args = (accountId,)
        sql += " ORDER BY s.rowid DESC"
        with db._connect() as conn:
            rows = [dict(x) for x in conn.execute(sql, args).fetchall()]
        return {"sources": [_source_view(x) for x in rows]}

    @r.post("/sources/manual")
    async def add_manual(request: Request):
        body = await request.json() if request.headers.get("content-length") else {}
        if not isinstance(body, dict):
            body = {}
        name = (body.get("name") or "").strip()
        url = (body.get("url") or "").strip()
        account_id = (body.get("accountId") or "").strip()
        if not name or not url or not account_id:
            return JSONResponse(
                status_code=400,
                content={"detail": "name, url and accountId are required"},
            )
        if "://" not in url:
            url = "https://" + url
        host = (urlparse(url).netloc or "").lower()
        if "facebook.com" not in host:
            return JSONResponse(
                status_code=400,
                content={"detail": "the link must be a facebook.com URL"},
            )
        if db.get_source_by_url(url) is not None:
            return JSONResponse(
                status_code=409, content={"detail": "this link is already in the list"}
            )
        try:
            members = int(body.get("memberCount"))
        except (TypeError, ValueError):
            members = None
        kind = "group" if "/groups/" in url else "page"
        source_id = uuid.uuid4().hex
        status = (
            body.get("status")
            if body.get("status") in ("joined", "not-joined")
            else "joined"
        )
        db.upsert_source(source_id, name, kind, url, members, status, account_id)
        return {"id": source_id}

    @r.post("/sources/{source_id}/remove")
    async def remove_source(source_id: str, force: bool = False):
        """Delete a source everywhere. A joined/followed source is first
        left/unfollowed on Facebook; if that fails the record stays
        (unless force=true) so the user can retry."""
        import asyncio

        import sourcing_engine

        if is_busy():
            return JSONResponse(
                status_code=409, content={"detail": "another job is already running"}
            )
        src = db.get_source_by_id(source_id)
        if src is None:
            return JSONResponse(status_code=404, content={"detail": "unknown source"})
        if (src.get("status") or "") == "joined" and src.get("url"):
            result = await asyncio.to_thread(
                run_browser,
                src.get("joined_by_account_id") or "",
                lambda page: sourcing_engine.delete_source(page, db, source_id, force),
            )
        else:
            result = sourcing_engine.delete_source(None, db, source_id, force)
        if not result.get("ok"):
            return JSONResponse(status_code=502, content=result)
        return result

    @r.get("/sources/{source_id}/posts")
    def source_posts(source_id: str, offset: int = 0, limit: int = 20):
        offset = max(0, offset)
        limit = max(1, min(limit, 100))
        with db._connect() as conn:
            total = conn.execute(
                "SELECT COUNT(*) AS n FROM posts WHERE source_id = ?", (source_id,)
            ).fetchone()["n"]
            rows = conn.execute(
                "SELECT p.*, "
                "(SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS n_comments, "
                "(SELECT COUNT(*) FROM replies rp JOIN comments c2 "
                " ON rp.comment_id = c2.id WHERE c2.post_id = p.id) AS n_replies "
                "FROM posts p WHERE p.source_id = ? "
                "ORDER BY (n_comments + n_replies) DESC, p.collected_at DESC, p.rowid DESC "
                "LIMIT ? OFFSET ?",
                (source_id, limit, offset),
            ).fetchall()
        posts = []
        for row in rows:
            d = dict(row)
            text = d.get("text") or ""
            posts.append(
                {
                    "id": d["id"],
                    "postUrl": d.get("post_url") or "",
                    "author": {
                        "name": d.get("author_name") or "",
                        "url": d.get("author_url") or "",
                    },
                    "text": text[:400],
                    "commentCount": int(d.get("n_comments") or 0),
                    "replyCount": int(d.get("n_replies") or 0),
                    "collectedAt": d.get("collected_at"),
                    "lastSyncedAt": d.get("last_synced_at"),
                }
            )
        return {"total": int(total), "offset": offset, "limit": limit, "posts": posts}

    @r.get("/posts/{post_id}")
    def one_post(post_id: str):
        post = db.get_post_by_id(post_id)
        if post is None:
            return JSONResponse(status_code=404, content={"detail": "unknown post"})
        return {"post": post_view(post)}

    return r
