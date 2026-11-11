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
           "run_collect_sources", "delete_source",
           "count_tree_nodes", "verification_entry", "verification_message"]

_SIGN_IN_ERROR = (
    "Facebook session is not signed in — please sign in to Facebook "
    "in the agent Chrome window, then run the job again. "
    "The agent never asks for or stores your Facebook password."
)

# The job failure message names the ACTUAL detected state instead
# of always saying "not signed in": an empty home page is a load
# failure, not proof the session is dead — the browser may still
# be signed in, so the user just retries the job.
_SESSION_ERRORS = {
    "logged_out": _SIGN_IN_ERROR,
    "checkpoint": (
        "Facebook is asking for a checkpoint / identity check "
        "(state: checkpoint) — please complete the check in the "
        "agent Chrome window, then run the job again."
    ),
    "blocked": (
        "Facebook blocked the agent browser (state: blocked) — "
        "please open Facebook in the agent Chrome window and "
        "check for a warning, then run the job again."
    ),
    "empty": (
        "Facebook home page did not load (state: empty) — the "
        "browser may still be signed in; try the job again."
    ),
}


def _session_error(state: str) -> str:
    """Failure message for a non-ok session state."""
    return _SESSION_ERRORS.get(state, _SIGN_IN_ERROR)


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
    a message naming that state, and nothing is scraped."""
    try:
        state = worker.verify_session(page, _ctx(should_stop))
    except Exception as exc:  # noqa: BLE001 - never raise out of a job
        _fail(db, job_id, exc)
        return False
    if state != "ok":
        _fail(db, job_id, _session_error(state))
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


def run_collect_sources(worker, page, db, job, should_stop, note=None):
    """Keyword search + collect: search Facebook for groups/pages
    matching the keyword, apply the comments gate and the member
    gate, join the good groups (pages are recorded, not joined — a
    page needs no join), and save them as sources.

    ``job`` is a db job row dict, enriched with ``keyword``,
    ``type`` ("group" / "page" / "both"), ``max_new``,
    ``min_comments`` (default 3) and ``min_members`` (default 100)
    — the two gates come from Configurations sourcing rules.
    Rules ported from client-hunting ``collect_sources``: a source
    whose posts carry fewer than min_comments comments is dead and
    is never saved and never consumes the target; a source with a
    known member count below min_members is skipped the same way;
    a source already joined by ANY account is skipped. A missing
    member count never blocks a run — it is read once from the
    source's own page, and if it still cannot be read the source
    proceeds (a missing count is not proof of a small group).
    One search pass per run: the user presses Add Source again for
    more (the original cycled its keyword list with a 2-minute
    wait between empty passes, which makes no sense for a single
    keyword). A join that fails means the group is NOT saved — the
    user can retry with another Add Source run. Never raises:
    failures are recorded on the job row. The joined sources are
    stored on the job row as ``result`` = {"sources": [...]}.
    """
    job_id = job["id"]
    note = _note_fn(note)
    try:
        if not _check_session_first(worker, page, db, job_id, should_stop):
            return
        keyword = (job.get("keyword") or "").strip()
        if not keyword:
            _fail(db, job_id, "collect job has no keyword")
            return
        account_id = job.get("account_id") or ""
        type_ = (job.get("type") or "group").strip().lower()
        if type_ not in ("group", "page", "both"):
            type_ = "group"
        try:
            max_new = int(job.get("max_new") or 10)
        except (TypeError, ValueError):
            max_new = 10
        try:
            min_comments = int(job.get("min_comments") or 3)
        except (TypeError, ValueError):
            min_comments = 3
        try:
            min_members = int(job.get("min_members") or 100)
        except (TypeError, ValueError):
            min_members = 100
        ctx = _ctx(should_stop, note)
        candidates = []
        if type_ in ("group", "both"):
            for group in worker.search_groups(page, keyword, ctx) or []:
                candidates.append({"kind": "group", **(group or {})})
        if type_ in ("page", "both") and len(candidates) < max_new * 3:
            for found_page in worker.search_pages(page, keyword, ctx) or []:
                candidates.append({"kind": "page", **(found_page or {})})
        seen_urls = set()
        joined = []
        checked = 0
        stopped = False
        for candidate in candidates:
            if len(joined) >= max_new:
                break
            if should_stop():
                stopped = True
                break
            url = (candidate.get("url") or "").strip()
            if not url or url in seen_urls:
                continue
            seen_urls.add(url)
            checked += 1
            kind = candidate.get("kind") or "group"
            name = candidate.get("name") or ""
            existing = db.get_source_by_url(url)
            if existing is not None:
                note(f"Already joined: {url} — skipped")
                continue
            # Member gate: known count below the minimum is dead;
            # unknown count is read once from the source's own page;
            # still unknown -> proceed (never blocks a run).
            member_count = candidate.get("member_count")
            if member_count is None:
                try:
                    member_count = worker.read_source_member_count(
                        page, url, name, ctx)
                except Exception:
                    member_count = None
            if (isinstance(member_count, int)
                    and member_count < min_members):
                note(f"Skipped {kind} (too few members): {url} — "
                     f"{member_count} members (need {min_members})")
                continue
            # Comments gate: our data comes purely from comments.
            # The gate scrolls the feed patiently before deciding,
            # so a group whose first screen is bare is not skipped
            # for a count the feed had not loaded yet.
            activity = worker.check_comments_activity(
                page, url, ctx, min_comments=min_comments)
            if activity.get("comments", 0) < min_comments:
                shown = f"{name} ({url})" if name else url
                note(f"Skipped {kind} (no comments): {shown} — "
                     f"{activity.get('posts', 0)} post(s), "
                     f"{activity.get('comments', 0)} comment(s) "
                     f"(need {min_comments})")
                continue
            source_id = _new_id_source()
            if kind == "group":
                try:
                    joined_ok = worker.join_group(page, url, ctx)
                except Exception:
                    joined_ok = False
                if not joined_ok:
                    note(f"Could not join group: {url} — not saved, "
                         f"try Add Source again")
                    continue
                note(f"Joined group: {url}")
            else:
                note(f"Recorded page: {url}")
            db.upsert_source(source_id, name, kind, url, member_count,
                             "joined", account_id or None)
            joined.append({
                "id": source_id,
                "name": name,
                "type": kind,
                "url": url,
                "memberCount": member_count,
                "joinedByAccountId": account_id or None,
            })
            db.update_job(job_id, posts_processed=checked,
                          new_posts=len(joined),
                          result={"sources": joined})
        if joined:
            message = (f"Joined {len(joined)} new "
                       f"{'source' if len(joined) == 1 else 'sources'} "
                       f"for '{keyword}'")
        else:
            message = (f"No new sources for '{keyword}' — every "
                       f"candidate failed the comments/member gate "
                       f"or was already joined")
        db.update_job(job_id,
                      status="stopped" if stopped else "done",
                      finished_at=_now_iso(),
                      posts_processed=checked,
                      new_posts=len(joined),
                      message=message,
                      result={"sources": joined})
    except Exception as exc:  # noqa: BLE001 - never raise out of a job
        _fail(db, job_id, exc)


def _new_id_source():
    """A fresh source id (same shape as db._new_id)."""
    import uuid

    return uuid.uuid4().hex


def delete_source(worker, page, db, source_id, should_stop=None):
    """Delete one source: leave the group / unfollow the page on
    Facebook, then remove the local record (source + its posts).

    The local record is removed ONLY when the Facebook action
    actually succeeded (or the user was already not a member).
    When the leave/unfollow FAILS, the record STAYS in the list and
    the failure is reported — silently dropping it would leave the
    user still joined with no way to retry. Ported from
    client-hunting ``HuntingManager.delete_source``. Returns
    {ok, left, detail}. Never raises.
    """
    try:
        source = db.get_source_by_id(source_id)
        if source is None:
            return {"ok": False, "left": False,
                    "detail": "Source not found."}
        kind = source.get("type") or "group"
        url = source.get("url") or ""
        left = False
        if url:
            ctx = _ctx(should_stop or (lambda: False))
            try:
                if kind == "group":
                    left = bool(worker.leave_group(page, url, ctx))
                else:
                    left = bool(worker.unfollow_page(page, url, ctx))
            except Exception:
                left = False
        if not left:
            if kind == "group":
                detail = ("Could not leave the group on Facebook — "
                          "it is still in the list, try Delete again.")
            else:
                detail = ("Could not unfollow the page on Facebook — "
                          "it is still in the list, try Delete again.")
            return {"ok": False, "left": False, "detail": detail}
        db.delete_source(source_id)
        if kind == "group":
            detail = "Left the group and removed it from the list."
        else:
            detail = "Unfollowed the page and removed it from the list."
        return {"ok": True, "left": True, "detail": detail}
    except Exception as exc:  # noqa: BLE001 - never raise
        return {"ok": False, "left": False, "detail": str(exc)}


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
