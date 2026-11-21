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

import ai_models
import questions
import followups

import chat_open
import db

__all__ = [
    "daily_cap_for_age_days",
    "session_message",
    "draft_reply",
    "split_messages",
    "set_watch",
    "clear_watch",
    "is_watching",
    "watch_account_id",
    "request_stop",
    "stop_requested",
    "watch_once",
    "start_chat",
    "count_sent_today",
]

GEMINI_API_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/{model}" ":generateContent"
)
DEFAULT_MODEL = "gemini-3.8-flash"
WATCH_POLL_SECONDS = 10


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


def session_message(state: str) -> str:
    """Plain, TRUE one-liner for a broken session state (mirrors
    jobs._SESSION_ERRORS). "empty" is a page-load failure, never
    proof the session is dead — so it never says "sign in". Only
    "logged_out" asks the user to sign in again."""
    if state == "logged_out":
        return (
            "Facebook session is not signed in — please sign in to "
            "Facebook from Agent Control (Sign in button). The agent "
            "never asks for or stores your Facebook password."
        )
    if state == "checkpoint":
        return (
            "Facebook is asking for a checkpoint / identity check "
            "(state: checkpoint) — please complete the check in a "
            "browser, then try again."
        )
    if state == "blocked":
        return (
            "Facebook blocked the agent browser (state: blocked) — "
            "please open Facebook in a browser and check for a "
            "warning, then try again."
        )
    return (
        "Facebook page did not load (state: empty) — the browser "
        "may still be signed in; relaunch the browser from Agent "
        "Control and try again."
    )


# ----------------------------------------------------------------------
# Gemini drafting (key in memory only, header only)
# ----------------------------------------------------------------------
def build_draft_prompt(
    script: dict,
    profile_name: str,
    source_type: str,
    source_text: str,
    history: list[dict],
) -> str:
    """The exact prompt a Gemini call receives for the next reply.
    Same shape as the app's ``inboxPrompt`` in src/lib/mock-chat.ts."""
    if not history:
        history_text = (
            "(No messages yet — this is the first reply " "after the opener.)"
        )
    else:
        lines = []
        for m in history:
            who = (
                "Me"
                if m.get("role") == "agent"
                else profile_name if m.get("role") == "candidate" else "Note"
            )
            lines.append(f"{who}: {m.get('text', '')}")
        history_text = "\n".join(lines)
    return "\n".join(
        [
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
        ]
    )


def _clean_draft(text: str) -> str:
    """Strip code fences / quotes a model sometimes wraps around
    the reply, and collapse whitespace. Never raises."""
    text = (text or "").strip()
    text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    text = text.strip().strip('"').strip()
    parts = re.split(r"(?:^|\s)Me:\s*", text)
    if len(parts) > 1:
        text = parts[-1].strip()
    text = (
        re.sub(
            r"^(let'?s keep the conversation going\.?\s*)?((here'?s|here is)[^:]{0,40}:\s*)?",
            "",
            text,
            flags=re.I,
        )
        .strip()
        .strip('"')
        .strip()
    )
    return re.sub(r"\s+", " ", text).strip()


def draft_reply(
    gemini_key,
    model,
    script,
    profile_name,
    source_type,
    source_text,
    history,
    http_post=None,
    provider="gemini",
    ollama_url="",
):
    prompt = build_draft_prompt(script, profile_name, source_type, source_text, history)
    prompt += (
        _EXTRA_RULES
        + _SCHEDULE_RULE
        + "\nCurrent local time: "
        + time.strftime("%Y-%m-%d %H:%M, %A")
    )
    print("chat: drafting with", provider, model)
    text, err = ai_models.generate(
        provider, model, gemini_key, ollama_url, prompt, http_post=http_post
    )
    if err:
        print("chat: AI draft failed:", err)
        return None
    return _clean_draft(text) or None


def _draft_reply_old(
    gemini_key: str,
    model: str,
    script: dict,
    profile_name: str,
    source_type: str,
    source_text: str,
    history: list[dict],
    http_post=None,
) -> str | None:
    """Ask Gemini for the next reply. Returns the message text, or
    None when the call fails (the watcher skips that reply and
    retries next pass — a failed draft never sends a fallback).

    The key travels ONLY in the ``x-goog-api-key`` header. It is
    never in the body, never logged, never stored. ``http_post`` is
    injectable for tests (defaults to httpx.post).
    """
    if not (gemini_key or "").strip():
        print("chat: Gemini key missing - the app did not send a key")
        return None
    import httpx

    _p = http_post or httpx.post

    def post(*a, **k):
        try:
            return _p(*a, **k)
        except Exception as e:
            print("chat: Gemini request error:", type(e).__name__, e)
            raise

    url = GEMINI_API_URL.format(
        model=(
            model if (model or "").strip().startswith("gemini") else DEFAULT_MODEL
        ).strip()
    )
    try:
        resp = post(
            url,
            headers={"x-goog-api-key": gemini_key, "Content-Type": "application/json"},
            json={
                "contents": [
                    {
                        "parts": [
                            {
                                "text": build_draft_prompt(
                                    script,
                                    profile_name,
                                    source_type,
                                    source_text,
                                    history,
                                )
                            }
                        ]
                    }
                ]
            },
            timeout=180,
        )
    except Exception:
        return None
    try:
        if getattr(resp, "status_code", 0) != 200:
            print(
                "chat: Gemini HTTP",
                getattr(resp, "status_code", "?"),
                str(getattr(resp, "text", ""))[:200],
            )
            return None
        data = resp.json()
        parts = (data.get("candidates") or [{}])[0].get("content", {}).get(
            "parts"
        ) or []
        text = "".join(p.get("text", "") for p in parts if isinstance(p, dict))
        cleaned = _clean_draft(text)
        if not cleaned:
            print("chat: Gemini empty reply", str(data)[:300])
        return cleaned or None
    except Exception:
        return None


