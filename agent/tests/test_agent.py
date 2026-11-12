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
from facebook import (  # noqa: E402
    _ARTICLE_COUNT_JS,
    _CLOSE_DIALOG_JS,
    _FEED_DIAG_JS,
    _FEED_POSTS_JS,
    _OPEN_FEED_POST_JS,
    FacebookWorker,
)
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
                 blank=False, feed_diag=None, open_post_result=True,
                 open_post_url=None, ready_after=0,
                 transient_empty_calls=None):
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
        # feed_diag: canned result for the "feed-diag" diagnostic
        # pass (None = a plausible mixed feed). open_post_result /
        # open_post_url: what the "open-feed-post" click does — True
        # sets the address bar to open_post_url (the dialog's real
        # post URL), False means the post was not found in the feed.
        # ready_after: inner_text("body") stays "" for the first N
        # calls (a mid-render page) and links stay hidden until
        # then — 0 keeps the old behaviour (content at once).
        # transient_empty_calls: 1-based inner_text("body") call
        # numbers during which the page reads as torn down — a
        # transient SPA re-hydration AFTER the page was ready
        # (Gemini's second-press diagnosis): inner_text returns
        # "", links stay hidden and every locator counts 0, even
        # though the calls before and after return real content.
        self._ready_after = ready_after
        self._ready_calls = 0
        self._transient_empty = set(transient_empty_calls or [])
        self._feed_diag = feed_diag if feed_diag is not None else {
            "total": 7, "article_tags": 0, "role_articles": 7,
            "top_level": 7, "nested": 0, "non_comment_top": 2,
            "with_heading": 0, "with_permalink": 5,
            "with_bare_permalink": 2, "with_comment_button": 0,
            "with_comment_label": 2,
            "samples": [
                {"aria_label": "",
                 "text_head": "Jj Mathosi Jj Mathosi 18 May Lost 2k with "
                              "amd call and made 4,5k with spy calls",
                 "hrefs": ["https://www.facebook.com/groups/"
                           "572426944223825/permalink/1697550221711486/"],
                 "comment_labels": ["Comment"],
                 "has_bare_permalink": True, "has_permalink": True,
                 "has_comment_button": False},
                {"aria_label": "Barbara",
                 "text_head": "Barbara Check this chart",
                 "hrefs": [], "comment_labels": ["Comment"],
                 "has_bare_permalink": False, "has_permalink": False,
                 "has_comment_button": False},
            ]}
        self._open_post_result = open_post_result
        self._open_post_url = (open_post_url or
            "https://www.facebook.com/groups/572426944223825/permalink/999/")
        self.open_calls = []
        self.close_calls = 0
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
            self._ready_calls += 1
            if self._ready_calls <= self._ready_after:
                return ""
            if self._ready_calls in self._transient_empty:
                return ""
            return self._body
        return ""

    def query_selector_all(self, selector):
        if "a[href]" in selector:
            if self._ready_after > 0 and \
                    self._ready_calls <= self._ready_after:
                return []
            if self._ready_calls in self._transient_empty:
                return []
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
        if self._ready_calls in self._transient_empty:
            # Transient SPA teardown: every read momentarily
            # returns nothing — the session check must retry.
            return _FakeLocator(0)
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
        if "feed-diag" in js:
            return dict(self._feed_diag)
        if "open-feed-post" in js:
            self.open_calls.append(args[0] if args else None)
            if self._open_post_result:
                self.url = self._open_post_url
            return self._open_post_result
        if "close-dialog" in js:
            self.close_calls += 1
            return True
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

    def test_message_names_the_breakdown(self):
        # The old "every candidate failed the gate" hid whether the
        # search found 0 candidates or 20 gated ones. The message
        # must name the counts.
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
        assert row["message"] == (
            "Joined 2 new sources for 'stocks' "
            "(5 candidate(s): 1 already joined, 1 too few members, "
            "1 no comments, 0 join failed)")
        assert (row.get("result") or {}).get("counts") == {
            "candidates": 5, "already_joined": 1, "too_few_members": 1,
            "no_comments": 1, "join_failed": 0}

    def test_zero_candidates_message(self):
        # A search that returns nothing must say so — not blame
        # the gates.
        page = _FakePage()
        job = self._collect_job()
        jobs.run_collect_sources(FacebookWorker(), page, db, job,
                                 lambda: False)
        row = db.get_job(job["id"])
        assert row["status"] == "done"
        assert row["new_posts"] == 0
        assert row["message"] == (
            "No new sources for 'stocks' — 0 candidate(s): "
            "0 already joined, 0 too few members, 0 no comments, "
            "0 join failed")

    def test_gate_notes_when_feed_never_renders(self):
        # A group whose feed never renders articles must be skipped
        # with a note naming the cause — not a silent zero count.
        anchors = [_FakeAnchor(GOOD_GROUP, "Stocks To Watch", "12K members")]
        notes: list[str] = []
        page = _FakePage(
            anchors_by_url={SEARCH_GROUPS_URL: anchors},
            article_count=0)
        job = self._collect_job()
        jobs.run_collect_sources(FacebookWorker(), page, db, job,
                                 lambda: False, note=notes.append)
        row = db.get_job(job["id"])
        assert row["status"] == "done"
        assert row["new_posts"] == 0
        assert db.get_source_by_url(GOOD_GROUP) is None
        assert any("never rendered articles" in n and GOOD_GROUP in n
                   for n in notes)


