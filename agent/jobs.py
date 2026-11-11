"""Scrape / sync job logic for the LeadHunter agent.

Pure merge plus the two job runners. Nothing here touches the
browser directly — the ``worker`` does that — and nothing here raises
out of a job: any failure is caught and recorded on the job row.

Timestamp rule (see timestamps.py): for every comment/reply, the
exact description (``posted_at_exact``) is parsed first; only when it
is missing does the visible label (``posted_at_label``) fall back to
label-minus-collection-instant. The label fallback is approximate by
nature (a "5d" label covers that whole day); the original label is
always kept in ``posted_at_label``.

Graceful stop: ``should_stop`` is checked BEFORE starting each post.
A stop requested mid-post does not interrupt it — the current post is
extracted, timestamped and saved fully, and only then does the job
end with status "stopped".

Count verification (hard rule — not a single comment or reply may be
missed): after each post, collected (top-level comments + all replies,
recursive) is compared against the post's stated total. Each touched
post gets a verification entry {postUrl, expectedComments, collected
Comments, missing, complete}; when the stated total could not be read
at all, expected/missing are null and complete is true (nothing to
verify against — no total is invented). A finished job is "done" only
when every touched post verified complete; otherwise it is
"incomplete" and its message says plainly how many are missing
(e.g. "collected 8 of 10 — 2 missing"). A stopped job keeps whatever
verification entries it completed.
"""

from __future__ import annotations

import copy
from datetime import datetime, timezone

from timestamps import posted_at

__all__ = ["merge_post_data", "run_scrape", "run_sync",
           "count_tree_nodes", "verification_entry", "verification_message"]

_SIGN_IN_ERROR = (
    "Facebook session is not signed in — please sign in to Facebook "
    "in the agent Chrome window, then run the job again. "
    "The agent never asks for or stores your Facebook password."
)


def _now_dt() -> datetime:
    return datetime.now(timezone.utc)


def _now_iso() -> str:
    return _now_dt().isoformat()


def _ctx(should_stop, note=None):
    return {
        "should_stop": should_stop,
        "pace": lambda: None,
        "note": note or (lambda m: None),
    }


def _note_fn(note):
    return note if callable(note) else (lambda m: None)


def count_tree_nodes(comments) -> int:
    """Top-level comments + all replies, recursive."""
    total = 0
    for c in comments or []:
        total += 1 + count_tree_nodes(c.get("replies"))
    return total


def verification_entry(post_url, expected, collected):
    """One verification entry. ``expected`` is the post's stated total
    (None when it could not be read — then complete is True and
    missing is None, since there is nothing to verify against)."""
    if expected is None:
        return {"postUrl": post_url, "expectedComments": None,
                "collectedComments": collected, "missing": None,
                "complete": True}
    missing = expected - collected
    return {"postUrl": post_url, "expectedComments": expected,
            "collectedComments": collected, "missing": missing,
            "complete": missing == 0}


def verification_message(entry):
    """Plain-language flag for a mismatched entry, or None when complete."""
    if entry["complete"]:
        return None
    expected = entry["expectedComments"]
    collected = entry["collectedComments"]
    if collected > expected:
        return (f"collected {collected} of {expected} — "
                f"{collected - expected} more than stated")
    return (f"collected {collected} of {expected} — "
            f"{expected - collected} missing")


def _finish_job(db, job_id, *, stopped, verification, processed,
                new_posts=None):
    """Write the final job state: verification entries, a plain
    message when anything mismatched, and the terminal status —
    "stopped", "incomplete" (finished, but >=1 post mismatched) or
    "done" (every touched post verified complete)."""
    messages = [m for m in (verification_message(e) for e in verification)
                if m]
    if stopped:
        status = "stopped"
    elif messages:
        status = "incomplete"
    else:
        status = "done"
    fields = {"status": status, "finished_at": _now_iso(),
              "posts_processed": processed,
              "verification": verification,
              "message": "; ".join(messages) if messages else None}
    if new_posts is not None:
        fields["new_posts"] = new_posts
    db.update_job(job_id, **fields)
    return status


