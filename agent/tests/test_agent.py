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
    def __init__(self, count=0, page=None, action=None):
        self._count = count
        self._page = page
        self._action = action

    def count(self):
        return self._count

    def is_visible(self):
        return self._count > 0

    def click(self, timeout=None, force=False):
        if self._action is not None:
            self._action()
        return None

    def scroll_into_view_if_needed(self, timeout=None):
        return None

    @property
    def first(self):
        return self


class _FakeAnchor:
    """One <a href> element. ``member_count_text`` is what the
    worker's ancestor walk would return for the result card
    ("12K members"), so the member gate can be tested without JS."""

    def __init__(self, href, text="", member_count_text=None):
        self._href = href
        self._text = text
        self.member_count_text = member_count_text

    def get_attribute(self, name):
        return self._href if name == "href" else None

    def inner_text(self):
        return self._text


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
                 article_count=1, logged_out=False, dialog=None,
                 anchors_by_url=None, gate_by_url=None, join_urls=None,
                 leave_flow=None, gate_sequence_by_url=None,
                 feed_loading_by_url=None, goto_raises_for=None,
                 blank=False):
        self._pages = dict(pages or {})
        self._feed_posts = list(feed_posts or [])
        self._extract_payload = extract_payload
        self._article_count = article_count
        self._logged_out = logged_out
        self._dialog = dialog
        self._anchors_by_url = dict(anchors_by_url or {})
        self._gate_by_url = dict(gate_by_url or {})
        self._join_urls = set(join_urls or [])
        # gate_sequence_by_url: url -> list of gate counts, one per
        # feed scroll — simulates Facebook lazy-loading the feed
        # (first screen bare, more posts/comments after scrolling).
        # feed_loading_by_url: url -> scrolls after which the
        # "Loading..." placeholders disappear.
        self._gate_sequence = dict(gate_sequence_by_url or {})
        self._feed_loading = dict(feed_loading_by_url or {})
        self._feed_scrolls = 0
        # goto_raises_for: exact URLs whose navigation raises (a
        # hanging home page). goto_calls records every navigation
        # so tests can prove verify_session never navigated.
        self._goto_raises_for = set(goto_raises_for or [])
        self.goto_calls: list[str] = []
        # leave_flow: {"url", "joined_body", "left_body"} — simulates a
        # group page where Joined -> Leave group -> confirm leaves the
        # group; the body then shows "Join group" again.
        self._leave = leave_flow
        self._leave_state = "joined"
        self._left = False
        self._scrolls = 0
        self._expand_calls = 0
        self._expanded = False
        self.url = ""
        # blank=True: a fresh tab that never rendered (empty body) —
        # the session check must prove the session at the job's
        # target page instead of assuming the current page is alive.
        self._body = "" if blank else "Facebook feed content"
        self._title = "" if blank else "Facebook"
        self.eval_calls = 0
        self.expand_calls = 0
        self.extract_calls = 0

    def goto(self, url, wait_until=None, timeout=None):
        self.goto_calls.append(url)
        if url in self._goto_raises_for:
            raise RuntimeError(f"navigation to {url} timed out")
        self.url = "https://www.facebook.com/login" if self._logged_out else url
        if self._leave is not None and url == self._leave["url"]:
            self._body = (self._leave["left_body"] if self._left
                          else self._leave["joined_body"])
            self._title = "Stocks To Watch"
            return
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
        if "a[href]" in selector:
            return list(self._anchors_by_url.get(self.url, []))
        return []

    def _leave_action(self, selector):
        """Click action for the leave state machine, or None."""
        if self._leave_state == "joined" and "Joined" in selector:
            def _open_menu():
                self._leave_state = "menu"
            return _open_menu
        if self._leave_state == "menu" and "Leave group" in selector:
            def _open_confirm():
                self._leave_state = "confirm"
            return _open_confirm
        if self._leave_state == "confirm" and "Leave" in selector:
            def _confirm():
                self._leave_state = "left"
                self._left = True
                self._body = self._leave["left_body"]
            return _confirm
        return None

    def locator(self, selector):
        if self._logged_out and 'input[type="password"]' in selector:
            return _FakeLocator(1)
        if self._leave is not None:
            action = self._leave_action(selector)
            if action is not None:
                return _FakeLocator(1, page=self, action=action)
        if "Join group" in selector and self.url in self._join_urls:
            return _FakeLocator(1)
        return _FakeLocator(0)

    def evaluate(self, js, *args):
        if not isinstance(js, str):
            return None
        if "article-count" in js:
            return self._article_count
        if "scrollBy" in js:
            # A feed scroll (one screen down) on a group/page. Search
            # pages scroll too, but those are not gate scrolls.
            # Tracked separately from dialog scrolls so feed tests
            # never disturb the dialog tests.
            if "/search/" not in self.url:
                self._feed_scrolls += 1
            return None
        if "feed-loading" in js:
            after = self._feed_loading.get(self.url, 0)
            return {"loading": self._feed_scrolls < after}
        if "gate-count" in js:
            seq = self._gate_sequence.get(self.url)
            if seq:
                idx = min(self._feed_scrolls, len(seq) - 1)
                return dict(seq[idx])
            return dict(self._gate_by_url.get(
                self.url, {"posts": 0, "comments": 0}))
        if "diag-aria" in js:
            return {"total": 0, "matched": 0, "btns": 0, "btnNums": 0,
                    "samples": [], "parentBtns": []}
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
# (g) verify_session: current page first, state-named failures
# ---------------------------------------------------------------------------