# ----------------------------------------------------------------------
# Message splitting (short messages, max 2 at a time)
# ----------------------------------------------------------------------
_SENTENCE_RE = re.compile(r"(?<=[.!?])\s+")


def split_messages(text: str, max_parts: int = 2, max_chars: int = 500) -> list[str]:
    """Split a draft into at most ``max_parts`` short messages.

    Sentences are packed in order; a sentence that would overflow
    the current part starts the next one. Overflow beyond the last
    part is dropped (the Gemini prompt already asks for under 3
    short sentences, so this is a safety net, not the normal path).
    """
    text = (
        re.sub(r"\s*[\u2014\u2013]\s*", ", ", (text or ""))
        .replace("\u201c", '"')
        .replace("\u201d", '"')
        .replace("\u2018", "'")
        .replace("\u2019", "'")
        .replace("\u2026", "...")
    )
    text = re.sub(r"\s+", " ", text.strip())
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
        _WATCH.update(
            {
                "active": True,
                "account_id": config.get("accountId") or "",
                "threads": list(config.get("threads") or []),
                "script": dict(config.get("script") or {}),
                "gemini_key": config.get("geminiKey") or "",
                "model": (config.get("model") or DEFAULT_MODEL).strip(),
                "provider": config.get("provider") or "gemini",
                "ollama_url": config.get("ollamaUrl") or "",
                "daily_cap": int(config.get("dailyCap") or 0),
            }
        )
    _STOP.clear()


def clear_watch() -> None:
    """Forget the watch list, script AND key. Called on stop."""
    with _WATCH_LOCK:
        _WATCH.update(
            {
                "active": False,
                "account_id": "",
                "threads": [],
                "script": None,
                "gemini_key": None,
                "model": DEFAULT_MODEL,
                "daily_cap": 0,
            }
        )


def is_watching() -> bool:
    with _WATCH_LOCK:
        return bool(_WATCH.get("active"))


def watch_account_id() -> str:
    """Account id of the current watch list ("" when not watching)."""
    with _WATCH_LOCK:
        return _WATCH.get("account_id") or ""


def watched_count() -> int:
    """How many threads the watcher is watching right now."""
    with _WATCH_LOCK:
        return len(_WATCH.get("threads") or [])


def request_stop() -> None:
    """Halt all chatting: the watcher loop and any in-flight first
    message check this between steps."""
    _STOP.set()
    clear_watch()


def stop_requested() -> bool:
    return _STOP.is_set()


# Threads the app deleted (POST /chat/forget). A forgotten thread's
# in-flight send aborts at its next stop check and its failure paths
# save nothing — so deleting a stuck thread can never send a message
# afterwards, and a later abort cannot resurrect its rows. Unlike the
# global _STOP flag, this is per-thread and is never cleared by a
# later set_watch, so a re-synced watcher cannot resume it.
_FORGOTTEN_THREADS: set[str] = set()
_FORGOTTEN_LOCK = threading.Lock()


def mark_thread_forgotten(thread_id: str) -> None:
    """Mark a thread forgotten (stops its in-flight send) and drop it
    from the watch list. The DB rows go in forget_thread, after the
    send had a moment to stop."""
    if not thread_id:
        return
    with _FORGOTTEN_LOCK:
        _FORGOTTEN_THREADS.add(thread_id)
    with _WATCH_LOCK:
        _WATCH["threads"] = [
            t for t in (_WATCH.get("threads") or []) if t.get("threadId") != thread_id
        ]


def thread_forgotten(thread_id: str) -> bool:
    """True when the app deleted this thread (POST /chat/forget)."""
    with _FORGOTTEN_LOCK:
        return thread_id in _FORGOTTEN_THREADS


def forget_thread(thread_id: str) -> bool:
    """Forget a deleted thread completely: mark it forgotten (its
    send aborts, it leaves the watch list), delete its DB rows, and
    clear its send-stage trail. Returns True when the agent knew the
    thread at all (a DB row, a watch entry, or a stage trail)."""
    if not thread_id:
        return False
    with _WATCH_LOCK:
        in_watch = any(
            t.get("threadId") == thread_id for t in (_WATCH.get("threads") or [])
        )
    # Message ids first: the rows are gone after the delete, and the
    # stage trail is keyed by message id, not thread id.
    message_ids = [m.get("id") for m in db.list_chat_messages(thread_id)]
    with _SEND_STAGE_LOCK:
        had_stage = any(
            mid in _SEND_STAGE or mid in _SEND_STAGE_HISTORY
            for mid in message_ids
            if mid
        )
    mark_thread_forgotten(thread_id)
    deleted = db.delete_chat_thread(thread_id)
    followups.clear(thread_id)
    for mid in message_ids:
        if mid:
            clear_send_stage(mid)
    return bool(deleted or in_watch or had_stage)


