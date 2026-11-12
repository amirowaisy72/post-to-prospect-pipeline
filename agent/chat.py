"""Inbox live-chat agent — Gemini drafting + Messenger watching.

The browser hands live in ``facebook.FacebookWorker`` (open a chat from
a profile, read the inbox, read a thread, send + reload-verify). This
module is the chat brain: it drafts replies with Gemini, enforces the
safety rails, and runs one watcher pass at a time.

Safety rails (hard, all enforced here — never only in the app):
- Approval gate: the watcher only ever touches threads the app sent
  in the watch list (selected candidates). An inbox row with no
  matching approved thread is ignored entirely — never read, never
  replied to.
- Daily cap: outbound agent messages per account per day, from the
  account-age bands (see ``DAILY_CAP_BANDS``). The cap is checked
  before EVERY send, against the agent's own DB count.
- Stop: ``request_stop()`` halts the watcher mid-loop and aborts an
  in-flight first message between steps. The watch config (threads,
  script, Gemini key) is cleared on stop, so nothing can resume
  without the app re-sending it.
- Gemini key: passed per request over localhost, held in memory
  ONLY in ``_WATCH``. It is never written to disk, never logged, and
  travels to Google only in the ``x-goog-api-key`` header — never in
  a request body or a stored record.

The watcher polls Messenger about every 90 seconds (see main.py).
A candidate reply is answered only when the thread's last message
is from them (side "them", or side unknown + text different from
every agent-sent text in the thread) AND different from the last
message already handled for that thread — so one reply is never
answered twice.
"""

from __future__ import annotations

import re
import threading
import time
import uuid
from datetime import datetime, timezone

import db

__all__ = [
    "daily_cap_for_age_days",
    "draft_reply",
    "split_messages",
    "set_watch",
    "clear_watch",
    "is_watching",
    "request_stop",
    "stop_requested",
    "watch_once",
    "start_chat",
    "count_sent_today",
]

GEMINI_API_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/{model}"
    ":generateContent"
)
DEFAULT_MODEL = "gemini-3.8-flash"
WATCH_POLL_SECONDS = 90

# Daily outbound cap by account age (days), from client-hunting's
# proven daily_chat_limit: warmup (under 3 days) 0, days 3-7: 12,
# days 8-14: 25, day 15+: 45. Conservative mid values of each range.
def daily_cap_for_age_days(age_days: int) -> int:
    """Max outbound chats per day for an account of this age."""
    if age_days < 3:
        return 0
    if age_days <= 7:
        return 12
    if age_days <= 14:
        return 25
    return 45


def count_sent_today(account_id: str) -> int:
    """Agent messages marked sent today (UTC) for this account."""
    today = datetime.now(timezone.utc).date().isoformat()
    return db.count_agent_sent_on(account_id, today)


# ----------------------------------------------------------------------
# Gemini drafting (key in memory only, header only)
# ----------------------------------------------------------------------
def build_draft_prompt(script: dict, profile_name: str, source_type: str,
                       source_text: str,
                       history: list[dict]) -> str:
    """The exact prompt a Gemini call receives for the next reply.
    Same shape as the app's ``inboxPrompt`` in src/lib/mock-chat.ts."""
    if not history:
        history_text = ("(No messages yet — this is the first reply "
                        "after the opener.)")
    else:
        lines = []
        for m in history:
            who = ("Me" if m.get("role") == "agent"
                   else profile_name if m.get("role") == "candidate"
                   else "Note")
            lines.append(f"{who}: {m.get('text', '')}")
        history_text = "\n".join(lines)
    return "\n".join([
        "You are a friendly DM assistant. Follow the script below exactly.",
        "",
        f"Goal: {script.get('goal', '')}",
        f"Tone: {script.get('tone', '')}",
        f"Rules:\n{script.get('rules', '')}",
        "",
        f"The person ({profile_name}) was shortlisted from this "
        f"{source_type}: \u201c{source_text}\u201d.",
        f"Introduction used: {script.get('introduction', '')}",
        "",
        "Conversation so far:",
        history_text,
        "",
        "Write the next short message to send. Keep it under 3 short "
        "sentences. Reply with the message text only.",
    ])


def _clean_draft(text: str) -> str:
    """Strip code fences / quotes a model sometimes wraps around
    the reply, and collapse whitespace. Never raises."""
    text = (text or "").strip()
    text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    text = text.strip().strip('"').strip()
    return re.sub(r"\s+", " ", text).strip()