CHECKPOINT_URL = "https://www.facebook.com/checkpoint/?x=1"


class TestVerifySession:
    def _signed_in_group_page(self, goto_raises_for=None):
        page = _FakePage(
            pages={GROUP_URL: {
                "body_text": "Stock Market Traders. group feed",
                "title": "Stock Market Traders."}},
            goto_raises_for=goto_raises_for)
        page.goto(GROUP_URL)
        return page

    def test_signed_in_group_page_needs_no_navigation(self):
        # Live bug: the browser sat on a loaded, signed-in group
        # page while Scrap failed "not signed in" — verify_session
        # navigated to home first and the navigation hung. The
        # current page alone must prove the session.
        page = self._signed_in_group_page()
        state = FacebookWorker().verify_session(
            page, jobs._ctx(lambda: False))
        assert state == "ok"
        assert page.goto_calls == [GROUP_URL]

    def test_signed_in_page_survives_a_hanging_home_navigation(self):
        # Even if home would time out, a signed-in current page
        # is enough — the job must not fail.
        page = self._signed_in_group_page(
            goto_raises_for={"https://www.facebook.com"})
        state = FacebookWorker().verify_session(
            page, jobs._ctx(lambda: False))
        assert state == "ok"
        assert "https://www.facebook.com" not in page.goto_calls

    def test_logged_out_page_is_still_logged_out(self):
        page = _FakePage(logged_out=True)
        state = FacebookWorker().verify_session(
            page, jobs._ctx(lambda: False))
        assert state == "logged_out"

    def test_checkpoint_names_checkpoint_in_job_error(self):
        # The checkpoint must persist on the job's target page too:
        # a checkpoint on the current page alone is re-checked at
        # the target (it may have been for one action only), and
        # only a checkpoint that is still there fails the job.
        # The home page is never part of this check.
        checkpoint_body = {"body_text": "Verify your identity to continue",
                           "title": "Checkpoint"}
        page = _FakePage(pages={
            CHECKPOINT_URL: checkpoint_body,
            GROUP_URL: checkpoint_body})
        page.goto(CHECKPOINT_URL)
        assert FacebookWorker().verify_session(
            page, jobs._ctx(lambda: False)) == "checkpoint"
        job = _scrape_job()
        _run_scrape(page, job)
        row = db.get_job(job["id"])
        assert row["status"] == "failed"
        assert "checkpoint" in (row["error"] or "")
        assert "sign in to Facebook" not in (row["error"] or "")
        assert "https://www.facebook.com" not in page.goto_calls
        assert page.goto_calls.count(GROUP_URL) >= 1

    def test_signed_in_page_ignores_target_url(self):
        # (a) A signed-in current page proves the session even when
        # a target is supplied — no navigation happens at all.
        page = self._signed_in_group_page()
        state = FacebookWorker().verify_session(
            page, jobs._ctx(lambda: False), GROUP_URL)
        assert state == "ok"
        assert page.goto_calls == [GROUP_URL]

    def test_blank_page_proves_session_at_target(self):
        # (b) A blank current page proves nothing, so the check
        # loads the job's target page: exactly one navigation, to
        # the target — home is never requested.
        page = _FakePage(
            pages={GROUP_URL: {
                "body_text": "Stock Market Traders. group feed",
                "title": "Stock Market Traders."}},
            blank=True)
        state = FacebookWorker().verify_session(
            page, jobs._ctx(lambda: False), GROUP_URL)
        assert state == "ok"
        assert page.goto_calls == [GROUP_URL]
        assert "https://www.facebook.com" not in page.goto_calls

    def test_target_proves_session_even_when_home_would_hang(self):
        # (c) Home hanging (or not existing) must not matter: the
        # target page alone proves the session.
        page = _FakePage(
            pages={GROUP_URL: {
                "body_text": "Stock Market Traders. group feed",
                "title": "Stock Market Traders."}},
            blank=True,
            goto_raises_for={"https://www.facebook.com"})
        state = FacebookWorker().verify_session(
            page, jobs._ctx(lambda: False), GROUP_URL)
        assert state == "ok"
        assert page.goto_calls == [GROUP_URL]
        assert "https://www.facebook.com" not in page.goto_calls

    def test_target_page_logged_out_names_sign_in(self):
        # (d) The target page shows a login wall: the state is
        # logged_out and the job error is the sign-in guidance.
        page = _FakePage(logged_out=True)
        assert FacebookWorker().verify_session(
            page, jobs._ctx(lambda: False), GROUP_URL) == "logged_out"
        job = _scrape_job()
        _run_scrape(page, job)
        row = db.get_job(job["id"])
        assert row["status"] == "failed"
        assert "sign in to Facebook" in (row["error"] or "")
        assert db.get_posts_for_source("src1") == []

    def test_target_page_never_loading_is_empty_not_signed_in(self):
        # (e) The target page never loads: the state is "empty" and
        # the job error says the page did not load — it never claims
        # the user is signed out.
        page = _FakePage(blank=True, goto_raises_for={GROUP_URL})
        assert FacebookWorker().verify_session(
            page, jobs._ctx(lambda: False), GROUP_URL) == "empty"
        assert "https://www.facebook.com" not in page.goto_calls
        job = _scrape_job()
        _run_scrape(page, job)
        row = db.get_job(job["id"])
        assert row["status"] == "failed"
        assert "did not load" in (row["error"] or "")
        assert "sign in to Facebook" not in (row["error"] or "")
        assert "https://www.facebook.com" not in page.goto_calls


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
        # Collect + delete validation (the 202 collect path spawns a
        # real browser thread, so only the 400/404 paths are tested
        # here; the run itself is covered by TestCollectSources).
        assert client.post("/collect-sources", json={}).status_code == 400
        assert client.post(
            "/collect-sources",
            json={"keyword": "stocks", "type": "nope"}).status_code == 400
        assert client.post("/sources/nope/delete").status_code == 404


