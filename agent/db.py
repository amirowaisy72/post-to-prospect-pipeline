"""SQLite storage for the LeadHunter agent (stdlib ``sqlite3`` only).

One database file, ``leadhunter.db`` next to this module (the agent's
own working copy on the user's PC). All helpers are module-level and
operate on the path set by :func:`init_db` (default: the agent dir's
``leadhunter.db``); each call opens a short-lived connection, so the
module is safe to use from the job thread and the API thread.

Tables mirror the frontend's domain objects (see
``src/lib/types.ts`` in the repo): accounts, sources, posts, comments,
replies, jobs. A post is unique by its Facebook URL; saving a post
replaces its comments/replies with the supplied snapshot (used both
for fresh scrapes and for merged sync results).
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from pathlib import Path

__all__ = [
    "init_db",
    "upsert_source",
    "get_source_by_id",
    "known_post_url",
    "save_post",
    "get_post_by_url",
    "get_post_by_id",
    "get_posts_for_source",
    "create_job",
    "update_job",
    "get_job",
    "list_jobs",
    "get_source_by_url",
    "delete_source",
]

_DEFAULT_PATH = Path(__file__).resolve().parent / "leadhunter.db"
_DB_PATH = _DEFAULT_PATH

_SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    facebook_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'group',
    url TEXT NOT NULL DEFAULT '',
    member_count INTEGER,
    status TEXT NOT NULL DEFAULT 'joined',
    joined_by_account_id TEXT,
    last_scraped_at TEXT
);
CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    source_id TEXT,
    account_id TEXT NOT NULL DEFAULT '',
    post_url TEXT NOT NULL UNIQUE,
    author_name TEXT NOT NULL DEFAULT '',
    author_url TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    collected_at TEXT NOT NULL,
    last_synced_at TEXT
);
CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    author_name TEXT NOT NULL DEFAULT '',
    author_url TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    posted_at TEXT,
    posted_at_label TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS replies (
    id TEXT PRIMARY KEY,
    comment_id TEXT NOT NULL,
    author_name TEXT NOT NULL DEFAULT '',
    author_url TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    posted_at TEXT,
    posted_at_label TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    source_id TEXT,
    post_id TEXT,
    account_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'running',
    posts_processed INTEGER NOT NULL DEFAULT 0,
    new_posts INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    error TEXT,
    verification TEXT NOT NULL DEFAULT '[]',
    message TEXT,
    result TEXT
);
CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments (post_id);
CREATE INDEX IF NOT EXISTS idx_replies_comment_id ON replies (comment_id);
CREATE INDEX IF NOT EXISTS idx_posts_source_id ON posts (source_id);
"""


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db(path=None) -> Path:
    """Set the database path (default: agent/leadhunter.db) and create
    the tables if they do not exist yet. Returns the path in use."""
    global _DB_PATH
    _DB_PATH = Path(path) if path is not None else _DEFAULT_PATH
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _connect() as conn:
        conn.executescript(_SCHEMA)
        # Migrate databases created before the verification/message
        # columns existed (jobs.verification holds the per-post count
        # check; jobs.message holds the plain-language job result).
        cols = {r[1] for r in conn.execute("PRAGMA table_info(jobs)")}
        if "verification" not in cols:
            conn.execute(
                "ALTER TABLE jobs ADD COLUMN verification TEXT "
                "NOT NULL DEFAULT '[]'")
        if "message" not in cols:
            conn.execute("ALTER TABLE jobs ADD COLUMN message TEXT")
        if "result" not in cols:
            conn.execute("ALTER TABLE jobs ADD COLUMN result TEXT")
    return _DB_PATH


def _decode_verification(row: dict) -> dict:
    """Parse the stored verification/result JSON back into lists/dicts."""
    raw = row.get("verification")
    if isinstance(raw, list):
        pass
    else:
        try:
            row["verification"] = json.loads(raw) if raw else []
        except Exception:
            row["verification"] = []
    raw = row.get("result")
    if raw is None:
        row["result"] = None
    elif isinstance(raw, (list, dict)):
        pass
    else:
        try:
            row["result"] = json.loads(raw) if raw else None
        except Exception:
            row["result"] = None
    return row


def _new_id() -> str:
    return uuid.uuid4().hex


