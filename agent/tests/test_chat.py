"""Tests for the Inbox live-chat agent (agent/chat.py + the
Messenger methods on FacebookWorker).

All browser behaviour uses a fake page (this VM cannot reach
Facebook). No test touches the network or a real browser — Gemini
is mocked via an injected http_post, and the fake page simulates
Messenger: inbox rows, thread messages, the profile Message button,
and the composer. Tests cover the real logic: only approved threads
are ever replied to, the daily cap is enforced, stop halts
everything, and the Gemini key never reaches disk.
"""

import copy
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

AGENT_DIR = Path(__file__).resolve().parent.parent
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

import chat  # noqa: E402
import db  # noqa: E402
from facebook import FacebookWorker  # noqa: E402

FAKE_KEY = "AIza-FAKE-KEY-12345"
PROFILE_URL = "https://www.facebook.com/sana.mirza"
THREAD_URL = "https://www.facebook.com/messages/t/12345"
OTHER_URL = "https://www.facebook.com/messages/t/99999"
ACCOUNT_ID = "acc-1"
SCRIPT = {
    "firstMessageTemplate": "Hi {name}! I read your {sourceKind}.",
    "introduction": "I help people take first steps in investing.",
    "tone": "Warm, short, no pressure.",
    "rules": "Never promise profit. Say 'we', not 'I'.",
    "goal": "Push them to a short call.",
}


@pytest.fixture(autouse=True)
def temp_db(tmp_path):
    # main.py resets the db path to agent/leadhunter.db at import
    # time — import it BEFORE init_db, so the temp path below sticks
    # and the health test never reads leftover rows from real runs.
    try:
        import main  # noqa: F401
    except ImportError:
        pass
    db.init_db(tmp_path / "test_chat.db")
    chat.clear_watch()
    chat._STOP.clear()
    chat._SEND_STAGE.clear()
    chat._SEND_STAGE_HISTORY.clear()
    yield
    chat.clear_watch()
    chat._STOP.clear()


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(time, "sleep", lambda s: None)


class _FakeLocator:
    def __init__(self, page, selector, count=0, on_click=None):
        self._page = page
        self._selector = selector
        self._count = count
        self._on_click = on_click

    def count(self):
        return self._count

    def is_visible(self):
        return self._count > 0

    def click(self, timeout=None, force=False):
        if self._on_click is not None:
            self._on_click()
        return None

    def scroll_into_view_if_needed(self, timeout=None):
        return None

    def type(self, text, delay=0):
        self._page._typed(text)
        return None

    def fill(self, text):
        self._page._typed(text)
        return None

    @property
    def first(self):
        return self

    @property
    def last(self):
        return self


class _FakeAnchor:
    def __init__(self, href, text="", aria=""):
        self._href = href
        self._text = text
        self._aria = aria

    def get_attribute(self, name):
        if name == "href":
            return self._href
        if name == "aria-label":
            return self._aria
        return None

    def inner_text(self):
        return self._text


class _FakeKeyboard:
    def __init__(self, page):
        self._page = page
        self.presses = []

    def type(self, text, delay=0):
        self._page._typed(text)

    def press(self, key):
        self.presses.append(key)