# ---------------------------------------------------------------------------
# (j) Collect sources: comments gate + member gate + dedupe + join
# ---------------------------------------------------------------------------

SEARCH_GROUPS_URL = "https://www.facebook.com/search/groups?q=stocks"
SEARCH_PAGES_URL = "https://www.facebook.com/search/pages?q=stocks"
GOOD_GROUP = "https://www.facebook.com/groups/111"
DEAD_GROUP = "https://www.facebook.com/groups/222"
SMALL_GROUP = "https://www.facebook.com/groups/333"
UNKNOWN_GROUP = "https://www.facebook.com/groups/444"
ALREADY_GROUP = "https://www.facebook.com/groups/555"
GOOD_PAGE = "https://www.facebook.com/stockpage"


class TestCollectSources:
    def _collect_job(self, keyword="stocks", type_="group", max_new=10,
                     min_comments=3, min_members=100, account_id="acc1"):
        job_id = db.create_job("collect", account_id=account_id)
        job = db.get_job(job_id)
        job.update({"keyword": keyword, "type": type_, "max_new": max_new,
                    "min_comments": min_comments,
                    "min_members": min_members})
        return job

    def test_good_joined_dead_small_and_already_skipped(self):
        # Already joined by another account — must be skipped, and
        # must NOT be duplicated.
        db.upsert_source("src-old", "Already In", "group", ALREADY_GROUP,
                         8000, "joined", "acc9")
        anchors = [
            _FakeAnchor(GOOD_GROUP, "Stocks To Watch", "12K members"),
            _FakeAnchor(DEAD_GROUP, "Dead Group", "5K members"),
            _FakeAnchor(SMALL_GROUP, "Tiny Group", "50 members"),
            _FakeAnchor(UNKNOWN_GROUP, "Mystery Group", None),
            _FakeAnchor(ALREADY_GROUP, "Already In", "8K members"),
        ]
        gate = {
            GOOD_GROUP: {"posts": 5, "comments": 40},
            DEAD_GROUP: {"posts": 3, "comments": 1},
            SMALL_GROUP: {"posts": 4, "comments": 30},
            UNKNOWN_GROUP: {"posts": 2, "comments": 25},
            ALREADY_GROUP: {"posts": 9, "comments": 99},
        }
        page = _FakePage(
            anchors_by_url={SEARCH_GROUPS_URL: anchors},
            gate_by_url=gate,
            join_urls={GOOD_GROUP, UNKNOWN_GROUP})
        job = self._collect_job()
        jobs.run_collect_sources(FacebookWorker(), page, db, job,
                                 lambda: False)
        row = db.get_job(job["id"])
        assert row["status"] == "done"
        assert row["new_posts"] == 2
        sources = (row.get("result") or {}).get("sources") or []
        assert {s["url"] for s in sources} == {GOOD_GROUP, UNKNOWN_GROUP}
        # Dead (1 comment < 3) and small (50 members < 100) never saved.
        assert db.get_source_by_url(DEAD_GROUP) is None
        assert db.get_source_by_url(SMALL_GROUP) is None
        # Already-joined kept exactly once, under its original id.
        assert db.get_source_by_url(ALREADY_GROUP)["id"] == "src-old"
        # Unknown member count did NOT block the run: the group was
        # read once, no count found, and it proceeded on the gate.
        assert db.get_source_by_url(UNKNOWN_GROUP) is not None
        assert db.get_source_by_url(GOOD_GROUP)["member_count"] == 12000

    def test_gate_scrolls_patiently_before_joining(self):
        # Live bug: the feed shows ~1 post on arrival and the 2nd
        # only after a scroll, so a one-shot count saw 0 comments
        # and good groups were skipped. The gate must scroll and
        # re-count until the gate passes — then join.
        anchors = [_FakeAnchor(GOOD_GROUP, "Stocks To Watch", "12K members")]
        page = _FakePage(
            anchors_by_url={SEARCH_GROUPS_URL: anchors},
            gate_sequence_by_url={GOOD_GROUP: [
                {"posts": 1, "comments": 0},
                {"posts": 2, "comments": 0},
                {"posts": 5, "comments": 40},
            ]},
            feed_loading_by_url={GOOD_GROUP: 2},
            join_urls={GOOD_GROUP})
        job = self._collect_job()
        jobs.run_collect_sources(FacebookWorker(), page, db, job,
                                 lambda: False)
        row = db.get_job(job["id"])
        assert row["status"] == "done"
        assert row["new_posts"] == 1
        assert db.get_source_by_url(GOOD_GROUP) is not None
        # Stopped as soon as the gate passed — 2 scrolls, not 8.
        assert page._feed_scrolls == 2

    def test_gate_skips_dead_group_after_patient_scrolling(self):
        # A group whose feed never yields comments must still be
        # skipped — but only after patient scrolling, and the run
        # must terminate (no infinite scroll). The skip note must
        # name the group with the counted posts/comments.
        anchors = [_FakeAnchor(DEAD_GROUP, "Dead Group", "5K members")]
        notes: list[str] = []
        page = _FakePage(
            anchors_by_url={SEARCH_GROUPS_URL: anchors},
            gate_sequence_by_url={DEAD_GROUP: [
                {"posts": 2, "comments": 0},
            ]},
            feed_loading_by_url={DEAD_GROUP: 1})
        job = self._collect_job()
        jobs.run_collect_sources(FacebookWorker(), page, db, job,
                                 lambda: False, note=notes.append)
        row = db.get_job(job["id"])
        assert row["status"] == "done"
        assert row["new_posts"] == 0
        assert db.get_source_by_url(DEAD_GROUP) is None
        assert page._feed_scrolls <= 8
        assert any("Dead Group" in n and "2 post(s)" in n
                   and "0 comment(s)" in n for n in notes)

    def test_gate_does_not_scroll_when_first_screen_passes(self):
        # No pointless scrolling: a group already over the gate on
        # the first screen is decided at once.
        anchors = [_FakeAnchor(GOOD_GROUP, "Stocks To Watch", "12K members")]
        page = _FakePage(
            anchors_by_url={SEARCH_GROUPS_URL: anchors},
            gate_by_url={GOOD_GROUP: {"posts": 5, "comments": 40}},
            join_urls={GOOD_GROUP})
        job = self._collect_job()
        jobs.run_collect_sources(FacebookWorker(), page, db, job,
                                 lambda: False)
        assert db.get_source_by_url(GOOD_GROUP) is not None
        assert page._feed_scrolls == 0

    def test_join_failure_means_not_saved(self):
        anchors = [_FakeAnchor(GOOD_GROUP, "Stocks To Watch", "12K members")]
        gate = {GOOD_GROUP: {"posts": 5, "comments": 40}}
        # No Join button on this fake page (join_urls empty) — the
        # group must NOT be saved.
        page = _FakePage(
            anchors_by_url={SEARCH_GROUPS_URL: anchors}, gate_by_url=gate)
        job = self._collect_job()
        jobs.run_collect_sources(FacebookWorker(), page, db, job,
                                 lambda: False)
        row = db.get_job(job["id"])
        assert row["status"] == "done"
        assert row["new_posts"] == 0
        assert db.get_source_by_url(GOOD_GROUP) is None

    def test_max_new_caps_the_run(self):
        anchors = [
            _FakeAnchor(GOOD_GROUP, "Stocks To Watch", "12K members"),
            _FakeAnchor(UNKNOWN_GROUP, "Mystery Group", None),
        ]
        gate = {
            GOOD_GROUP: {"posts": 5, "comments": 40},
            UNKNOWN_GROUP: {"posts": 2, "comments": 25},
        }
        page = _FakePage(
            anchors_by_url={SEARCH_GROUPS_URL: anchors},
            gate_by_url=gate,
            join_urls={GOOD_GROUP, UNKNOWN_GROUP})
        job = self._collect_job(max_new=1)
        jobs.run_collect_sources(FacebookWorker(), page, db, job,
                                 lambda: False)
        row = db.get_job(job["id"])
        assert row["new_posts"] == 1
        assert len((row.get("result") or {}).get("sources") or []) == 1

    def test_page_is_recorded_not_joined(self):
        anchors = [_FakeAnchor(GOOD_PAGE, "Stock Page", "9K followers")]
        gate = {GOOD_PAGE: {"posts": 6, "comments": 55}}
        page = _FakePage(
            anchors_by_url={SEARCH_PAGES_URL: anchors}, gate_by_url=gate)
        job = self._collect_job(type_="page")
        jobs.run_collect_sources(FacebookWorker(), page, db, job,
                                 lambda: False)
        row = db.get_job(job["id"])
        assert row["status"] == "done"
        assert row["new_posts"] == 1
        saved = db.get_source_by_url(GOOD_PAGE)
        assert saved is not None
        assert saved["type"] == "page"
        assert saved["member_count"] == 9000

    def test_no_keyword_fails_the_job(self):
        page = _FakePage()
        job = self._collect_job(keyword="")
        jobs.run_collect_sources(FacebookWorker(), page, db, job,
                                 lambda: False)
        row = db.get_job(job["id"])
        assert row["status"] == "failed"
        assert "keyword" in (row["error"] or "")