class TestSearchFallback:
    def test_fallback_loads_search_url_not_home(self):
        # Live fact: the Facebook home page hangs in this Chromium
        # (see verify_session), so the search-box fallback must
        # never load it — it loads the search results page, which
        # carries the same search box. Home raising here proves
        # the fallback does not touch it.
        page = _FakePage(
            goto_raises_for={"https://www.facebook.com"})
        out = FacebookWorker()._search_via_ui(
            page, "stocks", "Groups", None, kind="groups")
        assert out == []
        assert page.goto_calls == [SEARCH_GROUPS_URL]
        assert "https://www.facebook.com" not in page.goto_calls


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
    main._context = None
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
        # Headless is the default — a visible window needs
        # LEADHUNTER_HEADED=1 (see TestHeadlessBrowser).
        assert kwargs["headless"] is True
        assert "--disable-blink-features=AutomationControlled" in kwargs["args"]
        assert "--no-first-run" in kwargs["args"]
        assert "--no-default-browser-check" in kwargs["args"]
        assert kwargs["viewport"] == {"width": 1280, "height": 800}

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
        assert main._context is None
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


# ---------------------------------------------------------------------------
# (m-b) Headless by default (LEADHUNTER_HEADED escape hatch)
# ---------------------------------------------------------------------------
# The agent's browser runs headless — no window, silent, exactly like
# client-hunting. LEADHUNTER_HEADED=1 forces a visible window for a
# fresh Facebook sign-in. Closing the agent stops the browser cleanly
# (FastAPI lifespan), so the next launch never shows Chromium's
# "Restore pages?" popup.