class _FakeChatPage:
    """Fake Messenger page.

    Configure: inbox_rows / requests_rows (thread list rows),
    thread_messages {thread_url: [{text, side}]}, message_button_url
    (thread the profile Message button opens, None = no button),
    composer_present, session_ok.
    """

    def __init__(self, inbox_rows=None, requests_rows=None,
                 thread_messages=None, message_button_url=None,
                 composer_present=True, session_ok=True):
        self.url = "https://www.facebook.com/"
        self._inbox_rows = inbox_rows or []
        self._requests_rows = requests_rows or []
        self._thread_messages = thread_messages or {}
        self._message_button_url = message_button_url
        self._composer_present = composer_present
        self._session_ok = session_ok
        self.sent_texts = []
        self.keyboard = _FakeKeyboard(self)
        self._body = "Facebook"

    def _typed(self, text):
        self.sent_texts.append(text)

    def title(self):
        return "Facebook" if self._session_ok else "Log in"

    def inner_text(self, selector):
        extra = "\n".join(self.sent_texts)
        return f"{self._body}\n{extra}" if extra else self._body

    def goto(self, url, wait_until=None, timeout=None):
        self.url = url
        return None

    def reload(self, wait_until=None):
        return None

    def wait_for_timeout(self, ms):
        return None

    def is_closed(self):
        return False

    def query_selector_all(self, selector):
        if selector != "a[href]":
            return []
        rows = []
        if "/messages/requests" in self.url:
            rows = self._requests_rows
        elif "/messages" in self.url:
            rows = self._inbox_rows
        out = []
        for r in rows:
            text = f"{r.get('name', '')}\n{r.get('last_text', '')}"
            aria = "unread" if r.get("unread") else r.get("name", "")
            out.append(_FakeAnchor(r["thread_url"], text, aria))
        return out

    def locator(self, selector):
        if selector == 'input[type="password"]':
            return _FakeLocator(self, selector, 0 if self._session_ok else 1)
        if selector in ('a[aria-label="Your profile"]',
                        'a[aria-label="Account"]',
                        'a[href="/me/"]',
                        '[aria-label="Messenger"]'):
            return _FakeLocator(self, selector, 1 if self._session_ok else 0)
        if selector == 'a[aria-label="Message"]':
            if self._message_button_url:
                def _nav():
                    self.url = self._message_button_url
                return _FakeLocator(self, selector, 1, on_click=_nav)
            return _FakeLocator(self, selector, 0)
        if "contenteditable" in selector or "textarea" in selector:
            return _FakeLocator(self, selector,
                                1 if self._composer_present else 0)
        if selector == "h1":
            return _FakeLocator(self, selector, 0)
        if ":has-text(" in selector:
            # "Message" buttons other than the aria-label one.
            if "Message" in selector and self._message_button_url:
                def _nav2():
                    self.url = self._message_button_url
                return _FakeLocator(self, selector, 1, on_click=_nav2)
            return _FakeLocator(self, selector, 0)
        return _FakeLocator(self, selector, 0)

    def evaluate(self, js):
        if "chat-thread-messages" in js:
            return copy.deepcopy(
                self._thread_messages.get(self.url, []))
        return None


def _worker():
    return FacebookWorker()


def _ctx():
    return {"should_stop": lambda: chat.stop_requested(),
            "pace": lambda: None,
            "note": lambda msg: None}


def _seed_thread(thread_id="thread-1", thread_url=THREAD_URL,
                 status="active", last_seen=""):
    db.upsert_chat_thread(thread_id, ACCOUNT_ID, PROFILE_URL, "Sana Mirza",
                          "comment", "where do I start?",
                          status=status, messenger_thread_url=thread_url,
                          last_seen_text=last_seen)
    return db.get_chat_thread(thread_id)


def _watch_config(threads=None, cap=45):
    return {
        "accountId": ACCOUNT_ID,
        "threads": threads or [{
            "threadId": "thread-1", "profileUrl": PROFILE_URL,
            "profileName": "Sana Mirza", "sourceType": "comment",
            "sourceText": "where do I start?",
        }],
        "script": SCRIPT,
        "geminiKey": FAKE_KEY,
        "model": "gemini-3.8-flash",
        "dailyCap": cap,
    }


class _FakeGeminiResponse:
    def __init__(self, status_code=200, text="Sure — happy to help!"):
        self.status_code = status_code
        self._text = text

    def json(self):
        return {"candidates": [{"content": {"parts": [
            {"text": self._text}]}}]}


# ----------------------------------------------------------------------
# Pure helpers
# ----------------------------------------------------------------------
def test_split_messages_caps_at_two():
    # Four ~191-char sentences (767 total): they cannot fit in one
    # 500-char part, and pack into exactly two.
    sentence = ("Word " * 38).strip() + "."
    long_text = " ".join([sentence] * 4)
    parts = chat.split_messages(long_text)
    assert len(parts) == 2
    assert all(len(p) <= 500 for p in parts)
    assert parts[0].startswith("Word")
    assert chat.split_messages("") == []
    assert chat.split_messages("Hello there.") == ["Hello there."]