def _watch_snapshot() -> dict:
    with _WATCH_LOCK:
        return {
            "active": bool(_WATCH.get("active")),
            "account_id": _WATCH.get("account_id") or "",
            "threads": [dict(t) for t in (_WATCH.get("threads") or [])],
            "script": dict(_WATCH.get("script") or {}),
            "gemini_key": _WATCH.get("gemini_key") or "",
            "model": _WATCH.get("model") or DEFAULT_MODEL,
            "provider": _WATCH.get("provider") or "gemini",
            "ollama_url": _WATCH.get("ollama_url") or "",
            "daily_cap": int(_WATCH.get("daily_cap") or 0),
        }


def _new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ----------------------------------------------------------------------
# Send stages (first-message send only, start_chat)
#
# The app shows a static "Sending to Messenger…" while the send runs,
# so a stall is invisible. Every real step of the send records a
# short plain-word stage with a timestamp, printed to the agent
# console as well — a stall names its exact step instead of one
# frozen caption. In-memory only: an agent restart clears the trail
# and the app falls back to "Sending…" until a new stage arrives.
# ----------------------------------------------------------------------
SEND_STAGES = (
    "queued",
    "opening browser",
    "checking session",
    "opening chat",
    "typing message",
    "verifying sent",
    "sent",
    "failed",
)

_SEND_STAGE: dict[str, dict] = {}
_SEND_STAGE_HISTORY: dict[str, list] = {}
_SEND_STAGE_LOCK = threading.Lock()


def set_send_stage(message_id: str, stage: str, detail: str = "") -> None:
    """Record the send's current stage (in-memory + agent console).

    Re-setting the same stage is a no-op, so the clock keeps the
    moment the send first entered this stage.
    """
    if not message_id or stage not in SEND_STAGES:
        return
    now = _now_iso()
    with _SEND_STAGE_LOCK:
        current = _SEND_STAGE.get(message_id)
        if current and current.get("stage") == stage:
            return
        _SEND_STAGE[message_id] = {"stage": stage, "since": now, "detail": detail or ""}
        _SEND_STAGE_HISTORY.setdefault(message_id, []).append(
            {"stage": stage, "since": now, "detail": detail or ""}
        )
    short = message_id[-8:] if len(message_id) > 8 else message_id
    suffix = f" — {detail}" if detail else ""
    print(f"[leadhunter] send {short}: {stage}{suffix}", flush=True)


def get_send_stage(message_id: str) -> dict | None:
    """Current stage for a message id, or None when never started."""
    with _SEND_STAGE_LOCK:
        row = _SEND_STAGE.get(message_id or "")
        return dict(row) if row else None


def get_send_stage_history(message_id: str) -> list:
    """Stage trail in order (diagnostics / tests)."""
    with _SEND_STAGE_LOCK:
        return [dict(r) for r in _SEND_STAGE_HISTORY.get(message_id or "", [])]


def clear_send_stage(message_id: str) -> None:
    """Drop a message's stage + trail (its thread was deleted)."""
    if not message_id:
        return
    with _SEND_STAGE_LOCK:
        _SEND_STAGE.pop(message_id, None)
        _SEND_STAGE_HISTORY.pop(message_id, None)


# ----------------------------------------------------------------------
# One watcher pass
# ----------------------------------------------------------------------
_HISTORY_DONE: set = set()


def _import_history(thread_id, messages):
    """Copy the real Messenger history into the app (deduped by text)."""
    have = {
        (m.get("role"), (m.get("text") or "").strip())
        for m in db.list_chat_messages(thread_id)
    }
    n = len(messages)
    for i, m in enumerate(messages):
        text = (m.get("text") or "").strip()
        role = {"me": "agent", "them": "candidate"}.get(m.get("side"))
        if not text or not role or (role, text) in have or _is_system_text(text):
            continue
        have.add((role, text))
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - (n - i) * 2))
        db.save_chat_message(
            _new_id("msg"),
            thread_id,
            role,
            text,
            "sent" if role == "agent" else "received",
            sent_at=None if role == "agent" else ts,
            created_at=ts,
        )


_LAST_HB = None
_ACTIVITY = {"state": "idle", "detail": ""}


def set_activity(state, detail=""):
    _ACTIVITY.update({"state": state, "detail": detail})


def get_activity():
    return dict(_ACTIVITY)