class TestHeadlessBrowser:
    @pytest.fixture(autouse=True)
    def _reset_browser_state(self):
        _reset_main_browser()
        yield
        _reset_main_browser()

    @pytest.mark.parametrize("value,expected", [
        (None, False),
        ("", False),
        ("   ", False),
        ("0", False),
        ("false", False),
        ("False", False),
        ("no", False),
        ("on", False),
        ("1", True),
        (" 1 ", True),
        ("true", True),
        ("TRUE", True),
        ("True", True),
        ("yes", True),
        ("Yes", True),
    ])
    def test_headed_env_parsing(self, monkeypatch, value, expected):
        pytest.importorskip("fastapi")
        import main

        if value is None:
            monkeypatch.delenv("LEADHUNTER_HEADED", raising=False)
        else:
            monkeypatch.setenv("LEADHUNTER_HEADED", value)
        assert main._headed_env() is expected

    def test_headed_env_forces_visible_window(self, monkeypatch, capsys):
        pytest.importorskip("fastapi")
        import main

        monkeypatch.setenv("LEADHUNTER_HEADED", "1")
        chromium, _handle = _install_fake_playwright(monkeypatch)
        main._get_page()
        kwargs = chromium.launch_persistent_context.call_args.kwargs
        assert kwargs["headless"] is False
        out = capsys.readouterr().out
        assert "[leadhunter] Browser: headed (visible window)" in out

    def test_launch_is_headless_and_prints_mode(self, monkeypatch, capsys):
        pytest.importorskip("fastapi")
        import main

        monkeypatch.delenv("LEADHUNTER_HEADED", raising=False)
        _install_fake_playwright(monkeypatch)
        main._get_page()
        out = capsys.readouterr().out
        assert "[leadhunter] Browser: headless" in out

    def test_close_browser_closes_context_and_resets(self, monkeypatch):
        pytest.importorskip("fastapi")
        import main

        chromium, handle = _install_fake_playwright(monkeypatch)
        context = chromium.launch_persistent_context.return_value
        main._get_page()
        assert main._page is not None
        assert main._context is context
        assert main._playwright is handle
        main._close_browser()
        context.close.assert_called_once()
        handle.stop.assert_called_once()
        assert main._page is None
        assert main._context is None
        assert main._playwright is None
        # Idempotent — a second close with nothing launched is a no-op.
        main._close_browser()
        context.close.assert_called_once()
        handle.stop.assert_called_once()

    def test_get_page_reuses_live_page(self, monkeypatch):
        pytest.importorskip("fastapi")
        import main

        chromium, _handle = _install_fake_playwright(monkeypatch)
        page = chromium.launch_persistent_context.return_value.pages[0]
        page.is_closed.return_value = False
        first = main._get_page()
        second = main._get_page()
        assert first is second is page
        chromium.launch_persistent_context.assert_called_once()

    def test_get_page_rebuilds_closed_page(self, monkeypatch):
        pytest.importorskip("fastapi")
        import main

        chromium, _handle = _install_fake_playwright(monkeypatch)
        context1 = chromium.launch_persistent_context.return_value
        page1 = context1.pages[0]
        page1.is_closed.return_value = False
        assert main._get_page() is page1
        # The page died — the next call must close the old browser
        # and relaunch instead of reusing the dead page.
        page1.is_closed.return_value = True
        context2 = mock.MagicMock(name="context2")
        page2 = mock.MagicMock(name="page2")
        page2.is_closed.return_value = False
        context2.pages = [page2]
        chromium.launch_persistent_context.side_effect = [context2]
        assert main._get_page() is page2
        assert chromium.launch_persistent_context.call_count == 2
        context1.close.assert_called_once()
        assert main._context is context2

    def test_lifespan_shutdown_closes_browser(self, monkeypatch):
        pytest.importorskip("fastapi")
        pytest.importorskip("httpx")
        from fastapi.testclient import TestClient
        import main

        chromium, _handle = _install_fake_playwright(monkeypatch)
        context = chromium.launch_persistent_context.return_value
        main._get_page()
        assert main._page is not None
        with TestClient(main.app) as client:
            assert client.get("/health").status_code == 200
        # Leaving the TestClient context runs the lifespan shutdown.
        context.close.assert_called_once()
        assert main._page is None
        assert main._context is None
        assert main._playwright is None


# ---------------------------------------------------------------------------
# (m-c) Dead browser connection: relaunch instead of reusing a corpse
# ---------------------------------------------------------------------------
# Live 2026-11-12: after the 1st Scrap the headless Chromium process
# died — the 2nd press's diagnostic read body_len=-1 with every
# selector "error", and goto failed with "Playwright connection
# closed". page.is_closed() cannot spot this (it is local state),
# so the agent kept reusing the dead page. The fix probes
# browser.is_connected() and relaunches from the same profile.