def test_daily_cap_bands():
    assert chat.daily_cap_for_age_days(0) == 0
    assert chat.daily_cap_for_age_days(2) == 0
    assert chat.daily_cap_for_age_days(3) == 12
    assert chat.daily_cap_for_age_days(7) == 12
    assert chat.daily_cap_for_age_days(8) == 25
    assert chat.daily_cap_for_age_days(14) == 25
    assert chat.daily_cap_for_age_days(15) == 45
    assert chat.daily_cap_for_age_days(900) == 45


def test_draft_prompt_contains_script_and_history():
    prompt = chat.build_draft_prompt(
        SCRIPT, "Sana Mirza", "comment", "where do I start?",
        [{"role": "agent", "text": "Hi Sana!"},
         {"role": "candidate", "text": "I have 20 lakh saved."}])
    assert "Push them to a short call." in prompt
    assert "Warm, short, no pressure." in prompt
    assert "Never promise profit." in prompt
    assert "where do I start?" in prompt
    assert "Me: Hi Sana!" in prompt
    assert "Sana Mirza: I have 20 lakh saved." in prompt


def test_draft_reply_key_only_in_header():
    seen = {}

    def fake_post(url, headers=None, json=None, timeout=None):
        seen["url"] = url
        seen["headers"] = headers or {}
        seen["body"] = json or {}
        return _FakeGeminiResponse(text="Hello! Happy to help.")

    text = chat.draft_reply(FAKE_KEY, "gemini-3.8-flash", SCRIPT,
                            "Sana Mirza", "comment", "where do I start?",
                            [], http_post=fake_post)
    assert text == "Hello! Happy to help."
    assert seen["headers"].get("x-goog-api-key") == FAKE_KEY
    assert FAKE_KEY not in json.dumps(seen["body"])
    assert "gemini-3.8-flash" in seen["url"]


def test_draft_reply_failure_returns_none():
    def failing_post(url, headers=None, json=None, timeout=None):
        return _FakeGeminiResponse(status_code=429, text="")

    assert chat.draft_reply(FAKE_KEY, "gemini-3.8-flash", SCRIPT,
                            "Sana Mirza", "comment", "x", [],
                            http_post=failing_post) is None
    assert chat.draft_reply("", "gemini-3.8-flash", SCRIPT,
                            "Sana Mirza", "comment", "x", []) is None


# ----------------------------------------------------------------------
# Browser methods (real worker, fake page)
# ----------------------------------------------------------------------
def test_open_chat_with_profile_returns_thread_url():
    page = _FakeChatPage(message_button_url=THREAD_URL)
    url, detail = _worker().open_chat_with_profile(page, PROFILE_URL, _ctx())
    assert url == THREAD_URL
    assert detail == "opened"


def test_open_chat_with_profile_no_button():
    page = _FakeChatPage(message_button_url=None)
    url, detail = _worker().open_chat_with_profile(page, PROFILE_URL, _ctx())
    assert url is None
    assert "no Message button" in detail


def test_read_messenger_threads():
    page = _FakeChatPage(inbox_rows=[
        {"thread_url": THREAD_URL, "name": "Sana Mirza",
         "last_text": "Hi there", "unread": True},
        {"thread_url": OTHER_URL, "name": "Ali",
         "last_text": "ok", "unread": False},
    ])
    rows = _worker().read_messenger_threads(page, _ctx(), "inbox")
    assert [r["thread_url"] for r in rows] == [THREAD_URL, OTHER_URL]
    assert rows[0]["unread"] is True
    assert rows[0]["name"] == "Sana Mirza"


def test_read_thread_messages_side():
    page = _FakeChatPage(thread_messages={
        THREAD_URL: [{"text": "Hi Sana!", "side": "me"},
                     {"text": "Thanks, tell me more", "side": "them"}],
    })
    page.url = THREAD_URL
    rows = _worker().read_thread_messages(page, THREAD_URL, _ctx())
    assert rows == [{"text": "Hi Sana!", "side": "me"},
                    {"text": "Thanks, tell me more", "side": "them"}]


def test_send_thread_message_verified_after_reload():
    page = _FakeChatPage()
    ok, detail = _worker().send_thread_message(
        page, THREAD_URL, "Hello Sana, happy to help!", _ctx())
    assert ok is True
    assert "confirmed after reload" in detail
    assert "Hello Sana, happy to help!" in page.sent_texts
    assert "Enter" in page.keyboard.presses


