"""Tests for the LeadHunter scraping agent.

All browser behaviour uses a fake page (this VM cannot reach
Facebook). No test touches the network or a real browser.

The FakePage dispatches on the JS marker strings in the worker's
scripts ("feed-posts", "extract-post", "expand-buttons",
"article-count", "dialog-state", "dialog-scroll"), mirroring the
test-double pattern in ~/workspace/client-hunting/tests/test_scrape.py.
It can also simulate a post dialog that loads comments lazily on
scroll and reveals replies only after its "View N replies" buttons
are clicked.
"""

import copy
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

AGENT_DIR = Path(__file__).resolve().parent.parent
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

import db  # noqa: E402
import jobs  # noqa: E402
from facebook import FacebookWorker  # noqa: E402
from timestamps import (  # noqa: E402
    extract_timestamp_label,
    parse_exact_description,
    posted_at,
    posted_at_from_label,
)

NOW = datetime(2026, 11, 12, 12, 0, 0, tzinfo=timezone.utc)
GROUP_URL = "https://www.facebook.com/groups/572426944223825"
POST_URLS = [
    "https://www.facebook.com/groups/572426944223825/permalink/111/",
    "https://www.facebook.com/groups/572426944223825/permalink/222/",
    "https://www.facebook.com/groups/572426944223825/permalink/333/",
]


@pytest.fixture(autouse=True)
def temp_db(tmp_path):
    db.init_db(tmp_path / "test_agent.db")
    yield


class _FakeLocator:
    def __init__(self, count=0):
        self._count = count

    def count(self):
        return self._count


class _FakeMouse:
    def wheel(self, *a, **k):
        return None


class _FakePage:
    """Fake page: goto + body + marker-dispatched evaluate.

    ``dialog`` simulates a single-post dialog:
      total               stated comment total ("229 comments")
      top_initial         top-level comments loaded on arrival
      top_loaded          top-level comments after enough scrolling
      loads_after_scrolls scrolls needed before the rest load
      loading_initial     "Loading..." placeholders present at first
      expand_clicks       "View N replies" buttons clicked on 1st expand
      reply_count         replies revealed once expanded
    """

    def __init__(self, pages=None, feed_posts=None, extract_payload=None,
                 article_count=1, logged_out=False, dialog=None):
        self._pages = dict(pages or {})
        self._feed_posts = list(feed_posts or [])
        self._extract_payload = extract_payload
        self._article_count = article_count
        self._logged_out = logged_out
        self._dialog = dialog
        self._scrolls = 0
        self._expand_calls = 0
        self._expanded = False
        self.url = ""
        self._body = "Facebook feed content"
        self._title = "Facebook"
        self.eval_calls = 0
        self.expand_calls = 0
        self.extract_calls = 0

    def goto(self, url, wait_until=None, timeout=None):
        self.url = "https://www.facebook.com/login" if self._logged_out else url
        data = self._pages.get(url, {})
        self._body = data.get("body_text", "Facebook feed content")
        self._title = data.get("title", "Facebook")

    def title(self):
        return self._title

    def inner_text(self, selector):
        if selector == "body":
            return self._body
        return ""

    def query_selector_all(self, selector):
        return []

    def locator(self, selector):
        if self._logged_out and 'input[type="password"]' in selector:
            return _FakeLocator(1)
        return _FakeLocator(0)

    def evaluate(self, js, *args):
        if not isinstance(js, str):
            return None
        if "article-count" in js:
            return self._article_count
        if "feed-posts" in js:
            self.eval_calls += 1
            return [dict(p) for p in self._feed_posts]
        if "dialog-state" in js:
            return self._dialog_state()
        if "dialog-scroll" in js:
            self._scrolls += 1
            return True
        if "expand-buttons" in js:
            self.expand_calls += 1
            self._expand_calls += 1
            if self._dialog and self._expand_calls == 1:
                self._expanded = True
                return self._dialog.get("expand_clicks", 0)
            return 0
        if "extract-post" in js:
            self.extract_calls += 1
            return self._extract_payload_data()
        return None

    def _dialog_state(self):
        if not self._dialog:
            return None
        d = self._dialog
        loaded = self._scrolls >= d.get("loads_after_scrolls", 0)
        top = d.get("top_loaded") if loaded else d.get("top_initial", 0)
        loading = 0 if loaded else d.get("loading_initial", 0)
        return {"total": d.get("total"), "top_comments": top,
                "loading": loading}

    def _extract_payload_data(self):
        if self._dialog is not None:
            d = self._dialog
            loaded = self._scrolls >= d.get("loads_after_scrolls", 0)
            n_top = d.get("top_loaded") if loaded else d.get("top_initial", 0)
            comments = [
                {"author_name": f"C{i + 1}",
                 "author_url": f"https://www.facebook.com/c{i + 1}",
                 "text": f"comment {i + 1}", "posted_at_label": "5d",
                 "posted_at_exact": None, "replies": []}
                for i in range(n_top)
            ]
            if self._expanded:
                for i in range(d.get("reply_count", 0)):
                    comments[i % max(n_top, 1)]["replies"].append(
                        {"author_name": f"R{i + 1}",
                         "author_url": f"https://www.facebook.com/r{i + 1}",
                         "text": f"reply {i + 1}",
                         "posted_at_label": "5d",
                         "posted_at_exact": None, "replies": []})
            return {"author_name": "Poster",
                    "author_url": "https://www.facebook.com/poster",
                    "text": "post text", "comment_total": d.get("total"),
                    "comments": comments}
        if self._extract_payload is None:
            return None
        return copy.deepcopy(self._extract_payload)

    def wait_for_timeout(self, ms):
        return None

    @property
    def mouse(self):
        return _FakeMouse()