class TestDeadBrowserRelaunch:
    @pytest.fixture(autouse=True)
    def _reset_browser_state(self):
        _reset_main_browser()
        yield
        _reset_main_browser()

    def test_dead_connection_error_markers(self):
        pytest.importorskip("fastapi")
        import main

        assert main._is_dead_connection_error(
            Exception("Playwright connection closed"))
        assert main._is_dead_connection_error(Exception("Target closed"))
        assert main._is_dead_connection_error(
            Exception("Browser has been closed"))
        assert not main._is_dead_connection_error(
            Exception("Timeout 30000ms exceeded"))
        assert not main._is_dead_connection_error(
            Exception("net::ERR_FAILED"))

    def test_get_page_relaunches_dead_connection(self, monkeypatch):
        pytest.importorskip("fastapi")
        import main

        chromium, _handle = _install_fake_playwright(monkeypatch)
        context1 = chromium.launch_persistent_context.return_value
        page1 = context1.pages[0]
        page1.is_closed.return_value = False
        page1.context.browser.is_connected.return_value = True
        assert main._get_page() is page1
        # The browser process died after the 1st job, although the
        # page itself was never closed — the next call must close
        # the old browser and relaunch instead of reusing it.
        page1.context.browser.is_connected.return_value = False
        context2 = mock.MagicMock(name="context2")
        page2 = mock.MagicMock(name="page2")
        page2.is_closed.return_value = False
        page2.context.browser.is_connected.return_value = True
        context2.pages = [page2]
        chromium.launch_persistent_context.side_effect = [context2]
        assert main._get_page() is page2
        assert chromium.launch_persistent_context.call_count == 2
        context1.close.assert_called_once()
        assert main._context is context2

    def test_get_page_reuses_live_connection(self, monkeypatch):
        pytest.importorskip("fastapi")
        import main

        chromium, _handle = _install_fake_playwright(monkeypatch)
        page = chromium.launch_persistent_context.return_value.pages[0]
        page.is_closed.return_value = False
        page.context.browser.is_connected.return_value = True
        first = main._get_page()
        second = main._get_page()
        assert first is second is page
        chromium.launch_persistent_context.assert_called_once()

    def test_fresh_page_relaunches_on_closed_connection(self, monkeypatch):
        pytest.importorskip("fastapi")
        import main

        chromium, _handle = _install_fake_playwright(monkeypatch)
        context1 = chromium.launch_persistent_context.return_value
        page1 = context1.pages[0]
        page1.is_closed.return_value = False
        page1.context.browser.is_connected.return_value = True
        assert main._get_page() is page1
        # The browser dies between _get_page() and new_page().
        context1.new_page.side_effect = Exception(
            "Playwright connection closed")
        context2 = mock.MagicMock(name="context2")
        page2 = mock.MagicMock(name="page2")
        page2.is_closed.return_value = False
        page2.context.browser.is_connected.return_value = True
        context2.pages = [page2]
        chromium.launch_persistent_context.side_effect = [context2]
        fresh = main._fresh_page()
        assert fresh is page2
        assert fresh is not page1
        assert chromium.launch_persistent_context.call_count == 2
        assert main._context is context2

    def test_fresh_page_keeps_old_fallback_for_other_errors(self, monkeypatch):
        pytest.importorskip("fastapi")
        import main

        chromium, _handle = _install_fake_playwright(monkeypatch)
        context1 = chromium.launch_persistent_context.return_value
        page1 = context1.pages[0]
        page1.is_closed.return_value = False
        page1.context.browser.is_connected.return_value = True
        assert main._get_page() is page1
        # A non-connection failure opening a tab keeps the old
        # behaviour: fall back to the existing page, no relaunch.
        context1.new_page.side_effect = Exception("Timeout 30000ms exceeded")
        assert main._fresh_page() is page1
        chromium.launch_persistent_context.assert_called_once()


# ---------------------------------------------------------------------------
# (i) Feed selectors: literal <article> tags + comment-button opening
# ---------------------------------------------------------------------------

class TestFeedSelectors:
    def test_feed_js_selects_literal_article_tags(self):
        # Live feed posts are literal <article> tags (implicit role,
        # no role attribute) — the old div[role="article"]-only
        # selector found nothing. Both forms must be selected, and a
        # nested <article> must count as nested just like a nested
        # role="article" ancestor.
        assert 'article, div[role="article"]' in _FEED_POSTS_JS
        assert 'article, div[role="article"]' in _ARTICLE_COUNT_JS
        assert "tagName === 'ARTICLE'" in _FEED_POSTS_JS
        assert "tagName === 'ARTICLE'" in _FEED_DIAG_JS
        assert "tagName === 'ARTICLE'" in _OPEN_FEED_POST_JS

    def test_feed_js_keeps_comment_button_posts_without_permalink(self):
        # A post with no /permalink/ or /posts/ link (e.g. a photo
        # post) is kept when it has a comment button, keyed so it
        # can be opened via that button later.
        assert "has_comment_button" in _FEED_POSTS_JS
        assert "post_url: url" in _FEED_POSTS_JS
        assert "open-feed-post" in _OPEN_FEED_POST_JS
        assert "close-dialog" in _CLOSE_DIALOG_JS


class TestFeedDiagnostic:
    def test_zero_new_posts_emits_diagnostic_and_finishes_done(self):
        # A completed 0-post run is a finish, not a failure: the job
        # is "done", its message carries the feed diagnostic, and
        # the source's last_scraped_at advances so the row shows
        # this run instead of an old failure.
        page = _FakePage(
            pages={GROUP_URL: {
                "body_text": "Stock Market Traders. group feed",
                "title": "Stock Market Traders."}},
            feed_posts=[])
        job = _scrape_job()
        notes = []
        jobs.run_scrape(FacebookWorker(), page, db, job,
                        lambda: False, note=notes.append)
        row = db.get_job(job["id"])
        assert row["status"] == "done"
        assert row["error"] is None
        assert row["new_posts"] == 0
        assert any("feed diagnostic:" in n for n in notes)
        assert any("7 article-ish elements (0 <article>, 7 div[role=\"article\"])" in n
                   for n in notes)
        assert any("2 non-comment top-level" in n for n in notes)
        assert any("2 with bare permalink" in n for n in notes)
        assert any("comment button" in n for n in notes)
        assert any("permalink/1697550221711486" in n for n in notes)
        assert row["message"] and "feed diagnostic:" in row["message"]
        src = db.get_source_by_id("src1")
        assert src is not None and src["last_scraped_at"]