def test_send_thread_message_no_composer():
    page = _FakeChatPage(composer_present=False)
    ok, detail = _worker().send_thread_message(page, THREAD_URL, "Hi", _ctx())
    assert ok is False
    assert detail == "message box not found"


# ----------------------------------------------------------------------
# start_chat orchestration
# ----------------------------------------------------------------------
def _start_payload(cap=45, message_id="msg-1"):
    return {
        "accountId": ACCOUNT_ID, "threadId": "thread-1",
        "messageId": message_id, "profileUrl": PROFILE_URL,
        "profileName": "Sana Mirza", "sourceType": "comment",
        "sourceText": "where do I start?",
        "firstMessage": "Hi Sana! I read your comment about starting.",
        "dailyCap": cap,
    }


def test_start_chat_happy_path():
    page = _FakeChatPage(message_button_url=THREAD_URL)
    result = chat.start_chat(_worker(), page, _start_payload(), note=lambda m: None)
    assert result["ok"] is True
    assert result["threadUrl"] == THREAD_URL
    row = db.get_chat_thread("thread-1")
    assert row["status"] == "active"
    assert row["messenger_thread_url"] == THREAD_URL
    messages = db.list_chat_messages("thread-1")
    assert len(messages) == 1
    assert messages[0]["id"] == "msg-1"  # the app's message id is kept
    assert messages[0]["delivery"] == "sent"
    assert messages[0]["role"] == "agent"


def test_start_chat_cap_zero_refuses():
    page = _FakeChatPage(message_button_url=THREAD_URL)
    result = chat.start_chat(_worker(), page, _start_payload(cap=0),
                             note=lambda m: None)
    assert result["ok"] is False
    assert "daily limit" in result["detail"]
    assert db.get_chat_thread("thread-1")["status"] == "failed"
    assert page.sent_texts == []


def test_start_chat_logged_out_fails():
    page = _FakeChatPage(message_button_url=THREAD_URL, session_ok=False)
    result = chat.start_chat(_worker(), page, _start_payload(),
                             note=lambda m: None)
    assert result["ok"] is False
    assert "logged_out" in result["detail"]
    assert page.sent_texts == []


def test_start_chat_no_message_button_fails():
    page = _FakeChatPage(message_button_url=None)
    result = chat.start_chat(_worker(), page, _start_payload(),
                             note=lambda m: None)
    assert result["ok"] is False
    assert "could not open a chat" in result["detail"]
    assert db.get_chat_thread("thread-1")["status"] == "failed"


def test_start_chat_marks_message_requests():
    page = _FakeChatPage(
        message_button_url=THREAD_URL,
        requests_rows=[{"thread_url": THREAD_URL, "name": "Sana Mirza",
                        "last_text": "Hi Sana!", "unread": False}])
    result = chat.start_chat(_worker(), page, _start_payload(),
                             note=lambda m: None)
    assert result["ok"] is True
    assert result["inRequests"] is True
    assert "Message Requests" in result["detail"]


# ----------------------------------------------------------------------
# Watcher: approval gate, cap, stop, key safety
# ----------------------------------------------------------------------
def test_watch_ignores_unapproved_threads(monkeypatch):
    _seed_thread()
    page = _FakeChatPage(
        inbox_rows=[
            {"thread_url": THREAD_URL, "name": "Sana Mirza",
             "last_text": "yes tell me more", "unread": True},
            {"thread_url": OTHER_URL, "name": "Stranger",
             "last_text": "hello??", "unread": True},
        ],
        thread_messages={THREAD_URL: [
            {"text": "Hi Sana!", "side": "me"},
            {"text": "yes tell me more", "side": "them"}]})
    monkeypatch.setattr(chat, "draft_reply",
                        lambda *a, **k: "Great — here is the simple first step.")
    chat.set_watch(_watch_config())
    summary = chat.watch_once(_worker(), page, note=lambda m: None)
    assert summary["replied"] == 1
    assert summary["checked"] == 1  # only the approved thread was checked
    messages = db.list_chat_messages("thread-1")
    assert [m["text"] for m in messages if m["role"] == "agent"] == [
        "Great — here is the simple first step."]
    # The stranger's thread was never opened: no messages stored for it.
    assert db.get_chat_thread("thread-1") is not None