_SYSTEM_PREFIXES = (
    "messages and calls are secured",
    "you can now message",
    "you can now call",
    "active now",
    "active today",
    "say hi to",
    "you're now connected",
    "waved at",
)
_STOP_RE = re.compile(
    r"(stop (messag|text|contact)|not interested|leave me alone|"
    r"don'?t (message|text|contact)|do not (message|text|contact)|"
    r"unsubscribe|report you|block you)",
    re.I,
)
_EXTRA_RULES = "\n".join(
    [
        "",
        "Extra rules:",
        "- There may be several unanswered messages from the person. Answer all of them naturally in ONE short reply.",
        "- Read the whole conversation first. Never repeat a question or offer you already made.",
        "- Ask at most one question per message. Write like a normal person texting. Never use long dashes.",
        "- If the person only says thanks, ok or an emoji and nothing needs an answer, reply with exactly: NO_REPLY",
        "- If you cannot answer from the script or are unsure, reply with exactly: ASK_USER: <the question for the human owner, one line>",
        "- If the person says they are not interested or want to be left alone, reply with exactly: END_CHAT",
        "- Output ONLY the words of your next message. Never write 'Me:', any name with a colon, or any part of the conversation history.",
        "- Never start with an intro such as 'Let's keep the conversation going' or 'Here's my next message'. Start directly with the message itself.",
        "- If the person asks whether you are a bot, an AI or a real human, NEVER claim to be human. Say honestly that you are an AI assistant helping on behalf of the owner.",
    ]
)


_SCHEDULE_RULE = (
    "\n- If the person says they will talk or decide later (for example tomorrow, tonight, "
    "in 2 hours), reply with exactly: SCHEDULE: YYYY-MM-DD HH:MM | <short friendly message "
    "acknowledging it>. Use the current local time given below to work out the date and time."
)


def _is_system_text(t):
    low = (t or "").strip().lower()
    return (
        (not low)
        or low.startswith(_SYSTEM_PREFIXES)
        or low in ("messenger", "unread message", "new message")
    )


def _row_text(raw):
    """Inbox row snippet -> (text, mine). Strips time, 'Unread message:', 'You:'."""
    t = (raw or "").strip()
    t = re.sub(r"\s*·\s*\d+\s*(s|m|h|d|w|y|min|hr)\w*$", "", t).strip()
    t = re.sub(r"^(unread message|new message)\s*:\s*", "", t, flags=re.I).strip()
    mine = t.startswith("You:")
    if mine:
        t = t[4:].strip()
    return t, mine


def _unreplied_batch(real, row_text, known):
    """Their messages since our last one (newest last). The row text is the truth for the last."""
    batch = []
    for m in reversed(real or []):
        if m.get("side") == "me":
            break
        t = (m.get("text") or "").strip()
        if m.get("side") == "them" and t and not _is_system_text(t) and t not in known:
            batch.append(t)
    batch.reverse()
    if row_text and row_text not in batch:
        batch.append(row_text)
    return batch


def _human_wait(note, who):
    import random

    secs = random.randint(3, 8)
    note(f"chat: waiting {secs}s before replying to {who}")
    for _ in range(secs):
        if stop_requested():
            return
        time.sleep(1)


def _watch_thread(
    worker, page, ctx, cfg, note, summary, thread_url, thread_id, row, inbox_row
):
    set_activity("busy", "Reply: " + str(row.get("profile_name") or ""))
    try:
        return _watch_thread_inner(
            worker, page, ctx, cfg, note, summary, thread_url, thread_id, row, inbox_row
        )
    finally:
        set_activity("idle")