# ---------------------------------------------------------------------------
# (i-b) Feed posts, real shapes (live diagnostic 2026-11-12 ~04:50 PKT):
# no "<Name>'s post" heading anywhere, comments carry comment_id
# links, the comment-button pattern matches nothing. The heading
# gate is gone: a post is a top-level non-comment article with a
# bare permalink (no comment_id); the author comes from the first
# innerText line and never blocks collection; the count is optional.
# ---------------------------------------------------------------------------

class TestFeedPostsRealShapes:
    def test_heading_gate_is_gone(self):
        # The diagnostic proved 0 of 7 live elements have a
        # "<Name>'s post" heading — the gate rejected every real
        # post. It must not appear in the collection path at all.
        assert "headingName" not in _FEED_POSTS_JS
        assert "headingName" not in _OPEN_FEED_POST_JS
        assert "barePostLink" in _FEED_POSTS_JS
        assert "comment_id" in _FEED_POSTS_JS
        assert "authorName" in _FEED_POSTS_JS
        assert "collapseDoubled" in _FEED_POSTS_JS
        assert "collapseDoubled" in _OPEN_FEED_POST_JS

    def test_comment_count_is_optional_and_broad(self):
        # The strict "Comment on X's post, N comments" pattern
        # matched 0 live elements. The count comes from any
        # descendant whose aria-label contains "comment" with a
        # number near it — and collection never depends on it.
        assert "commentCount" in _FEED_POSTS_JS
        assert "/comment/i" in _FEED_POSTS_JS
        assert "commentButton" in _FEED_POSTS_JS
        assert "commentButton" in _OPEN_FEED_POST_JS

    def test_diag_captures_non_comment_details(self):
        assert "non_comment_top" in _FEED_DIAG_JS
        assert "hrefs" in _FEED_DIAG_JS
        assert "comment_labels" in _FEED_DIAG_JS
        assert "has_bare_permalink" in _FEED_DIAG_JS
        assert "with_bare_permalink" in _FEED_DIAG_JS


class TestFeedAuthorNeverBlocks:
    def test_empty_author_name_still_collected(self):
        # The author is never a gate: a post with a bare permalink
        # and an empty name is still collected and saved.
        page = _FakePage(
            pages={GROUP_URL: {
                "body_text": "Stock Market Traders. group feed",
                "title": "Stock Market Traders."}},
            feed_posts=[{"post_url": POST_URLS[0], "author_name": "",
                         "comment_count": None,
                         "has_comment_button": False,
                         "key": "||Jj Mathosi Jj Mathosi 18 May"}],
            extract_payload=_extract_payload([_comment("Amit", "nice")]))
        job = _scrape_job()
        _run_scrape(page, job)
        row = db.get_job(job["id"])
        assert row["status"] == "done"
        assert row["new_posts"] == 1
        assert len(db.get_posts_for_source("src1")) == 1

    def test_comment_button_entry_with_null_count_opens(self):
        # Photo post: no permalink, null count, comment button —
        # kept and opened via the button (the key carries the
        # empty count).
        entry = {"post_url": None, "author_name": "Barbara",
                 "comment_count": None,
                 "key": "Barbara||Check this chart",
                 "has_comment_button": True}
        page = _FakePage(
            pages={GROUP_URL: {
                "body_text": "Stock Market Traders. group feed",
                "title": "Stock Market Traders."}},
            feed_posts=[entry],
            extract_payload=_extract_payload([_comment("Amit", "nice")]))
        job = _scrape_job()
        _run_scrape(page, job)
        row = db.get_job(job["id"])
        assert row["status"] == "done"
        assert row["new_posts"] == 1
        assert page.open_calls == ["Barbara||Check this chart"]