def draft_reply(gemini_key: str, model: str, script: dict,
                profile_name: str, source_type: str, source_text: str,
                history: list[dict], http_post=None) -> str | None:
    """Ask Gemini for the next reply. Returns the message text, or
    None when the call fails (the watcher skips that reply and
    retries next pass — a failed draft never sends a fallback).

    The key travels ONLY in the ``x-goog-api-key`` header. It is
    never in the body, never logged, never stored. ``http_post`` is
    injectable for tests (defaults to httpx.post).
    """
    if not (gemini_key or "").strip():
        return None
    import httpx

    post = http_post or httpx.post
    url = GEMINI_API_URL.format(model=(model or DEFAULT_MODEL).strip())
    try:
        resp = post(
            url,
            headers={"x-goog-api-key": gemini_key,
                     "Content-Type": "application/json"},
            json={"contents": [{"parts": [{"text": build_draft_prompt(
                script, profile_name, source_type, source_text,
                history)}]}]},
            timeout=60,
        )
    except Exception:
        return None
    try:
        if getattr(resp, "status_code", 0) != 200:
            return None
        data = resp.json()
        parts = (data.get("candidates") or [{}])[0].get("content", {}).get(
            "parts") or []
        text = "".join(p.get("text", "") for p in parts if isinstance(p, dict))
        cleaned = _clean_draft(text)
        return cleaned or None
    except Exception:
        return None


# ----------------------------------------------------------------------
# Message splitting (short messages, max 2 at a time)
# ----------------------------------------------------------------------
_SENTENCE_RE = re.compile(r"(?<=[.!?])\s+")


def split_messages(text: str, max_parts: int = 2,
                   max_chars: int = 500) -> list[str]:
    """Split a draft into at most ``max_parts`` short messages.

    Sentences are packed in order; a sentence that would overflow
    the current part starts the next one. Overflow beyond the last
    part is dropped (the Gemini prompt already asks for under 3
    short sentences, so this is a safety net, not the normal path).
    """
    text = re.sub(r"\s+", " ", (text or "").strip())
    if not text:
        return []
    sentences = [s.strip() for s in _SENTENCE_RE.split(text) if s.strip()]
    parts: list[str] = []
    current = ""
    for sentence in sentences:
        candidate = f"{current} {sentence}".strip() if current else sentence
        if len(candidate) <= max_chars:
            current = candidate
            continue
        if current:
            parts.append(current)
            if len(parts) >= max_parts:
                return parts
        current = sentence[:max_chars] if len(sentence) > max_chars else sentence
        if len(parts) >= max_parts:
            return parts
    if current and len(parts) < max_parts:
        parts.append(current)
    return parts[:max_parts]


# ----------------------------------------------------------------------
# Watcher state (in memory only — a restart forgets it; the app
# re-sends the watch list when it sees watching=false)
# ----------------------------------------------------------------------
_WATCH_LOCK = threading.Lock()
_WATCH: dict = {
    "active": False,
    "account_id": "",
    "threads": [],  # [{threadId, profileUrl, profileName, sourceType, sourceText}]
    "script": None,
    "gemini_key": None,
    "model": DEFAULT_MODEL,
    "daily_cap": 0,
}
_STOP = threading.Event()


def set_watch(config: dict) -> None:
    """Replace the watch list + script + key (memory only)."""
    with _WATCH_LOCK:
        _WATCH.update({
            "active": True,
            "account_id": config.get("accountId") or "",
            "threads": list(config.get("threads") or []),
            "script": dict(config.get("script") or {}),
            "gemini_key": config.get("geminiKey") or "",
            "model": (config.get("model") or DEFAULT_MODEL).strip(),
            "daily_cap": int(config.get("dailyCap") or 0),
        })
    _STOP.clear()


def clear_watch() -> None:
    """Forget the watch list, script AND key. Called on stop."""
    with _WATCH_LOCK:
        _WATCH.update({
            "active": False,
            "account_id": "",
            "threads": [],
            "script": None,
            "gemini_key": None,
            "model": DEFAULT_MODEL,
            "daily_cap": 0,
        })


def is_watching() -> bool:
    with _WATCH_LOCK:
        return bool(_WATCH.get("active"))


def request_stop() -> None:
    """Halt all chatting: the watcher loop and any in-flight first
    message check this between steps."""
    _STOP.set()
    clear_watch()


def stop_requested() -> bool:
    return _STOP.is_set()


def _watch_snapshot() -> dict:
    with _WATCH_LOCK:
        return {
            "active": bool(_WATCH.get("active")),
            "account_id": _WATCH.get("account_id") or "",
            "threads": [dict(t) for t in (_WATCH.get("threads") or [])],
            "script": dict(_WATCH.get("script") or {}),
            "gemini_key": _WATCH.get("gemini_key") or "",
            "model": _WATCH.get("model") or DEFAULT_MODEL,
            "daily_cap": int(_WATCH.get("daily_cap") or 0),
        }