def _watch_thread_inner(
    worker, page, ctx, cfg, note, summary, thread_url, thread_id, row, inbox_row
):
    name = row.get("profile_name") or ""
    ctx["profile_name"] = name
    owner_note = questions.take_answer(thread_id)
    if not owner_note and followups.take_due(thread_id):
        owner_note = "The time the person asked for has now arrived. Write a short, natural follow-up message that continues the conversation."
    if questions.is_pending(thread_id) and not owner_note:
        return
    last_seen = row.get("last_seen_text") or ""
    last_text, mine = _row_text(inbox_row.get("last_text"))
    first_pass = thread_id not in _HISTORY_DONE
    need_reply = (
        bool(last_text)
        and not mine
        and not _is_system_text(last_text)
        and last_text != last_seen
    )
    if not (first_pass or need_reply or owner_note):
        return
    if (need_reply or owner_note) and count_sent_today(cfg["account_id"]) >= cfg[
        "daily_cap"
    ]:
        summary["skipped"] += 1
        note(f"chat: daily limit reached ({cfg['daily_cap']}) - not replying to {name}")
        return
    if (
        need_reply
        and last_text
        and not any(
            m.get("role") == "candidate" and m.get("text") == last_text
            for m in db.list_chat_messages(thread_id)
        )
    ):
        db.save_chat_message(
            _new_id("msg"),
            thread_id,
            "candidate",
            last_text,
            "received",
            sent_at=_now_iso(),
            created_at=_now_iso(),
        )
    if need_reply and not owner_note:
        _human_wait(note, name)
    real = []
    if first_pass or need_reply:
        real = worker.read_thread_messages(page, thread_url, ctx)
    if first_pass:
        _HISTORY_DONE.add(thread_id)
        if real:
            _import_history(thread_id, real)
    if stop_requested() or not (need_reply or owner_note):
        return
    existing = db.list_chat_messages(thread_id)
    known = {m.get("text") for m in existing if m.get("role") == "candidate"}
    batch = _unreplied_batch(real, last_text if need_reply else "", known)
    if need_reply and not batch:
        db.set_chat_thread(thread_id, last_seen_text=last_text)
        return
    for t in batch:
        if t not in known:
            db.save_chat_message(
                _new_id("msg"),
                thread_id,
                "candidate",
                t,
                "received",
                sent_at=_now_iso(),
                created_at=_now_iso(),
            )
    if batch and _STOP_RE.search(" ".join(batch)):
        note(f"chat: {name} declined - closing chat")
        db.set_chat_thread(thread_id, status="done", last_seen_text=last_text)
        return
    existing = db.list_chat_messages(thread_id)
    history = [{"role": m.get("role"), "text": m.get("text") or ""} for m in existing][
        -30:
    ]
    if owner_note:
        history.append(
            {"role": "note", "text": f"The owner tells you how to answer: {owner_note}"}
        )
    draft = draft_reply(
        cfg["gemini_key"],
        cfg["model"],
        cfg["script"],
        name,
        row.get("source_type") or "comment",
        row.get("source_text") or "",
        history,
        provider=cfg.get("provider", "gemini"),
        ollama_url=cfg.get("ollama_url", ""),
    )
    if not draft:
        summary["skipped"] += 1
        note("chat: AI draft failed - retrying next pass")
        return
    up = draft.strip().upper()
    if up.startswith("SCHEDULE"):
        parsed = followups.parse(draft)
        if not parsed:
            note(f"chat: could not understand {name}'s schedule - skipping")
            db.set_chat_thread(thread_id, last_seen_text=last_text)
            return
        followups.save(thread_id, name, parsed[0])
        note(f"chat: follow-up with {name} scheduled for {parsed[0]}")
        draft = parsed[1]
    if up.startswith("NO_REPLY"):
        note(f"chat: {name} does not need a reply")
        db.set_chat_thread(thread_id, last_seen_text=last_text)
        return
    if up.startswith("END_CHAT"):
        note(f"chat: {name} wants to end the chat")
        db.set_chat_thread(thread_id, status="done", last_seen_text=last_text)
        return
    if up.startswith("ASK_USER"):
        q = draft.split(":", 1)[1].strip() if ":" in draft else ""
        questions.ask(
            thread_id, name, batch or [last_text], q or "What should I reply to this?"
        )
        note(f"chat: asking you about {name}")
        db.set_chat_thread(thread_id, last_seen_text=last_text)
        return
    sent_any = False
    last_part = ""
    for part in split_messages(draft):
        if stop_requested():
            break
        if count_sent_today(cfg["account_id"]) >= cfg["daily_cap"]:
            summary["skipped"] += 1
            break
        ok, detail = worker.send_thread_message(page, thread_url, part, ctx)
        db.save_chat_message(
            _new_id("msg"),
            thread_id,
            "agent",
            part,
            "sent" if ok else "failed",
            sent_at=_now_iso() if ok else None,
            created_at=_now_iso(),
        )
        if not ok:
            summary["errors"].append(f"send failed for {name}: {detail}")
            break
        sent_any = True
        last_part = part
    if sent_any:
        summary["replied"] += 1
        db.set_chat_thread(thread_id, last_seen_text=last_part)


def watch_once(worker, page, note=None) -> dict:
    """One human-like Messenger check."""
    global _LAST_HB
    _s = _watch_snapshot()
    hb = (_s["active"], len(_s["threads"]))
    if hb != _LAST_HB:
        _LAST_HB = hb
        print("chat: watch state active=%s threads=%s" % hb, flush=True)
    summary = {"ok": False, "checked": 0, "replied": 0, "skipped": 0, "errors": []}
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
            page, ctx, target_url="https://www.facebook.com/messages"
        )
    except Exception as exc:  # noqa: BLE001
        summary["errors"].append(f"session check failed: {exc}")
        return summary
    if state != "ok":
        summary["errors"].append(session_message(state))
        return summary
    summary["ok"] = True
    approved = {t.get("threadId"): t for t in cfg["threads"] if t.get("threadId")}
    if not approved:
        return summary
    stored = {}
    for thread_id in approved:
        row = db.get_chat_thread(thread_id)
        if row and row.get("messenger_thread_url") and row.get("status") != "done":
            stored[row["messenger_thread_url"]] = (thread_id, row)
    if not stored:
        return summary
    rows = worker.read_messenger_threads(page, ctx, "inbox")
    rows_by_url = {r.get("thread_url"): r for r in rows if r.get("thread_url")}
    if [u for u in stored if u not in rows_by_url]:
        for r in worker.read_messenger_threads(page, ctx, "message_requests"):
            if r.get("thread_url") in stored:
                rows_by_url[r["thread_url"]] = r
    for su in list(stored):
        if su in rows_by_url:
            continue
        tid, srow = stored[su]
        nm = (srow.get("profile_name") or "").strip().lower()
        hits = [
            r
            for r in rows
            if nm
            and (r.get("name") or "").strip()
            and r.get("thread_url") not in stored
            and (
                nm in (r.get("name") or "").lower()
                or (r.get("name") or "").lower() in nm
            )
        ]
        if len(hits) == 1:
            new = hits[0]["thread_url"]
            db.set_chat_thread(tid, messenger_thread_url=new)
            stored[new] = stored.pop(su)
            rows_by_url[new] = hits[0]
            note(f"chat: watch re-linked {nm} -> {new}")
    for thread_url, (thread_id, row) in list(stored.items()):
        if stop_requested():
            break
        inbox_row = rows_by_url.get(thread_url)
        if inbox_row is None:
            continue
        summary["checked"] += 1
        try:
            _watch_thread(
                worker,
                page,
                ctx,
                cfg,
                note,
                summary,
                thread_url,
                thread_id,
                row,
                inbox_row,
            )
        except Exception as exc:  # noqa: BLE001
            summary["errors"].append(f"{row.get('profile_name')}: {exc}")
            note(f"chat: thread error {exc}")
    return summary