class TestFeedDiagnosticDetails:
    def test_diagnostic_captures_non_comment_article_details(self):
        # The 0-found diagnostic must name the non-comment articles
        # in full — aria-label, text head, hrefs, comment labels —
        # so the next 0-found run confirms whether the new post
        # identification fits the real page.
        page = _FakePage(
            pages={GROUP_URL: {
                "body_text": "Stock Market Traders. group feed",
                "title": "Stock Market Traders."}},
            feed_posts=[],
            feed_diag={
                "total": 7, "article_tags": 0, "role_articles": 7,
                "top_level": 7, "nested": 0, "non_comment_top": 2,
                "with_heading": 0, "with_permalink": 5,
                "with_bare_permalink": 2, "with_comment_button": 0,
                "with_comment_label": 2,
                "samples": [
                    {"aria_label": "",
                     "text_head": "Jj Mathosi Jj Mathosi 18 May Lost 2k "
                                  "with amd call",
                     "hrefs": ["https://www.facebook.com/groups/"
                               "572426944223825/permalink/1697550221711486/"],
                     "comment_labels": ["Comment"],
                     "has_bare_permalink": True, "has_permalink": True,
                     "has_comment_button": False},
                ]})
        job = _scrape_job()
        notes = []
        jobs.run_scrape(FacebookWorker(), page, db, job,
                        lambda: False, note=notes.append)
        row = db.get_job(job["id"])
        assert row["status"] == "done"
        assert any("2 non-comment top-level" in n for n in notes)
        assert any("2 with bare permalink" in n for n in notes)
        assert any("permalink/1697550221711486" in n for n in notes)
        assert any("comment labels: [Comment]" in n for n in notes)
        assert row["message"] and "non-comment top-level" in row["message"]


class TestSessionErrorVisibleInApp:
    def test_failed_job_error_names_session_path(self):
        # The second-press "empty" failure must be visible in the
        # app, not only in the agent console: the stored job error
        # carries the session path (state, current URL, target nav).
        page = _FakePage(blank=True, goto_raises_for={GROUP_URL})
        job = _scrape_job()
        jobs.run_scrape(FacebookWorker(), page, db, job, lambda: False)
        row = db.get_job(job["id"])
        assert row["status"] == "failed"
        assert row["error"] is not None
        assert "Facebook page did not load (state: empty)" in row["error"]
        assert "session check: state=empty" in row["error"]
        assert "target_nav=attempted, goto failed" in row["error"]


class TestCommentButtonOpen:
    def _barbara_entry(self):
        return {"post_url": None, "author_name": "Barbara",
                "comment_count": 17, "key": "Barbara|17|chart",
                "has_comment_button": True}

    def test_post_without_permalink_opens_via_comment_button(self):
        page = _FakePage(
            pages={GROUP_URL: {
                "body_text": "Stock Market Traders. group feed",
                "title": "Stock Market Traders."}},
            feed_posts=[self._barbara_entry()],
            extract_payload=_extract_payload([_comment("Amit", "nice")]))
        job = _scrape_job()
        _run_scrape(page, job)
        row = db.get_job(job["id"])
        assert row["status"] == "done"
        assert row["new_posts"] == 1
        assert page.open_calls == ["Barbara|17|chart"]
        posts = db.get_posts_for_source("src1")
        assert len(posts) == 1
        assert posts[0]["post_url"] == \
            "https://www.facebook.com/groups/572426944223825/permalink/999/"
        assert posts[0]["author_name"] == "Poster"

    def test_unopenable_post_is_skipped_not_failed(self):
        page = _FakePage(
            pages={GROUP_URL: {
                "body_text": "Stock Market Traders. group feed",
                "title": "Stock Market Traders."}},
            feed_posts=[self._barbara_entry()],
            extract_payload=_extract_payload([_comment("Amit", "nice")]),
            open_post_result=False)
        job = _scrape_job()
        notes = []
        jobs.run_scrape(FacebookWorker(), page, db, job,
                        lambda: False, note=notes.append)
        row = db.get_job(job["id"])
        assert row["status"] == "done"
        assert row["new_posts"] == 0
        assert db.get_posts_for_source("src1") == []
        assert any("could not open post by comment button" in n
                   for n in notes)

    def test_dialog_closed_between_posts(self):
        # Two permalink posts in one run: each extraction closes
        # its dialog, so the second post starts from a clean page
        # instead of stranding on the first post's dialog.
        page = _FakePage(
            pages={GROUP_URL: {
                "body_text": "Stock Market Traders. group feed",
                "title": "Stock Market Traders."}},
            feed_posts=_feed_posts(POST_URLS[:2]),
            extract_payload=_extract_payload([_comment("Amit", "nice")]))
        job = _scrape_job()
        _run_scrape(page, job)
        row = db.get_job(job["id"])
        assert row["status"] == "done"
        assert row["posts_processed"] == 2
        assert page.close_calls == 2