def _feed_posts(urls):
    return [{"post_url": u, "author_name": "Poster", "comment_count": 3}
            for u in urls]


def _extract_payload(comments):
    return {"author_name": "Poster",
            "author_url": "https://www.facebook.com/poster",
            "text": "post text", "comment_total": None,
            "comments": comments}


def _comment(name, text, label="5d", exact=None, replies=None):
    return {"author_name": name,
            "author_url": f"https://www.facebook.com/{name.lower()}",
            "text": text, "posted_at_label": label,
            "posted_at_exact": exact, "replies": replies or []}


def _scrape_job(source_id="src1", account_id="acc1"):
    job_id = db.create_job("scrape", source_id=source_id,
                           account_id=account_id)
    job = db.get_job(job_id)
    job["source_url"] = GROUP_URL
    job["source_name"] = "Stocks To Watch"
    return job


def _run_scrape(page, job, should_stop=lambda: False):
    jobs.run_scrape(FacebookWorker(), page, db, job, should_stop)


# ---------------------------------------------------------------------------
# (a) Timestamps: exact description first, label fallback second
# ---------------------------------------------------------------------------

class TestTimestamps:
    def test_label_fallback_at_fixed_now(self):
        assert posted_at_from_label("5d", NOW) == "2026-11-07T12:00:00+00:00"
        assert posted_at_from_label("5h", NOW) == "2026-11-12T07:00:00+00:00"
        assert posted_at_from_label("5m", NOW) == "2026-11-12T11:55:00+00:00"
        assert posted_at_from_label("5w", NOW) == "2026-10-08T12:00:00+00:00"
        assert posted_at_from_label("5s", NOW) == "2026-11-12T11:59:55+00:00"
        assert posted_at_from_label("3 days ago", NOW) == "2026-11-09T12:00:00+00:00"
        assert posted_at_from_label("Yesterday", NOW) == "2026-11-11T12:00:00+00:00"
        assert posted_at_from_label("Yesterday at 21:02", NOW) == "2026-11-11T12:00:00+00:00"
        assert posted_at_from_label("Just now", NOW) == "2026-11-12T12:00:00+00:00"
        assert posted_at_from_label("5mo", NOW) == "2026-06-15T12:00:00+00:00"

    def test_unparseable_labels_are_none(self):
        assert posted_at_from_label("October 12", NOW) is None
        assert posted_at_from_label("", NOW) is None
        assert posted_at_from_label(None, NOW) is None

    def test_exact_description_parse(self):
        assert parse_exact_description(
            "Friday 6 November 2026 at 09:10", NOW) == "2026-11-06T09:10:00+00:00"
        assert parse_exact_description(
            "Wednesday 11 November 2026 at 05:43", NOW) == "2026-11-11T05:43:00+00:00"
        # No-year form assumes the current year.
        assert parse_exact_description(
            "5 November at 21:02", NOW) == "2026-11-05T21:02:00+00:00"
        # No-year date in the future must be last year.
        assert parse_exact_description(
            "5 November at 21:02",
            datetime(2026, 1, 5, 12, 0, tzinfo=timezone.utc)
        ) == "2025-11-05T21:02:00+00:00"
        assert parse_exact_description("not a date", NOW) is None

    def test_posted_at_prefers_exact_over_label(self):
        assert posted_at("Friday 6 November 2026 at 09:10", "5d", NOW) == \
            "2026-11-06T09:10:00+00:00"
        assert posted_at(None, "5d", NOW) == "2026-11-07T12:00:00+00:00"
        assert posted_at(None, "October 12", NOW) is None

    def test_extract_timestamp_label(self):
        assert extract_timestamp_label(["Amit", "5d", "hello"]) == "5d"
        assert extract_timestamp_label(["hello"]) is None