def test_watch_skips_when_last_message_is_ours():
    _seed_thread(last_seen="Hi Sana!")
    page = _FakeChatPage(
        inbox_rows=[{"thread_url": THREAD_URL, "name": "Sana Mirza",
                     "last_text": "Hi Sana!", "unread": False}],
        thread_messages={THREAD_URL: [{"text": "Hi Sana!", "side": "me"}]})
    chat.set_watch(_watch_config())
    summary = chat.watch_once(_worker(), page, note=lambda m: None)
    assert summary["replied"] == 0
    assert db.list_chat_messages("thread-1") == []


def test_watch_never_answers_twice(monkeypatch):
    _seed_thread(last_seen="yes tell me more")
    page = _FakeChatPage(
        inbox_rows=[{"thread_url": THREAD_URL, "name": "Sana Mirza",
                     "last_text": "yes tell me more", "unread": True}],
        thread_messages={THREAD_URL: [
            {"text": "Hi Sana!", "side": "me"},
            {"text": "yes tell me more", "side": "them"}]})
    monkeypatch.setattr(chat, "draft_reply",
                        lambda *a, **k: "reply")
    chat.set_watch(_watch_config())
    summary = chat.watch_once(_worker(), page, note=lambda m: None)
    assert summary["replied"] == 0  # already handled (last_seen matches)


def test_watch_cap_blocks_send(monkeypatch):
    _seed_thread()
    # Fill the cap: 12 sent messages today already (UTC date, computed
    # — a hardcoded date would count as another day).
    today = datetime.now(timezone.utc).date().isoformat()
    for i in range(12):
        db.save_chat_message(f"sent-{i}", "thread-1", "agent",
                             f"old {i}", "sent",
                             sent_at=f"{today}T00:00:00+00:00",
                             created_at=f"{today}T00:00:00+00:00")
    page = _FakeChatPage(
        inbox_rows=[{"thread_url": THREAD_URL, "name": "Sana Mirza",
                     "last_text": "yes tell me more", "unread": True}],
        thread_messages={THREAD_URL: [
            {"text": "Hi Sana!", "side": "me"},
            {"text": "yes tell me more", "side": "them"}]})
    monkeypatch.setattr(chat, "draft_reply",
                        lambda *a, **k: "reply")
    chat.set_watch(_watch_config(cap=12))
    summary = chat.watch_once(_worker(), page, note=lambda m: None)
    assert summary["replied"] == 0
    assert summary["skipped"] == 1
    assert page.sent_texts == []


def test_watch_gemini_failure_skips_without_sending(monkeypatch):
    _seed_thread()
    page = _FakeChatPage(
        inbox_rows=[{"thread_url": THREAD_URL, "name": "Sana Mirza",
                     "last_text": "yes tell me more", "unread": True}],
        thread_messages={THREAD_URL: [
            {"text": "Hi Sana!", "side": "me"},
            {"text": "yes tell me more", "side": "them"}]})
    monkeypatch.setattr(chat, "draft_reply", lambda *a, **k: None)
    chat.set_watch(_watch_config())
    summary = chat.watch_once(_worker(), page, note=lambda m: None)
    assert summary["replied"] == 0
    assert summary["skipped"] == 1
    assert page.sent_texts == []
    # last_seen NOT advanced, so the next pass retries.
    assert db.get_chat_thread("thread-1")["last_seen_text"] in ("", None)


def test_stop_halts_and_forgets_key_and_config(monkeypatch):
    _seed_thread()
    page = _FakeChatPage(
        inbox_rows=[{"thread_url": THREAD_URL, "name": "Sana Mirza",
                     "last_text": "yes tell me more", "unread": True}],
        thread_messages={THREAD_URL: [
            {"text": "Hi Sana!", "side": "me"},
            {"text": "yes tell me more", "side": "them"}]})
    monkeypatch.setattr(chat, "draft_reply",
                        lambda *a, **k: "reply")
    chat.set_watch(_watch_config())
    assert chat.is_watching() is True
    chat.request_stop()
    assert chat.is_watching() is False
    assert chat._WATCH["gemini_key"] is None
    assert chat._WATCH["threads"] == []
    summary = chat.watch_once(_worker(), page, note=lambda m: None)
    assert summary["replied"] == 0
    assert summary["ok"] is False
    assert page.sent_texts == []