class TestVerifySessionNoReload:
    def test_already_on_target_skips_reload(self):
        # Reproducible live pattern: the second Scrap press failed
        # "page did not load (state: empty)" because the check
        # reloaded a heavy feed it was already sitting on. When the
        # browser is already on the target URL, no reload happens.
        page = _FakePage(pages={GROUP_URL: {
            "body_text": "captcha warning",
            "title": "Stock Market Traders."}})
        page.goto(GROUP_URL)
        notes = []
        state = FacebookWorker().verify_session(
            page, jobs._ctx(lambda: False, notes.append), GROUP_URL)
        assert state == "blocked"
        assert page.goto_calls.count(GROUP_URL) == 1
        assert any("target_nav=skipped (already on target)" in n
                   for n in notes)

    def test_readiness_wait_rescues_mid_render_page(self):
        # A page still rendering after the previous run's scrolling
        # must not be misread as "empty": the readiness wait lets
        # the body appear before the first check.
        page = _FakePage(
            pages={GROUP_URL: {
                "body_text": "Stock Market Traders. group feed",
                "title": "Stock Market Traders."}},
            ready_after=2)
        page.goto(GROUP_URL)
        state = FacebookWorker().verify_session(
            page, jobs._ctx(lambda: False), GROUP_URL)
        assert state == "ok"
        assert page.goto_calls == [GROUP_URL]

    def test_failure_note_records_session_path(self):
        # On failure the note must name the exact step that broke:
        # current URL + state, and whether the target navigation
        # was skipped or attempted and failed.
        page = _FakePage(blank=True, goto_raises_for={GROUP_URL})
        notes = []
        state = FacebookWorker().verify_session(
            page, jobs._ctx(lambda: False, notes.append), GROUP_URL)
        assert state == "empty"
        assert any("current_url=" in n and
                   "target_nav=attempted, goto failed" in n for n in notes)


# ---------------------------------------------------------------------------
# (h) check_session_with_retry: transient "empty" retries, real states don't
# ---------------------------------------------------------------------------

class TestCheckSessionWithRetry:
    def test_transient_empty_then_ok(self):
        # (a) First read sees a torn-down page, second sees content:
        # the retry returns "ok" after exactly 2 attempts.
        page = _FakePage(ready_after=1)
        state = FacebookWorker().check_session_with_retry(
            page, jobs._ctx(lambda: False))
        assert state == "ok"
        assert page._ready_calls == 2

    def test_persistently_empty_returns_empty_after_three_attempts(self):
        # (b) A page that never renders: exactly 3 attempts, then
        # "empty" — plus one diagnostic note naming the reads.
        page = _FakePage(blank=True)
        notes = []
        state = FacebookWorker().check_session_with_retry(
            page, jobs._ctx(lambda: False, notes.append))
        assert state == "empty"
        # 3 attempts + the diagnostic's own body re-read.
        assert page._ready_calls == 4
        assert any("session check empty after 3 attempts" in n
                   for n in notes)
        assert any("body_len=0" in n and "links_count=0" in n
                   and "Your profile=0" in n and "Messenger=0" in n
                   for n in notes)

    def test_non_empty_states_return_at_once(self):
        # (c) logged_out / checkpoint / blocked are real answers:
        # no extra attempts.
        logged_out = _FakePage(logged_out=True)
        assert FacebookWorker().check_session_with_retry(
            logged_out, jobs._ctx(lambda: False)) == "logged_out"
        assert logged_out._ready_calls == 1

        checkpoint = _FakePage(pages={GROUP_URL: {
            "body_text": "Verify your identity to continue",
            "title": "Checkpoint"}})
        checkpoint.goto(GROUP_URL)
        assert FacebookWorker().check_session_with_retry(
            checkpoint, jobs._ctx(lambda: False)) == "checkpoint"
        assert checkpoint._ready_calls == 1

        blocked = _FakePage(pages={GROUP_URL: {
            "body_text": "captcha warning",
            "title": "Stock Market Traders."}})
        blocked.goto(GROUP_URL)
        assert FacebookWorker().check_session_with_retry(
            blocked, jobs._ctx(lambda: False)) == "blocked"
        assert blocked._ready_calls == 1

    def test_second_press_transient_empty_then_ok(self):
        # (d) The live second-press scenario: the browser is already
        # on the target URL, the first check reads a torn-down page,
        # the retry reads the live session — no navigation at all.
        page = _FakePage(
            pages={GROUP_URL: {
                "body_text": "Stock Market Traders. group feed",
                "title": "Stock Market Traders."}},
            transient_empty_calls={2})
        page.goto(GROUP_URL)
        state = FacebookWorker().verify_session(
            page, jobs._ctx(lambda: False), GROUP_URL)
        assert state == "ok"
        assert page.goto_calls == [GROUP_URL]
        # Call 1 was the readiness wait; calls 2-3 were the two
        # check attempts.
        assert page._ready_calls == 3

    def test_transient_past_first_check_recovers_at_target_recheck(self):
        # The teardown outlasts the first check point's retries,
        # but the already-on-target re-check (which retries too)
        # sees the recovered page — still no navigation.
        page = _FakePage(
            pages={GROUP_URL: {
                "body_text": "Stock Market Traders. group feed",
                "title": "Stock Market Traders."}},
            transient_empty_calls={2, 3, 4})
        page.goto(GROUP_URL)
        notes = []
        state = FacebookWorker().verify_session(
            page, jobs._ctx(lambda: False, notes.append), GROUP_URL)
        assert state == "ok"
        assert page.goto_calls == [GROUP_URL]
        assert any("session check empty after 3 attempts" in n
                   for n in notes)