# ---------------------------------------------------------------------------
# (b) Scrap new posts only
# ---------------------------------------------------------------------------

class TestScrapeNewOnly:
    def test_feed_with_one_known_url_collects_two_new(self):
        db.save_post({
            "source_id": "src1", "account_id": "acc1",
            "post_url": POST_URLS[0], "author_name": "Poster",
            "author_url": "https://www.facebook.com/poster",
            "text": "old post", "collected_at": NOW.isoformat(),
            "comments": []})
        page = _FakePage(
            feed_posts=_feed_posts(POST_URLS),
            extract_payload=_extract_payload([_comment("Amit", "nice")]))
        job = _scrape_job()
        _run_scrape(page, job)
        posts = db.get_posts_for_source("src1")
        assert {p["post_url"] for p in posts} == set(POST_URLS)
        row = db.get_job(job["id"])
        assert row["posts_processed"] == 2
        assert row["new_posts"] == 2
        assert row["status"] == "done"
        assert row["verification"][0]["complete"] is True
        assert row["verification"][0]["expectedComments"] is None


# ---------------------------------------------------------------------------
# (c) Sync merge: no duplicates, lastSyncedAt set
# ---------------------------------------------------------------------------

class TestSyncMerge:
    def test_sync_merges_one_new_comment(self):
        db.save_post({
            "source_id": "src1", "account_id": "acc1",
            "post_url": POST_URLS[0], "author_name": "Poster",
            "author_url": "https://www.facebook.com/poster",
            "text": "post text", "collected_at": NOW.isoformat(),
            "comments": [{
                "author_name": "Amit",
                "author_url": "https://www.facebook.com/amit",
                "text": "nice", "posted_at": None,
                "posted_at_label": "5d", "replies": []}]})
        page = _FakePage(extract_payload=_extract_payload([
            _comment("Amit", "nice"), _comment("Sana", "hello")]))
        job_id = db.create_job("sync", source_id="src1", account_id="acc1")
        job = db.get_job(job_id)
        jobs.run_sync(FacebookWorker(), page, db, job, lambda: False)
        post = db.get_post_by_url(POST_URLS[0])
        assert len(post["comments"]) == 2
        assert {c["text"] for c in post["comments"]} == {"nice", "hello"}
        assert post["last_synced_at"]
        row = db.get_job(job_id)
        assert row["status"] == "done"
        assert row["posts_processed"] == 1


# ---------------------------------------------------------------------------
# (d) Graceful stop: current post saved, next never started
# ---------------------------------------------------------------------------

class TestGracefulStop:
    def test_stop_after_first_post(self):
        page = _FakePage(
            feed_posts=_feed_posts(POST_URLS[:2]),
            extract_payload=_extract_payload([_comment("Amit", "nice")]))
        worker = FacebookWorker()
        stop = {"stop": False}
        calls = {"n": 0}
        orig_extract = worker.extract_post

        def _extract(p, url, ctx=None):
            calls["n"] += 1
            result = orig_extract(p, url, ctx)
            stop["stop"] = True  # stop requested right after post 1
            return result

        worker.extract_post = _extract
        job = _scrape_job()
        jobs.run_scrape(worker, page, db, job, lambda: stop["stop"])
        assert calls["n"] == 1  # second post never started
        row = db.get_job(job["id"])
        assert row["status"] == "stopped"
        assert row["posts_processed"] == 1
        assert len(db.get_posts_for_source("src1")) == 1
        assert len(row["verification"]) == 1  # stopped job keeps entries


# ---------------------------------------------------------------------------
# (e) Timestamp capture: label fallback + exact description
# ---------------------------------------------------------------------------