# ----------------------------------------------------------------------
# Sources
# ----------------------------------------------------------------------
def upsert_source(source_id, name, type_, url, member_count=None,
                  status="joined", joined_by_account_id=None):
    """Insert or update a source row. Returns the source id."""
    with _connect() as conn:
        conn.execute(
            "INSERT INTO sources "
            "(id, name, type, url, member_count, status, joined_by_account_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET "
            "name=excluded.name, type=excluded.type, url=excluded.url, "
            "member_count=excluded.member_count, status=excluded.status, "
            "joined_by_account_id=excluded.joined_by_account_id",
            (source_id, name or "", type_ or "group", url or "",
             member_count, status, joined_by_account_id),
        )
    return source_id


def get_source_by_id(source_id):
    """One source row as a dict, or None."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM sources WHERE id = ?", (source_id,)).fetchone()
    return dict(row) if row else None


def get_source_by_url(url):
    """One source row by its Facebook URL, or None. Used by the
    collect-sources job to skip a group/page this account (or any
    account) already joined."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM sources WHERE url = ?", (url,)).fetchone()
    return dict(row) if row else None


def delete_source(source_id):
    """Delete a source row AND its posts (comments/replies cascade by
    explicit delete: replies of the source's posts, then comments,
    then posts, then the source itself). Returns True when a row was
    removed, False when the id did not exist."""
    with _connect() as conn:
        post_rows = conn.execute(
            "SELECT id FROM posts WHERE source_id = ?",
            (source_id,)).fetchall()
        post_ids = [r["id"] for r in post_rows]
        for post_id in post_ids:
            comment_rows = conn.execute(
                "SELECT id FROM comments WHERE post_id = ?",
                (post_id,)).fetchall()
            for comment_row in comment_rows:
                conn.execute("DELETE FROM replies WHERE comment_id = ?",
                             (comment_row["id"],))
            conn.execute("DELETE FROM comments WHERE post_id = ?",
                         (post_id,))
        conn.execute("DELETE FROM posts WHERE source_id = ?", (source_id,))
        cur = conn.execute("DELETE FROM sources WHERE id = ?",
                           (source_id,))
        return cur.rowcount > 0


# ----------------------------------------------------------------------
# Posts / comments / replies
# ----------------------------------------------------------------------
def known_post_url(url) -> bool:
    """True when a post with this URL is already stored."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM posts WHERE post_url = ?", (url,)).fetchone()
    return row is not None


def save_post(post_dict, last_synced_at=None):
    """Save a post (plus its comments and replies) and return its id.

    ``post_dict`` keys: source_id, account_id, post_url, author_name,
    author_url, text, collected_at, comments — each comment a dict
    with author_name, author_url, text, posted_at, posted_at_label and
    replies (same shape, minus replies). Saving a post that already
    exists (same post_url) keeps its original collected_at and
    replaces its comments/replies with the supplied snapshot.
    ``last_synced_at``, when given, is stored on the post row.
    """
    post_url = post_dict["post_url"]
    with _connect() as conn:
        existing = conn.execute(
            "SELECT id, collected_at FROM posts WHERE post_url = ?",
            (post_url,)).fetchone()
        if existing:
            post_id = existing["id"]
            collected_at = post_dict.get("collected_at") or existing["collected_at"]
            conn.execute(
                "UPDATE posts SET source_id=?, account_id=?, author_name=?, "
                "author_url=?, text=?, collected_at=?, "
                "last_synced_at=COALESCE(?, last_synced_at) WHERE id=?",
                (post_dict.get("source_id"), post_dict.get("account_id", ""),
                 post_dict.get("author_name", ""), post_dict.get("author_url", ""),
                 post_dict.get("text", ""), collected_at, last_synced_at, post_id),
            )
            conn.execute("DELETE FROM replies WHERE comment_id IN "
                         "(SELECT id FROM comments WHERE post_id=?)", (post_id,))
            conn.execute("DELETE FROM comments WHERE post_id=?", (post_id,))
        else:
            post_id = post_dict.get("id") or _new_id()
            collected_at = post_dict.get("collected_at")
            conn.execute(
                "INSERT INTO posts (id, source_id, account_id, post_url, "
                "author_name, author_url, text, collected_at, last_synced_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (post_id, post_dict.get("source_id"),
                 post_dict.get("account_id", ""), post_url,
                 post_dict.get("author_name", ""), post_dict.get("author_url", ""),
                 post_dict.get("text", ""), collected_at, last_synced_at),
            )
        for c_pos, comment in enumerate(post_dict.get("comments") or []):
            comment_id = _new_id()
            conn.execute(
                "INSERT INTO comments (id, post_id, author_name, author_url, "
                "text, posted_at, posted_at_label, position) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (comment_id, post_id, comment.get("author_name", ""),
                 comment.get("author_url", ""), comment.get("text", ""),
                 comment.get("posted_at"), comment.get("posted_at_label", ""),
                 c_pos),
            )
            for r_pos, reply in enumerate(comment.get("replies") or []):
                conn.execute(
                    "INSERT INTO replies (id, comment_id, author_name, "
                    "author_url, text, posted_at, posted_at_label, position) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (_new_id(), comment_id, reply.get("author_name", ""),
                     reply.get("author_url", ""), reply.get("text", ""),
                     reply.get("posted_at"), reply.get("posted_at_label", ""),
                     r_pos),
                )
    return post_id


def _post_with_children(conn, post_row):
    post = dict(post_row)
    comments = conn.execute(
        "SELECT * FROM comments WHERE post_id=? ORDER BY position",
        (post["id"],)).fetchall()
    out_comments = []
    for c in comments:
        comment = dict(c)
        replies = conn.execute(
            "SELECT * FROM replies WHERE comment_id=? ORDER BY position",
            (comment["id"],)).fetchall()
        comment["replies"] = [dict(r) for r in replies]
        out_comments.append(comment)
    post["comments"] = out_comments
    return post


def get_post_by_url(url):
    """One post (with nested comments/replies) as a dict, or None."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM posts WHERE post_url = ?", (url,)).fetchone()
        if not row:
            return None
        return _post_with_children(conn, row)