# ---------------------------------------------------------------------------
# (k) Delete source: leave-then-remove; leave failure keeps the row
# ---------------------------------------------------------------------------

class TestDeleteSource:
    def _seed_source_with_post(self):
        db.upsert_source("src1", "Stocks To Watch", "group", GROUP_URL,
                         12000, "joined", "acc1")
        db.save_post({
            "source_id": "src1", "account_id": "acc1",
            "post_url": POST_URLS[0], "author_name": "Poster",
            "author_url": "https://www.facebook.com/poster",
            "text": "post text", "collected_at": NOW.isoformat(),
            "comments": [{
                "author_name": "Amit",
                "author_url": "https://www.facebook.com/amit",
                "text": "nice", "posted_at": None,
                "posted_at_label": "5d",
                "replies": [{
                    "author_name": "Sana",
                    "author_url": "https://www.facebook.com/sana",
                    "text": "agreed", "posted_at": None,
                    "posted_at_label": "5d", "replies": []}]}]})

    def test_leave_success_removes_source_and_posts(self):
        self._seed_source_with_post()
        page = _FakePage(leave_flow={
            "url": GROUP_URL,
            "joined_body": "Stocks To Watch Joined 12K members",
            "left_body": "Stocks To Watch Join group 12K members"})
        result = jobs.delete_source(FacebookWorker(), page, db, "src1")
        assert result == {"ok": True, "left": True,
                          "detail": "Left the group and removed it "
                                    "from the list."}
        assert db.get_source_by_id("src1") is None
        assert db.get_posts_for_source("src1") == []
        assert db.get_post_by_url(POST_URLS[0]) is None

    def test_leave_failure_keeps_row_and_posts(self):
        self._seed_source_with_post()
        # Plain fake page: no Joined button anywhere, so the leave
        # cannot happen — the row must stay for a retry.
        page = _FakePage()
        result = jobs.delete_source(FacebookWorker(), page, db, "src1")
        assert result["ok"] is False
        assert result["left"] is False
        assert "still in the list" in result["detail"]
        assert db.get_source_by_id("src1") is not None
        assert db.get_post_by_url(POST_URLS[0]) is not None

    def test_delete_unknown_source(self):
        page = _FakePage()
        result = jobs.delete_source(FacebookWorker(), page, db, "nope")
        assert result["ok"] is False
        assert result["detail"] == "Source not found."