def _watch_once_old(worker, page, note=None) -> dict:
    """One Messenger check. Returns a summary dict; never raises.

    Only threads in the watch list (approved candidates) are ever
    opened or replied to. A candidate reply is answered once: the
    thread's last message must be from them and different from the
    last message already handled for that thread.
    """
    summary = {"ok": False, "checked": 0, "replied": 0, "skipped": 0, "errors": []}
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
            page, ctx, target_url="https://www.facebook.com/messages"
        )
    except Exception as exc:  # noqa: BLE001
        summary["errors"].append(f"session check failed: {exc}")
        return summary
    if state != "ok":
        summary["errors"].append(session_message(state))
        return summary
    summary["ok"] = True

    approved = {t.get("threadId"): t for t in cfg["threads"] if t.get("threadId")}
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
    note(
        f"chat: watch inbox rows={len(rows)} names={[(r.get('name'), (r.get('thread_url') or '')[-22:]) for r in rows[:6]]} stored={list(stored)}"
    )
    rows_by_url = {r.get("thread_url"): r for r in rows if r.get("thread_url")}
    # Approved threads missing from the inbox may sit in Message
    # Requests (a stranger's first reply lands there until accepted).
    missing = [u for u in stored if u not in rows_by_url]
    if missing:
        req_rows = worker.read_messenger_threads(page, ctx, "message_requests")
        for r in req_rows:
            if r.get("thread_url") in stored:
                rows_by_url[r["thread_url"]] = r

    for su in list(stored):
        if su in rows_by_url:
            continue
        tid, srow = stored[su]
        nm = (srow.get("profile_name") or "").strip().lower()
        hits = [
            r
            for r in rows
            if nm
            and (r.get("name") or "").strip()
            and r.get("thread_url") not in stored
            and (
                nm in (r.get("name") or "").lower()
                or (r.get("name") or "").lower() in nm
            )
        ]
        if len(hits) == 1:
            new = hits[0]["thread_url"]
            db.set_chat_thread(tid, messenger_thread_url=new)
            stored[new] = stored.pop(su)
            rows_by_url[new] = hits[0]
            note(f"chat: watch re-linked {nm} -> {new}")

    for thread_url, (thread_id, row) in stored.items():
        if stop_requested():
            break
        inbox_row = rows_by_url.get(thread_url)
        note(f"chat: watch row for {thread_url} -> {inbox_row}")
        if inbox_row is None:
            continue  # thread not visible right now — skip quietly
        summary["checked"] += 1
        last_seen = row.get("last_seen_text") or ""
        last_text = (inbox_row.get("last_text") or "").strip()
        last_text = re.sub(
            r"\s*·\s*\d+\s*(s|m|h|d|w|y|min|hr)\w*$", "", last_text
        ).strip()
        mine = last_text.startswith("You:")
        if mine:
            last_text = last_text[4:].strip()
        agent_texts = {
            m["text"]
            for m in db.list_chat_messages(thread_id)
            if m.get("role") == "agent" and m.get("delivery") == "sent"
        }
        # Cheap skip: the row snippet matches what we already handled
        # and the thread is not marked unread.
        if (
            thread_id in _HISTORY_DONE
            and not inbox_row.get("unread")
            and last_text
            and (mine or last_text == last_seen or last_text in agent_texts)
        ):
            continue
        messages = []
        real = False
        if thread_id not in _HISTORY_DONE:
            messages = worker.read_thread_messages(page, thread_url, ctx)
            real = bool(messages)
            _HISTORY_DONE.add(thread_id)
        ok_row = bool(last_text) and not last_text.startswith(
            "Messages and calls are secured"
        )
        if ok_row and (
            not messages
            or (
                real
                and not mine
                and (messages[-1].get("text") or "").strip() != last_text
            )
        ):
            messages = messages + [
                {"text": last_text, "side": "me" if mine else "them"}
            ]
        note(
            f"chat: watch read {len(messages)} msgs, last={messages[-1] if messages else None}"
        )
        if real:
            _import_history(thread_id, messages)
            _HISTORY_DONE.add(thread_id)
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
        if not any(
            m.get("role") == "candidate" and m.get("text") == last_msg_text
            for m in existing
        ):
            db.save_chat_message(
                _new_id("msg"),
                thread_id,
                "candidate",
                last_msg_text,
                "received",
                sent_at=_now_iso(),
                created_at=_now_iso(),
            )
        # Cap: checked before EVERY send.
        if count_sent_today(cfg["account_id"]) >= cfg["daily_cap"]:
            summary["skipped"] += 1
            note(
                f"chat: daily limit reached ({cfg['daily_cap']}) — "
                f"skipping reply to {row.get('profile_name')}"
            )
            db.set_chat_thread(thread_id, last_seen_text=last_msg_text)
            continue
        history = [
            {"role": m.get("role"), "text": m.get("text") or ""} for m in existing
        ]
        history.append({"role": "candidate", "text": last_msg_text})
        draft = draft_reply(
            cfg["gemini_key"],
            cfg["model"],
            cfg["script"],
            row.get("profile_name") or "",
            row.get("source_type") or "comment",
            row.get("source_text") or "",
            history,
            provider=cfg.get("provider", "gemini"),
            ollama_url=cfg.get("ollama_url", ""),
        )
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
            ok, detail = worker.send_thread_message(page, thread_url, part, ctx)
            db.save_chat_message(
                _new_id("msg"),
                thread_id,
                "agent",
                part,
                "sent" if ok else "failed",
                sent_at=_now_iso() if ok else None,
                created_at=_now_iso(),
            )
            if not ok:
                summary["errors"].append(
                    f"send failed for {row.get('profile_name')}: {detail}"
                )
                break
            sent_any = True
        if sent_any:
            summary["replied"] += 1
        db.set_chat_thread(thread_id, last_seen_text=last_msg_text)
    return summary