def test_watch_not_active_does_nothing():
    _seed_thread()
    page = _FakeChatPage(
        inbox_rows=[{"thread_url": THREAD_URL, "name": "Sana Mirza",
                     "last_text": "yes tell me more", "unread": True}])
    summary = chat.watch_once(_worker(), page, note=lambda m: None)
    assert summary == {"ok": False, "checked": 0, "replied": 0,
                       "skipped": 0, "errors": []}
    assert page.sent_texts == []


def test_gemini_key_never_reaches_disk(tmp_path, monkeypatch):
    page = _FakeChatPage(message_button_url=THREAD_URL)
    chat.start_chat(_worker(), page, _start_payload(), note=lambda m: None)
    _seed_thread(last_seen="yes tell me more")
    page2 = _FakeChatPage(
        inbox_rows=[{"thread_url": THREAD_URL, "name": "Sana Mirza",
                     "last_text": "yes tell me more", "unread": True}],
        thread_messages={THREAD_URL: [
            {"text": "Hi Sana!", "side": "me"},
            {"text": "yes tell me more", "side": "them"}]})
    monkeypatch.setattr(chat, "draft_reply",
                        lambda *a, **k: "reply text here")
    chat.set_watch(_watch_config())
    chat.watch_once(_worker(), page2, note=lambda m: None)
    chat.request_stop()
    # The key must not appear in the agent DB file or any file the
    # agent wrote under the temp dir.
    for path in tmp_path.rglob("*"):
        if path.is_file():
            assert FAKE_KEY.encode() not in path.read_bytes(), path