# ---------------------------------------------------------------------------
# (l) Source DB helpers
# ---------------------------------------------------------------------------

class TestSourceDb:
    def test_get_source_by_url_and_delete_cascade(self):
        db.upsert_source("src1", "Stocks To Watch", "group", GROUP_URL,
                         12000, "joined", "acc1")
        assert db.get_source_by_url(GROUP_URL)["id"] == "src1"
        assert db.get_source_by_url("https://www.facebook.com/groups/999") is None
        db.save_post({
            "source_id": "src1", "account_id": "acc1",
            "post_url": POST_URLS[0], "author_name": "Poster",
            "author_url": "https://www.facebook.com/poster",
            "text": "post text", "collected_at": NOW.isoformat(),
            "comments": [{
                "author_name": "Amit",
                "author_url": "https://www.facebook.com/amit",
                "text": "nice", "posted_at": None,
                "posted_at_label": "5d",
                "replies": [{
                    "author_name": "Sana",
                    "author_url": "https://www.facebook.com/sana",
                    "text": "agreed", "posted_at": None,
                    "posted_at_label": "5d", "replies": []}]}]})
        assert db.delete_source("src1") is True
        assert db.get_source_by_id("src1") is None
        assert db.get_post_by_url(POST_URLS[0]) is None
        assert db.delete_source("src1") is False