# ----------------------------------------------------------------------
# First message (chat start)
# ----------------------------------------------------------------------
def _ai_first_message(payload, fallback, note):
    """Unique opener per person, written by the chosen AI."""
    s = payload.get("script") or {}
    prompt = "\n".join(
        [
            "You write the FIRST direct message to a person on Messenger.",
            f"Goal of the whole conversation: {s.get('goal', '')}",
            f"Tone: {s.get('tone', '')}",
            f"Rules:\n{s.get('rules', '')}",
            f"About me (introduce briefly): {s.get('introduction', '')}",
            f"Style example (do NOT copy word for word): {s.get('firstMessageTemplate', '')}",
            "",
            f"The person: {payload.get('profileName', '')}. They wrote this "
            f"{payload.get('sourceType', 'comment')}: \u201c{payload.get('sourceText', '')}\u201d.",
            "",
            "Write a warm, natural, unique opener that refers to what they wrote, "
            "introduces me in one short line and ends with one easy question. "
            "Max 3 short sentences. No links. Never use dashes like the long dash. Reply with the message text only.",
        ]
    )
    provider = payload.get("provider") or "gemini"
    text, err = ai_models.generate(
        provider,
        payload.get("model") or DEFAULT_MODEL,
        payload.get("geminiKey") or "",
        payload.get("ollamaUrl") or "",
        prompt,
    )
    text = _clean_draft(text)
    if err or not text:
        note(f"chat: AI first message failed ({err or 'empty'}) - using template")
        return fallback
    print("chat: first message written by", provider, payload.get("model"))
    return text


def start_chat(worker, page, payload: dict, note=None) -> dict:
    set_activity("busy", "Naya chat: " + str(payload.get("profileName") or ""))
    try:
        return _start_chat_inner(worker, page, payload, note)
    finally:
        set_activity("idle")