# ----------------------------------------------------------------------
# HTTP endpoints (main.py): validation, 202/409, watch + stop wiring
# ----------------------------------------------------------------------
class TestChatEndpoints:
    def _client(self):
        pytest.importorskip("fastapi")
        pytest.importorskip("httpx")
        from fastapi.testclient import TestClient

        import main

        return TestClient(main.app), main

    def _start_body(self, **over):
        body = {
            "accountId": ACCOUNT_ID, "threadId": "thread-1",
            "messageId": "msg-1", "profileUrl": PROFILE_URL,
            "profileName": "Sana Mirza", "sourceType": "comment",
            "sourceText": "where do I start?",
            "firstMessage": "Hi Sana! I read your comment about starting.",
            "dailyCap": 45,
        }
        body.update(over)
        return body

    def _wait_start_done(self, main, timeout=10.0):
        # The start runs in a background thread; time.sleep is mocked
        # to a no-op by the no_sleep fixture, so wait on a real event
        # (which releases the GIL and is not mocked).
        import threading

        waited = 0.0
        while waited < timeout:
            if not main._chat_start_busy:
                return True
            threading.Event().wait(0.05)
            waited += 0.05
        return False

    def test_health_reports_chat_block(self):
        client, _main = self._client()
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json()["chat"] == {"watching": False, "threads": 0}

    def test_start_validation(self):
        client, _main = self._client()
        assert client.post("/chat/start", json={}).status_code == 400
        assert client.post(
            "/chat/start",
            json=self._start_body(firstMessage="")).status_code == 400
        assert client.post(
            "/chat/start",
            json=self._start_body(
                profileUrl="https://example.com/not-facebook")
        ).status_code == 400

    def test_start_happy_path_sends_via_endpoint(self, monkeypatch):
        client, main = self._client()
        page = _FakeChatPage(message_button_url=THREAD_URL)
        monkeypatch.setattr(main, "_fresh_page", lambda: page)
        r = client.post("/chat/start", json=self._start_body())
        assert r.status_code == 202
        assert r.json()["threadId"] == "thread-1"
        assert self._wait_start_done(main)
        row = db.get_chat_thread("thread-1")
        assert row["status"] == "active"
        assert row["messenger_thread_url"] == THREAD_URL
        messages = db.list_chat_messages("thread-1")
        assert len(messages) == 1
        assert messages[0]["id"] == "msg-1"
        assert messages[0]["delivery"] == "sent"
        # The app can now poll the delivery against its own message id.
        threads = client.get("/chat/threads").json()
        assert threads["threads"][0]["messages"][0]["delivery"] == "sent"

    def test_start_records_send_stages_in_order(self, monkeypatch):
        client, main = self._client()
        page = _FakeChatPage(message_button_url=THREAD_URL)
        monkeypatch.setattr(main, "_fresh_page", lambda: page)
        r = client.post("/chat/start", json=self._start_body())
        assert r.status_code == 202
        assert self._wait_start_done(main)
        # Every real step of the send, in order — the trail the app
        # shows instead of one frozen "Sending…".
        history = chat.get_send_stage_history("msg-1")
        assert [h["stage"] for h in history] == [
            "queued", "opening browser", "checking session", "opening chat",
            "typing message", "verifying sent", "sent",
        ]
        stage = chat.get_send_stage("msg-1")
        assert stage["stage"] == "sent"
        assert stage["since"]
        # GET /chat/threads carries the current stage per message.
        threads = client.get("/chat/threads").json()
        msg = threads["threads"][0]["messages"][0]
        assert msg["sendStage"] == "sent"
        assert msg["sendStageSince"]
        assert msg["sendStageDetail"] is None

    def test_start_cap_failure_reports_failed_stage(self, monkeypatch):
        client, main = self._client()
        page = _FakeChatPage(message_button_url=THREAD_URL)
        monkeypatch.setattr(main, "_fresh_page", lambda: page)
        r = client.post("/chat/start", json=self._start_body(dailyCap=0))
        assert r.status_code == 202
        assert self._wait_start_done(main)
        stage = chat.get_send_stage("msg-1")
        assert stage["stage"] == "failed"
        assert "daily limit" in stage["detail"]
        threads = client.get("/chat/threads").json()
        msg = threads["threads"][0]["messages"][0]
        assert msg["sendStage"] == "failed"
        assert "daily limit" in (msg["sendStageDetail"] or "")
        assert msg["delivery"] == "failed"

    def test_start_409_while_another_start_runs(self, monkeypatch):
        client, main = self._client()
        monkeypatch.setattr(main, "_chat_start_busy", True)
        r = client.post("/chat/start", json=self._start_body())
        assert r.status_code == 409

    def test_watch_validation(self):
        client, _main = self._client()
        assert client.post("/chat/watch", json={}).status_code == 400
        assert client.post(
            "/chat/watch",
            json={"accountId": ACCOUNT_ID, "threads": [],
                  "script": SCRIPT}).status_code == 400
        assert client.post(
            "/chat/watch",
            json={"accountId": ACCOUNT_ID, "threads": [],
                  "script": SCRIPT, "geminiKey": FAKE_KEY}
        ).status_code == 200

    def test_watch_then_threads_then_stop(self, monkeypatch):
        client, main = self._client()
        # The loop would launch a real browser via _get_page; keep the
        # pass a no-op — this test covers the endpoint wiring, the
        # pass itself is covered by the watch_once tests above.
        monkeypatch.setattr(main, "_get_page",
                            lambda: _FakeChatPage())
        monkeypatch.setattr(chat, "watch_once",
                            lambda *a, **k: {"ok": True, "checked": 0,
                                            "replied": 0, "skipped": 0,
                                            "errors": []})
        r = client.post("/chat/watch", json=_watch_config())
        assert r.status_code == 200
        assert r.json() == {"watching": True, "threads": 1}
        row = db.get_chat_thread("thread-1")
        assert row is not None
        assert row["status"] == "starting"
        assert chat.is_watching() is True
        threads = client.get("/chat/threads").json()
        assert threads["watching"] is True
        assert threads["threads"][0]["threadId"] == "thread-1"
        # Stop halts everything and forgets the key/config.
        stopped = client.post("/chat/stop", json={})
        assert stopped.status_code == 200
        assert stopped.json() == {"watching": False}
        assert chat.is_watching() is False