def get_post_by_id(post_id):
    """One post (with nested comments/replies) as a dict, or None."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM posts WHERE id = ?", (post_id,)).fetchone()
        if not row:
            return None
        return _post_with_children(conn, row)


def get_posts_for_source(source_id):
    """All posts of a source (with nested comments/replies), oldest first."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM posts WHERE source_id=? ORDER BY collected_at",
            (source_id,)).fetchall()
        return [_post_with_children(conn, r) for r in rows]


# ----------------------------------------------------------------------
# Jobs
# ----------------------------------------------------------------------
def create_job(kind, source_id=None, post_id=None, account_id="",
               started_at=None):
    """Create a job row in 'running' state and return its id."""
    if started_at is None:
        from datetime import datetime, timezone

        started_at = datetime.now(timezone.utc).isoformat()
    job_id = _new_id()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO jobs (id, kind, source_id, post_id, account_id, "
            "status, posts_processed, new_posts, started_at) "
            "VALUES (?, ?, ?, ?, ?, 'running', 0, 0, ?)",
            (job_id, kind, source_id, post_id, account_id or "", started_at),
        )
    return job_id


def update_job(job_id, **fields):
    """Update job columns. Allowed keys: status, posts_processed,
    new_posts, finished_at, error, verification, message, result.
    Unknown keys are ignored. ``verification`` may be passed as a list
    (stored as JSON) or as a JSON string; ``result`` the same (dict or
    list, stored as JSON)."""
    allowed = {"status", "posts_processed", "new_posts", "finished_at",
               "error", "verification", "message", "result"}
    updates = {k: v for k, v in fields.items() if k in allowed}
    if not updates:
        return
    if isinstance(updates.get("verification"), (list, dict)):
        updates["verification"] = json.dumps(updates["verification"])
    if isinstance(updates.get("result"), (list, dict)):
        updates["result"] = json.dumps(updates["result"])
    assignments = ", ".join(f"{k}=?" for k in updates)
    with _connect() as conn:
        conn.execute(
            f"UPDATE jobs SET {assignments} WHERE id=?",
            (*updates.values(), job_id),
        )


def get_job(job_id):
    """One job row as a dict (verification decoded to a list), or None."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    return _decode_verification(dict(row)) if row else None


def list_jobs(limit=50):
    """Job rows, newest first (verification decoded to a list)."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM jobs ORDER BY started_at DESC LIMIT ?",
            (limit,)).fetchall()
    return [_decode_verification(dict(r)) for r in rows]