class TestTimestampCapture:
    def test_label_and_exact_captured_on_save(self):
        page = _FakePage(
            feed_posts=_feed_posts(POST_URLS[:1]),
            extract_payload=_extract_payload([
                _comment("Amit", "label only", label="5d"),
                _comment("Sana", "exact time", label="5d",
                         exact="Friday 6 November 2026 at 09:10")]))
        job = _scrape_job()
        before = datetime.now(timezone.utc)
        _run_scrape(page, job)
        post = db.get_post_by_url(POST_URLS[0])
        by_name = {c["author_name"]: c for c in post["comments"]}
        label_only = by_name["Amit"]
        assert label_only["posted_at_label"] == "5d"
        parsed = datetime.fromisoformat(label_only["posted_at"])
        # 5 days before the collection instant, within tolerance.
        assert abs((parsed - (before - timedelta(days=5))).total_seconds()) < 120
        exact = by_name["Sana"]
        assert exact["posted_at_label"] == "5d"
        assert exact["posted_at"] == "2026-11-06T09:10:00+00:00"


# ---------------------------------------------------------------------------
# (f) Session-check failure: nothing scraped, sign-in error
# ---------------------------------------------------------------------------

class TestSessionFailure:
    def test_logged_out_job_fails_with_sign_in_message(self):
        page = _FakePage(feed_posts=_feed_posts(POST_URLS), logged_out=True)
        job = _scrape_job()
        _run_scrape(page, job)
        row = db.get_job(job["id"])
        assert row["status"] == "failed"
        assert "sign in to Facebook" in (row["error"] or "")
        assert db.get_posts_for_source("src1") == []


# ---------------------------------------------------------------------------
# (h) Exhaustive dialog: lazy load + expand reveals everything
# ---------------------------------------------------------------------------

class TestExhaustiveDialog:
    def test_scroll_and_expand_collects_all(self):
        dialog = {"total": 18, "top_initial": 10, "top_loaded": 15,
                  "loads_after_scrolls": 2, "loading_initial": 1,
                  "expand_clicks": 2, "reply_count": 3}
        page = _FakePage(feed_posts=_feed_posts(POST_URLS[:1]), dialog=dialog)
        job = _scrape_job()
        _run_scrape(page, job)
        assert page._scrolls >= 2  # the worker scrolled to load more
        assert page.expand_calls >= 1  # and clicked the reply buttons
        post = db.get_post_by_url(POST_URLS[0])
        top_level = len(post["comments"])
        replies = sum(len(c["replies"]) for c in post["comments"])
        assert top_level == 15
        assert replies == 3
        row = db.get_job(job["id"])
        assert row["status"] == "done"
        entry = row["verification"][0]
        assert entry == {"postUrl": POST_URLS[0], "expectedComments": 18,
                         "collectedComments": 18, "missing": 0,
                         "complete": True}


# ---------------------------------------------------------------------------
# (i) Mismatch case: stated total never reached -> incomplete
# ---------------------------------------------------------------------------

class TestMismatch:
    def test_missing_comments_mark_job_incomplete(self):
        dialog = {"total": 10, "top_initial": 8, "top_loaded": 8,
                  "loads_after_scrolls": 0, "loading_initial": 0,
                  "expand_clicks": 0, "reply_count": 0}
        page = _FakePage(feed_posts=_feed_posts(POST_URLS[:1]), dialog=dialog)
        job = _scrape_job()
        _run_scrape(page, job)
        row = db.get_job(job["id"])
        assert row["status"] == "incomplete"
        entry = row["verification"][0]
        assert entry == {"postUrl": POST_URLS[0], "expectedComments": 10,
                         "collectedComments": 8, "missing": 2,
                         "complete": False}
        assert "collected 8 of 10 — 2 missing" in (row["message"] or "")
        # The collected data is still saved and importable.
        assert len(db.get_post_by_url(POST_URLS[0])["comments"]) == 8


# ---------------------------------------------------------------------------
# (g) API validation via TestClient
# ---------------------------------------------------------------------------

class TestApi:
    def test_health_scrape_validation_stop_404(self):
        pytest.importorskip("fastapi")
        pytest.importorskip("httpx")
        from fastapi.testclient import TestClient

        import main

        client = TestClient(main.app)
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json()["ok"] is True
        assert health.json()["service"] == "leadhunter-agent"
        assert client.post("/scrape", json={}).status_code == 400
        assert client.post(
            "/scrape",
            json={"sourceUrl": "https://example.com/not-facebook"}
        ).status_code == 400
        assert client.post(
            "/stop", json={"jobId": "does-not-exist"}).status_code == 404
        assert client.get("/jobs/does-not-exist").status_code == 404
        assert client.get("/jobs").status_code == 200