def _match_key(author_name, text):
    """Comment/reply identity: (author name, text) after trimming."""
    return ((author_name or "").strip(), (text or "").strip())


def _with_timestamps(node, collected_at):
    """Copy one comment/reply node, computing posted_at from its exact
    description first, else from its label, against ``collected_at``."""
    out = {
        "author_name": node.get("author_name", ""),
        "author_url": node.get("author_url", ""),
        "text": node.get("text", ""),
        "posted_at": posted_at(
            node.get("posted_at_exact"), node.get("posted_at_label"),
            collected_at),
        "posted_at_label": node.get("posted_at_label") or "",
        "replies": [],
    }
    for reply in node.get("replies") or []:
        out["replies"].append(_with_timestamps(reply, collected_at))
    return out


def _to_post_dict(data, source_id, account_id, post_url, collected_at):
    """Map an _EXTRACT_POST_JS result to the db.save_post shape,
    computing posted_at for every comment/reply against the
    collection instant."""
    return {
        "source_id": source_id,
        "account_id": account_id or "",
        "post_url": post_url,
        "author_name": data.get("author_name", ""),
        "author_url": data.get("author_url", ""),
        "text": data.get("text", ""),
        "collected_at": collected_at.isoformat(),
        "comments": [
            _with_timestamps(c, collected_at)
            for c in (data.get("comments") or [])
        ],
    }


def merge_post_data(existing: dict, incoming: dict):
    """Merge freshly extracted post data into the stored post.

    Comments/replies match by (author name, text) after trimming.
    Only genuinely new comments/replies are appended; the post text
    is updated when the incoming text differs and is non-empty.
    Returns (merged_dict, added_comments, added_replies). Neither
    input dict is mutated.
    """
    merged = copy.deepcopy(existing)
    added_comments = 0
    added_replies = 0

    incoming_text = (incoming.get("text") or "").strip()
    if incoming_text and incoming_text != (merged.get("text") or "").strip():
        merged["text"] = incoming.get("text")

    existing_comments = merged.setdefault("comments", [])
    by_key = {_match_key(c.get("author_name"), c.get("text")): c
              for c in existing_comments}
    for inc_comment in incoming.get("comments") or []:
        key = _match_key(inc_comment.get("author_name"),
                         inc_comment.get("text"))
        stored = by_key.get(key)
        if stored is None:
            existing_comments.append(copy.deepcopy(inc_comment))
            added_comments += 1
            added_replies += len(inc_comment.get("replies") or [])
            continue
        stored_replies = stored.setdefault("replies", [])
        reply_keys = {_match_key(r.get("author_name"), r.get("text"))
                      for r in stored_replies}
        for inc_reply in inc_comment.get("replies") or []:
            if _match_key(inc_reply.get("author_name"),
                          inc_reply.get("text")) not in reply_keys:
                stored_replies.append(copy.deepcopy(inc_reply))
                added_replies += 1
    return merged, added_comments, added_replies


def _fail(db, job_id, error):
    try:
        db.update_job(job_id, status="failed", finished_at=_now_iso(),
                      error=str(error))
    except Exception:
        pass


def _check_session_first(worker, page, db, job_id, should_stop):
    """Session check FIRST, via the worker. Returns True when the
    session is ok. On any other state the job is marked failed with
    the sign-in message and nothing is scraped."""
    try:
        state = worker.verify_session(page, _ctx(should_stop))
    except Exception as exc:  # noqa: BLE001 - never raise out of a job
        _fail(db, job_id, exc)
        return False
    if state != "ok":
        _fail(db, job_id, _SIGN_IN_ERROR)
        return False
    return True