# ---------------------------------------------------------------------------
# (m) Configurable Chrome profile (LEADHUNTER_CHROME_PROFILE)
# ---------------------------------------------------------------------------
# Imports kept local to this section: the profile tests stub the
# Playwright import, so no real browser is ever launched.

import time
import types
from unittest import mock


def _install_fake_playwright(monkeypatch, launch_error=None):
    """Install a fake ``playwright.sync_api``; return the launch mock.

    The fake records the ``launch_persistent_context`` kwargs (so
    tests can assert which profile dir was used) and either returns
    a fake context with one page or raises ``launch_error``.
    """
    handle = mock.MagicMock(name="playwright-handle")
    context = mock.MagicMock(name="context")
    context.pages = [mock.MagicMock(name="page")]
    chromium = mock.MagicMock(name="chromium")
    if launch_error is not None:
        chromium.launch_persistent_context.side_effect = launch_error
    else:
        chromium.launch_persistent_context.return_value = context
    handle.chromium = chromium
    starter = mock.MagicMock(name="sync-playwright")
    starter.start.return_value = handle
    sync_api = types.ModuleType("playwright.sync_api")
    sync_api.sync_playwright = mock.MagicMock(return_value=starter)
    playwright_mod = types.ModuleType("playwright")
    playwright_mod.sync_api = sync_api
    monkeypatch.setitem(sys.modules, "playwright", playwright_mod)
    monkeypatch.setitem(sys.modules, "playwright.sync_api", sync_api)
    return chromium, handle