def _new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ----------------------------------------------------------------------
# One watcher pass
# ----------------------------------------------------------------------
def watch_once(worker, page, note=None) -> dict:
    """One Messenger check. Returns a summary dict; never raises.

    Only threads in the watch list (approved candidates) are ever
    opened or replied to. A candidate reply is answered once: the
    thread's last message must be from them and different from the
    last message already handled for that thread.
    """
    summary = {"ok": False, "checked": 0, "replied": 0, "skipped": 0,
               "errors": []}
    cfg = _watch_snapshot()
    if not cfg["active"] or stop_requested():
        return summary
    note = note or (lambda msg: None)
    ctx = {
        "should_stop": lambda: stop_requested(),
        "pace": lambda: time.sleep(2.5),
        "note": note,
    }
    try:
        state = worker.verify_session(
            page, ctx, target_url="https://www.facebook.com/messages")
    except Exception as exc:  # noqa: BLE001
        summary["errors"].append(f"session check failed: {exc}")
        return summary
    if state != "ok":
        summary["errors"].append(f"session {state} — not signed in")
        return summary
    summary["ok"] = True

    approved = {t.get("threadId"): t for t in cfg["threads"]
                if t.get("threadId")}
    if not approved:
        return summary
    # Thread URLs come from the DB (learned at chat start) — the
    # watcher matches inbox rows by exact thread URL, never by name.
    stored = {}
    for thread_id in approved:
        row = db.get_chat_thread(thread_id)
        if row and row.get("messenger_thread_url"):
            stored[row["messenger_thread_url"]] = (thread_id, row)
    if not stored:
        return summary

    rows = worker.read_messenger_threads(page, ctx, "inbox")
    rows_by_url = {r.get("thread_url"): r for r in rows if r.get("thread_url")}
    # Approved threads missing from the inbox may sit in Message
    # Requests (a stranger's first reply lands there until accepted).
    missing = [u for u in stored if u not in rows_by_url]
    if missing:
        req_rows = worker.read_messenger_threads(page, ctx, "message_requests")
        for r in req_rows:
            if r.get("thread_url") in stored:
                rows_by_url[r["thread_url"]] = r

    for thread_url, (thread_id, row) in stored.items():
        if stop_requested():
            break
        inbox_row = rows_by_url.get(thread_url)
        if inbox_row is None:
            continue  # thread not visible right now — skip quietly
        summary["checked"] += 1
        last_seen = row.get("last_seen_text") or ""
        last_text = (inbox_row.get("last_text") or "").strip()
        agent_texts = {m["text"] for m in
                       db.list_chat_messages(thread_id)
                       if m.get("role") == "agent"
                       and m.get("delivery") == "sent"}
        # Cheap skip: the row snippet matches what we already handled
        # and the thread is not marked unread.
        if (not inbox_row.get("unread") and last_text
                and (last_text == last_seen or last_text in agent_texts)):
            continue
        messages = worker.read_thread_messages(page, thread_url, ctx)
        if stop_requested():
            break
        if not messages:
            continue
        last = messages[-1]
        last_msg_text = (last.get("text") or "").strip()
        if not last_msg_text or last_msg_text == last_seen:
            continue  # already handled
        side = last.get("side") or "unknown"
        if side == "me" or last_msg_text in agent_texts:
            # Our own message is last — record it and move on.
            db.set_chat_thread(thread_id, last_seen_text=last_msg_text)
            continue
        if side not in ("them", "unknown"):
            continue
        # Candidate replied — record it (dedupe by text: one stored
        # copy of the latest candidate message is enough).
        existing = db.list_chat_messages(thread_id)
        if not any(m.get("role") == "candidate"
                   and m.get("text") == last_msg_text
                   for m in existing):
            db.save_chat_message(
                _new_id("msg"), thread_id, "candidate", last_msg_text,
                "received", sent_at=_now_iso(), created_at=_now_iso())
        # Cap: checked before EVERY send.
        if count_sent_today(cfg["account_id"]) >= cfg["daily_cap"]:
            summary["skipped"] += 1
            note(f"chat: daily limit reached ({cfg['daily_cap']}) — "
                 f"skipping reply to {row.get('profile_name')}")
            db.set_chat_thread(thread_id, last_seen_text=last_msg_text)
            continue
        history = [{"role": m.get("role"), "text": m.get("text") or ""}
                   for m in existing]
        history.append({"role": "candidate", "text": last_msg_text})
        draft = draft_reply(
            cfg["gemini_key"], cfg["model"], cfg["script"],
            row.get("profile_name") or "", row.get("source_type") or "comment",
            row.get("source_text") or "", history)
        if not draft:
            summary["skipped"] += 1
            note("chat: Gemini draft failed — will retry next pass")
            continue
        sent_any = False
        for part in split_messages(draft):
            if stop_requested():
                break
            if count_sent_today(cfg["account_id"]) >= cfg["daily_cap"]:
                summary["skipped"] += 1
                break
            ok, detail = worker.send_thread_message(
                page, thread_url, part, ctx)
            db.save_chat_message(
                _new_id("msg"), thread_id, "agent", part,
                "sent" if ok else "failed",
                sent_at=_now_iso() if ok else None, created_at=_now_iso())
            if not ok:
                summary["errors"].append(
                    f"send failed for {row.get('profile_name')}: {detail}")
                break
            sent_any = True
        if sent_any:
            summary["replied"] += 1
        db.set_chat_thread(thread_id, last_seen_text=last_msg_text)
    return summary