def run_scrape(worker, page, db, job, should_stop, note=None):
    """Scrape new posts from one source into the DB.

    ``job`` is a db job row dict, enriched with ``source_url`` (and
    optionally ``source_name``, ``source_type``, ``limit``). Never
    raises: failures are recorded on the job row.
    """
    job_id = job["id"]
    note = _note_fn(note)
    try:
        if not _check_session_first(worker, page, db, job_id, should_stop):
            return
        source_id = job.get("source_id")
        account_id = job.get("account_id") or ""
        source_url = job.get("source_url")
        if not source_url and source_id:
            src = db.get_source_by_id(source_id)
            source_url = src["url"] if src else None
        if not source_url:
            _fail(db, job_id, "scrape job has no source URL")
            return
        if source_id:
            db.upsert_source(
                source_id,
                job.get("source_name") or source_id,
                job.get("source_type") or "group",
                source_url, None, "joined", account_id or None)
        known = {p["post_url"] for p in db.get_posts_for_source(source_id)} \
            if source_id else set()
        limit = job.get("limit") or 50
        urls = worker.collect_feed_post_urls(
            page, source_url, known, limit, _ctx(should_stop, note))
        processed = 0
        new_posts = 0
        stopped = False
        verification = []
        for url in urls:
            # Stop is checked BEFORE starting each post; a post already
            # in progress is always finished and saved first.
            if should_stop():
                stopped = True
                break
            collected_at = _now_dt()
            try:
                data = worker.extract_post(page, url, _ctx(should_stop, note))
            except Exception:
                data = None
            if not data:
                continue
            is_new = not db.known_post_url(url)
            post_dict = _to_post_dict(data, source_id, account_id, url,
                                      collected_at)
            db.save_post(post_dict)
            processed += 1
            if is_new:
                new_posts += 1
            entry = verification_entry(
                url, data.get("comment_total"),
                count_tree_nodes(post_dict["comments"]))
            verification.append(entry)
            msg = verification_message(entry)
            if msg:
                note(f"{url}: {msg}")
            db.update_job(job_id, posts_processed=processed,
                          new_posts=new_posts, verification=verification)
        _finish_job(db, job_id, stopped=stopped, verification=verification,
                    processed=processed, new_posts=new_posts)
    except Exception as exc:  # noqa: BLE001 - never raise out of a job
        _fail(db, job_id, exc)


def run_sync(worker, page, db, job, should_stop, note=None):
    """Re-visit known posts and merge new activity into the DB.

    ``job`` is a db job row dict, enriched with ``source_url`` /
    ``post_url`` as applicable. Syncs every known post of the source,
    or the single post when ``post_id``/``post_url`` is set. Never
    raises: failures are recorded on the job row.
    """
    job_id = job["id"]
    note = _note_fn(note)
    try:
        if not _check_session_first(worker, page, db, job_id, should_stop):
            return
        source_id = job.get("source_id")
        account_id = job.get("account_id") or ""
        targets = []
        if job.get("post_id"):
            post = db.get_post_by_id(job["post_id"])
            if post:
                targets = [post]
        elif job.get("post_url"):
            post = db.get_post_by_url(job["post_url"])
            if post:
                targets = [post]
        elif source_id:
            targets = db.get_posts_for_source(source_id)
        processed = 0
        stopped = False
        verification = []
        for existing in targets:
            if should_stop():
                stopped = True
                break
            url = existing["post_url"]
            collected_at = _now_dt()
            try:
                data = worker.extract_post(page, url, _ctx(should_stop, note))
            except Exception:
                data = None
            if not data:
                continue
            incoming = _to_post_dict(
                data, existing.get("source_id") or source_id,
                existing.get("account_id") or account_id, url, collected_at)
            merged, _, _ = merge_post_data(existing, incoming)
            db.save_post(merged, last_synced_at=_now_iso())
            processed += 1
            entry = verification_entry(
                url, data.get("comment_total"),
                count_tree_nodes(merged["comments"]))
            verification.append(entry)
            msg = verification_message(entry)
            if msg:
                note(f"{url}: {msg}")
            db.update_job(job_id, posts_processed=processed,
                          verification=verification)
        _finish_job(db, job_id, stopped=stopped, verification=verification,
                    processed=processed)
    except Exception as exc:  # noqa: BLE001 - never raise out of a job
        _fail(db, job_id, exc)