def _start_chat_inner(worker, page, payload: dict, note=None) -> dict:
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
    result = {"ok": False, "threadUrl": None, "inRequests": False, "detail": ""}
    if not thread_id or not profile_url or not first_message:
        result["detail"] = "threadId, profileUrl and firstMessage are required"
        set_send_stage(message_id, "failed", result["detail"])
        return result
    # The row exists from here on, so every failure path below is
    # visible to the app via GET /chat/threads.
    db.upsert_chat_thread(
        thread_id,
        account_id,
        profile_url,
        payload.get("profileName") or "",
        payload.get("sourceType") or "comment",
        payload.get("sourceText") or "",
        status="starting",
    )

    def _record_failed_first_message() -> None:
        """Save the first message as failed under the app's message
        id, so the app learns the failure (otherwise its message
        stays "pending" forever with no stage and no reason).
        INSERT OR IGNORE: a retry never duplicates it. Skipped when
        the thread was deleted meanwhile — a late failure must not
        resurrect its rows."""
        if message_id and not thread_forgotten(thread_id):
            db.save_chat_message(
                message_id,
                thread_id,
                "agent",
                first_message,
                "failed",
                sent_at=None,
                created_at=_now_iso(),
            )

    if count_sent_today(account_id) >= cap:
        result["detail"] = (
            f"daily limit reached ({cap} messages today) — " "no outbound"
        )
        set_send_stage(message_id, "failed", result["detail"])
        _record_failed_first_message()
        db.set_chat_thread(thread_id, status="failed", last_error=result["detail"])
        return result
    # A deleted thread's send aborts here too: the global stop flag
    # is cleared by a later set_watch, but the per-thread forgotten
    # flag is never cleared — a re-synced watcher cannot resume it.
    stopped = lambda: stop_requested() or thread_forgotten(thread_id)  # noqa: E731
    ctx = {
        "should_stop": stopped,
        "pace": lambda: time.sleep(2.5),
        "note": note,
        "profile_name": payload.get("profileName") or "",
        # Stage callback for the browser steps the send runs through
        # (facebook.py reports "verifying sent" through it); the
        # watcher builds its own ctx without one, so it stays silent.
        "stage": lambda s, d="": set_send_stage(message_id, s, d),
    }
    set_send_stage(message_id, "checking session")
    try:
        state = worker.verify_session(page, ctx, target_url=profile_url)
    except Exception as exc:  # noqa: BLE001
        result["detail"] = f"session check failed: {exc}"
        set_send_stage(message_id, "failed", result["detail"])
        _record_failed_first_message()
        db.set_chat_thread(thread_id, status="failed", last_error=result["detail"])
        return result
    if state != "ok":
        result["detail"] = session_message(state)
        set_send_stage(message_id, "failed", result["detail"])
        _record_failed_first_message()
        db.set_chat_thread(thread_id, status="failed", last_error=result["detail"])
        return result
    set_send_stage(message_id, "opening chat")
    thread_url, detail = chat_open.open_chat(worker, page, profile_url, ctx)
    if not thread_url:
        result["detail"] = f"could not open a chat: {detail}"
        set_send_stage(message_id, "failed", result["detail"])
        _record_failed_first_message()
        db.set_chat_thread(thread_id, status="failed", last_error=result["detail"])
        return result
    result["threadUrl"] = thread_url
    if not thread_url.startswith("compose:"):
        db.set_chat_thread(thread_id, messenger_thread_url=thread_url)
    try:
        if not thread_url.startswith("compose:"):
            _import_history(
                thread_id, worker.read_thread_messages(page, thread_url, ctx)
            )
        _HISTORY_DONE.add(thread_id)
    except Exception:
        pass
    if stopped():
        result["detail"] = "stopped before sending"
        set_send_stage(message_id, "failed", result["detail"])
        _record_failed_first_message()
        db.set_chat_thread(thread_id, status="failed", last_error=result["detail"])
        return result
    sent_any = False
    last_error = ""
    if payload.get("aiFirst"):
        first_message = _ai_first_message(payload, first_message, note)
    parts = split_messages(first_message)
    for index, part in enumerate(parts):
        if stopped():
            result["detail"] = "stopped before sending"
            set_send_stage(message_id, "failed", result["detail"])
            _record_failed_first_message()
            db.set_chat_thread(thread_id, status="failed", last_error=result["detail"])
            return result
        if count_sent_today(account_id) >= cap:
            result["detail"] = (
                f"daily limit reached ({cap} messages " "today) — stopped"
            )
            # Keep the real reason: the not-sent-any block below
            # reports last_error, and without this it would say
            # "unknown" instead of the cap.
            last_error = result["detail"]
            set_send_stage(message_id, "failed", result["detail"])
            break
        set_send_stage(
            message_id,
            "typing message",
            f"part {index + 1} of {len(parts)}" if len(parts) > 1 else "",
        )
        ok, detail = worker.send_thread_message(page, thread_url, part, ctx)
        part_id = message_id if (index == 0 and message_id) else _new_id("msg")
        if thread_url.startswith("compose:") and ctx.get("new_thread_url"):
            thread_url = ctx["new_thread_url"]
            result["threadUrl"] = thread_url
            db.set_chat_thread(thread_id, messenger_thread_url=thread_url)
        # A thread deleted mid-send must not be resurrected: skip the
        # row when it was forgotten (the part may still have gone out
        # — the app deleted the thread, so nothing shows it).
        if not thread_forgotten(thread_id):
            db.save_chat_message(
                part_id,
                thread_id,
                "agent",
                part,
                "sent" if ok else "failed",
                sent_at=_now_iso() if ok else None,
                created_at=_now_iso(),
            )
        if not ok:
            last_error = detail
            break
        sent_any = True
    if not sent_any:
        result["detail"] = f"first message failed: {last_error or 'unknown'}"
        set_send_stage(message_id, "failed", result["detail"])
        _record_failed_first_message()
        db.set_chat_thread(thread_id, status="failed", last_error=result["detail"])
        return result
    set_send_stage(message_id, "sent")
    # A first message to a stranger lands in Message Requests until
    # they accept — check honestly and report it.
    try:
        req_rows = worker.read_messenger_threads(page, ctx, "message_requests")
        result["inRequests"] = any(r.get("thread_url") == thread_url for r in req_rows)
    except Exception:
        result["inRequests"] = False
    try:
        real = chat_open._canon(page.url or "")
        if real:
            db.set_chat_thread(thread_id, messenger_thread_url=real)
    except Exception:
        pass
    db.set_chat_thread(thread_id, status="active", last_seen_text=first_message)
    result["ok"] = True
    result["detail"] = (
        "sent (in Message Requests — they have not " "accepted yet)"
        if result["inRequests"]
        else "sent and confirmed"
    )
    return result