def _reset_main_browser():
    try:
        import main
    except Exception:
        return
    main._page = None
    main._playwright = None


class TestChromeProfile:
    @pytest.fixture(autouse=True)
    def _reset_browser_state(self):
        _reset_main_browser()
        yield
        _reset_main_browser()

    def test_resolve_chrome_profile_variants(self, monkeypatch, tmp_path):
        pytest.importorskip("fastapi")
        import main

        default = Path(main.__file__).resolve().parent / ".chrome-profile"
        monkeypatch.delenv("LEADHUNTER_CHROME_PROFILE", raising=False)
        assert main.resolve_chrome_profile() == default

        # Whitespace-only means the default.
        monkeypatch.setenv("LEADHUNTER_CHROME_PROFILE", "   \n")
        assert main.resolve_chrome_profile() == default

        # Plain path, whitespace trimmed.
        monkeypatch.setenv("LEADHUNTER_CHROME_PROFILE",
                           f"  {tmp_path / 'prof'}  ")
        assert main.resolve_chrome_profile() == tmp_path / "prof"

        # ~ and env vars are expanded.
        monkeypatch.setenv("LEADHUNTER_CHROME_PROFILE", "~/my-profile")
        resolved = main.resolve_chrome_profile()
        assert str(resolved).endswith("my-profile")
        assert not str(resolved).startswith("~")
        monkeypatch.setenv("LEADHUNTER_HOME", "/tmp/lh-home")
        monkeypatch.setenv("LEADHUNTER_CHROME_PROFILE",
                           "$LEADHUNTER_HOME/prof")
        assert main.resolve_chrome_profile() == Path("/tmp/lh-home/prof")

    def test_env_var_profile_used_for_launch(self, monkeypatch):
        pytest.importorskip("fastapi")
        import main

        monkeypatch.setenv(
            "LEADHUNTER_CHROME_PROFILE",
            "G:\\Web Apps\\client-hunting\\data\\profiles\\Master")
        chromium, _handle = _install_fake_playwright(monkeypatch)
        page = main._get_page()
        assert page is not None
        chromium.launch_persistent_context.assert_called_once()
        kwargs = chromium.launch_persistent_context.call_args.kwargs
        assert kwargs["user_data_dir"] == (
            "G:\\Web Apps\\client-hunting\\data\\profiles\\Master")
        assert kwargs["headless"] is False
        assert "--disable-blink-features=AutomationControlled" in kwargs["args"]

    def test_default_profile_used_when_env_unset(self, monkeypatch):
        pytest.importorskip("fastapi")
        import main

        monkeypatch.delenv("LEADHUNTER_CHROME_PROFILE", raising=False)
        chromium, _handle = _install_fake_playwright(monkeypatch)
        main._get_page()
        kwargs = chromium.launch_persistent_context.call_args.kwargs
        expected = str(Path(main.__file__).resolve().parent / ".chrome-profile")
        assert kwargs["user_data_dir"] == expected

    def test_launch_prints_resolved_profile(self, monkeypatch, tmp_path,
                                            capsys):
        pytest.importorskip("fastapi")
        import main

        # Existing dir -> "exists: yes".
        existing = tmp_path / "prof"
        existing.mkdir()
        monkeypatch.setenv("LEADHUNTER_CHROME_PROFILE", str(existing))
        _install_fake_playwright(monkeypatch)
        main._get_page()
        out = capsys.readouterr().out
        assert f"[leadhunter] Chrome profile: {existing}" in out
        assert "(exists: yes)" in out

        # Missing dir -> "exists: no" (the launch still proceeds; the
        # browser creates the dir on first real use).
        _reset_main_browser()
        missing = tmp_path / "nope"
        monkeypatch.setenv("LEADHUNTER_CHROME_PROFILE", str(missing))
        _install_fake_playwright(monkeypatch)
        main._get_page()
        out = capsys.readouterr().out
        assert f"[leadhunter] Chrome profile: {missing}" in out
        assert "(exists: no)" in out

    def test_profile_in_use_fails_job_with_plain_message(self, monkeypatch):
        pytest.importorskip("fastapi")
        pytest.importorskip("httpx")
        from fastapi.testclient import TestClient
        import main

        lock_error = Exception(
            "browserType.launchPersistentContext: Failed to launch: "
            "user data directory is already in use")
        _install_fake_playwright(monkeypatch, launch_error=lock_error)
        client = TestClient(main.app)
        resp = client.post("/scrape", json={
            "sourceId": "src1",
            "sourceUrl": GROUP_URL,
            "sourceName": "Stocks To Watch",
            "accountId": "acc1",
        })
        assert resp.status_code == 202
        job_id = resp.json()["jobId"]
        row = None
        for _ in range(200):
            row = client.get(f"/jobs/{job_id}").json()["job"]
            if row["status"] == "failed":
                break
            time.sleep(0.05)
        assert row is not None and row["status"] == "failed"
        assert row["error"] == main.PROFILE_IN_USE_MESSAGE
        # Launch state is reset, so a later job retries the launch.
        assert main._page is None and main._playwright is None
        # ... and the agent itself is still up.
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json()["ok"] is True

    def test_delete_endpoint_reports_profile_in_use(self, monkeypatch):
        pytest.importorskip("fastapi")
        pytest.importorskip("httpx")
        from fastapi.testclient import TestClient
        import main

        db.upsert_source("src1", "Stocks To Watch", "group", GROUP_URL,
                         12000, "joined", "acc1")
        lock_error = Exception("The profile appears to be in use by "
                               "another browser process (SingletonLock)")
        _install_fake_playwright(monkeypatch, launch_error=lock_error)
        client = TestClient(main.app)
        resp = client.post("/sources/src1/delete")
        assert resp.status_code == 500
        assert resp.json()["detail"] == main.PROFILE_IN_USE_MESSAGE
        # The row was not touched.
        assert db.get_source_by_id("src1") is not None
        health = client.get("/health")
        assert health.status_code == 200