# ---------------------------------------------------------------------------
# (i) _check_session_first must thread the note through to verify_session
# ---------------------------------------------------------------------------

class _RecordingDB:
    """Minimal db stand-in: records update_job calls."""

    def __init__(self):
        self.updates = []

    def update_job(self, job_id, **fields):
        self.updates.append((job_id, fields))


class TestCheckSessionFirstNotes:
    def test_empty_diagnostic_reaches_the_note(self):
        # Regression (live 2026-11-12): _check_session_first built
        # its ctx WITHOUT the note callable, so verify_session's
        # notes — including the "session check empty after
        # 3 attempts" diagnostic — were silently dropped and never
        # reached the agent console (the user's terminal search
        # for the line found nothing). The note must be threaded
        # through from the job runner.
        page = _FakePage(blank=True, goto_raises_for={GROUP_URL})
        notes = []
        db = _RecordingDB()
        ok = jobs._check_session_first(
            FacebookWorker(), page, db, "job-1", lambda: False,
            GROUP_URL, note=notes.append)
        assert ok is False
        assert any("session check empty after 3 attempts" in n
                   for n in notes)
        assert any("body_len=0" in n for n in notes)
        assert db.updates and db.updates[0][1]["status"] == "failed"
        assert "target_nav=attempted, goto failed" in \
            db.updates[0][1]["error"]

    def test_note_optional_when_omitted(self):
        # Omitting note must stay safe (old callers): the job still
        # fails, nothing raises.
        page = _FakePage(blank=True, goto_raises_for={GROUP_URL})
        db = _RecordingDB()
        ok = jobs._check_session_first(
            FacebookWorker(), page, db, "job-1", lambda: False, GROUP_URL)
        assert ok is False
        assert db.updates and db.updates[0][1]["status"] == "failed"


class _RaisingPage:
    """Every read throws — the dead-browser shape (live 2026-11-12:
    body_len=-1, every selector 'error'). A diagnostic must never
    raise, or it fails the check it is supposed to explain."""

    @property
    def url(self):
        raise RuntimeError("Playwright connection closed")

    def title(self):
        raise RuntimeError("Playwright connection closed")

    def inner_text(self, selector):
        raise RuntimeError("Playwright connection closed")

    def query_selector_all(self, selector):
        raise RuntimeError("Playwright connection closed")

    def locator(self, selector):
        return _RaisingLocator()


class _RaisingLocator:
    def count(self):
        raise RuntimeError("Playwright connection closed")


class TestSessionDiagnostic:
    def test_diagnostic_on_a_loaded_page(self):
        page = _FakePage(anchors_by_url={
            "https://www.facebook.com/messages": [
                _FakeAnchor("https://www.facebook.com/messages/t/1"),
                _FakeAnchor("https://www.facebook.com/messages/t/2"),
            ]})
        page.goto("https://www.facebook.com/messages")
        detail = FacebookWorker().session_diagnostic(page)
        assert detail["url"] == "https://www.facebook.com/messages"
        assert detail["title"] == "Facebook"
        assert detail["body_len"] == len("Facebook feed content")
        assert detail["links_count"] == 2
        assert set(detail["selectors"]) == {
            "Your profile", "Account", "/me/", "Messenger"}
        # This fake page has no logged-in chrome: counts are 0,
        # not errors — the reads themselves worked.
        assert all(v == 0 for v in detail["selectors"].values())

    def test_diagnostic_never_raises_on_a_dead_page(self):
        detail = FacebookWorker().session_diagnostic(_RaisingPage())
        assert detail["url"] == "?"
        assert detail["title"] == "?"
        assert detail["body_len"] == -1
        assert detail["links_count"] == -1
        assert all(v == "error" for v in detail["selectors"].values())