# ----------------------------------------------------------------------
# First message (chat start)
# ----------------------------------------------------------------------
def start_chat(worker, page, payload: dict, note=None) -> dict:
    """Send the first message to a newly approved candidate.

    ``payload``: {accountId, threadId, messageId, profileUrl,
    profileName, sourceType, sourceText, firstMessage, script,
    geminiKey, model, dailyCap}. Returns {"ok", "threadUrl",
    "inRequests", "detail"}. The app's thread/message ids are stored
    so GET /chat/threads can report delivery against them. Never
    raises.
    """
    note = note or (lambda msg: None)
    thread_id = payload.get("threadId") or ""
    message_id = payload.get("messageId") or ""
    account_id = payload.get("accountId") or ""
    profile_url = (payload.get("profileUrl") or "").strip()
    first_message = (payload.get("firstMessage") or "").strip()
    cap = int(payload.get("dailyCap") or 0)
    result = {"ok": False, "threadUrl": None, "inRequests": False,
              "detail": ""}
    if not thread_id or not profile_url or not first_message:
        result["detail"] = "threadId, profileUrl and firstMessage are required"
        return result
    # The row exists from here on, so every failure path below is
    # visible to the app via GET /chat/threads.
    db.upsert_chat_thread(
        thread_id, account_id, profile_url,
        payload.get("profileName") or "", payload.get("sourceType") or "comment",
        payload.get("sourceText") or "", status="starting")
    if count_sent_today(account_id) >= cap:
        result["detail"] = (f"daily limit reached ({cap} messages today) — "
                            "no outbound")
        db.set_chat_thread(thread_id, status="failed",
                           last_error=result["detail"])
        return result
    ctx = {
        "should_stop": lambda: stop_requested(),
        "pace": lambda: time.sleep(2.5),
        "note": note,
    }
    try:
        state = worker.verify_session(page, ctx, target_url=profile_url)
    except Exception as exc:  # noqa: BLE001
        result["detail"] = f"session check failed: {exc}"
        return result
    if state != "ok":
        result["detail"] = (f"Facebook session {state} — sign in to "
                            "Facebook in the agent Chrome window")
        db.set_chat_thread(thread_id, status="failed",
                           last_error=result["detail"])
        return result
    thread_url, detail = worker.open_chat_with_profile(page, profile_url, ctx)
    if not thread_url:
        result["detail"] = f"could not open a chat: {detail}"
        db.set_chat_thread(thread_id, status="failed",
                           last_error=result["detail"])
        return result
    result["threadUrl"] = thread_url
    db.set_chat_thread(thread_id, messenger_thread_url=thread_url)
    if stop_requested():
        result["detail"] = "stopped before sending"
        return result
    sent_any = False
    last_error = ""
    parts = split_messages(first_message)
    for index, part in enumerate(parts):
        if stop_requested():
            result["detail"] = "stopped before sending"
            return result
        if count_sent_today(account_id) >= cap:
            result["detail"] = (f"daily limit reached ({cap} messages "
                                "today) — stopped")
            break
        ok, detail = worker.send_thread_message(page, thread_url, part, ctx)
        part_id = message_id if (index == 0 and message_id) else _new_id("msg")
        db.save_chat_message(
            part_id, thread_id, "agent", part,
            "sent" if ok else "failed",
            sent_at=_now_iso() if ok else None, created_at=_now_iso())
        if not ok:
            last_error = detail
            break
        sent_any = True
    if not sent_any:
        result["detail"] = f"first message failed: {last_error or 'unknown'}"
        db.set_chat_thread(thread_id, status="failed",
                           last_error=result["detail"])
        return result
    # A first message to a stranger lands in Message Requests until
    # they accept — check honestly and report it.
    try:
        req_rows = worker.read_messenger_threads(page, ctx, "message_requests")
        result["inRequests"] = any(
            r.get("thread_url") == thread_url for r in req_rows)
    except Exception:
        result["inRequests"] = False
    db.set_chat_thread(thread_id, status="active", last_seen_text=first_message)
    result["ok"] = True
    result["detail"] = ("sent (in Message Requests — they have not "
                        "accepted yet)" if result["inRequests"]
                        else "sent and confirmed")
    return result
