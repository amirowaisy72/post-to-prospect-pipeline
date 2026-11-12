"""Browser management for the LeadHunter chat agent.

Ported from Client Hunting's ``app/auth.py`` — the app that never
had the session-empty problem. One persistent Playwright Chromium
context PER ACCOUNT, each with its own profile directory under
``agent/profiles/<account>``. The agent OWNS its profile: no other
app's profile is ever used — nothing points at any other project's
profile. The session always stays open — never log out, never close
the window/tab unless explicitly asked.

Threading (critical — the fix for the live errors "Cannot switch
to a different thread" (greenlet) on goto and "It looks like you
are using Playwright Sync API inside the asyncio loop" on session
check): Playwright's sync API is greenlet-based, so ALL Playwright
calls must run on ONE dedicated browser thread. This module owns a
single-worker ThreadPoolExecutor; callers pass a function to
``run_with_page`` and get back plain data. A raw ``Page`` object is
never returned to, or held by, any other thread. FastAPI endpoints
run on the asyncio loop / threadpool — they must NEVER call
Playwright directly; they dispatch through here (``asyncio.to_thread``
for async endpoints).

First sign-in (the old app's exact flow): ``open_for_signin``
opens a VISIBLE window at the Facebook login page and the USER
signs in himself in that window — no password is ever asked for,
stored, or changed by the agent. The window is left open
afterwards and the session stays saved in the profile, so later
runs are headless. One deliberate difference from the old app:
``open_for_signin`` closes any running headless session for the
account first, so the visible window always appears (the old app
reused a headless context as-is, which would have hidden the
sign-in window). The session lives in the profile dir, so closing
the context loses nothing.
"""

from __future__ import annotations

import re
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable

__all__ = ["BrowserManager", "BROWSER", "profile_dir", "run_with_page",
           "open_for_signin", "close", "shutdown", "ProfileInUseError",
           "PROFILE_IN_USE_MESSAGE", "DEFAULT_ACCOUNT"]

_AGENT_DIR = Path(__file__).resolve().parent
DEFAULT_ACCOUNT = "default"

PROFILE_IN_USE_MESSAGE = (
    "Chrome profile is in use — another browser is using this "
    "profile. Close it and try again."
)


class ProfileInUseError(RuntimeError):
    """The chosen Chrome profile is locked by another running browser."""


_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9_.-]+")


def _safe_account_name(account_name: str) -> str:
    """Sanitise an account name for use as a directory name."""
    name = (account_name or "").strip().replace(" ", "_")
    name = _SAFE_NAME_RE.sub("_", name).strip("._")
    return name or DEFAULT_ACCOUNT


def profile_dir(account_name: str) -> Path:
    """Return the persistent profile dir for an account.

    ``agent/profiles/<account>`` — one browser profile per
    account, owned by this agent, so each account keeps its own
    Facebook session and no other app can hold the profile.
    """
    return _AGENT_DIR / "profiles" / _safe_account_name(account_name)


def _log(message: str) -> None:
    print(f"[leadhunter] {message}", flush=True)


_DEAD_CONNECTION_MARKERS = (
    "closed",
    "connection closed",
    "browser closed",
    "target closed",
)


def _is_dead_connection_error(exc: BaseException) -> bool:
    """True when an exception means the browser connection is dead.

    Playwright reports a dead browser as "Playwright connection
    closed" (and variants: browser closed, target closed). Any such
    error means the cached page/context is a corpse: it must be
    relaunched, never reused.
    """
    msg = str(exc).lower()
    return any(marker in msg for marker in _DEAD_CONNECTION_MARKERS)


def _is_profile_in_use_error(exc: BaseException) -> bool:
    """True when a launch failure is Chromium's profile lock.

    A locked user-data-dir surfaces as "already in use" /
    "SingletonLock" / "profile ... in use" in Playwright's error text.
    """
    msg = str(exc).lower()
    return ("already in use" in msg or "singleton" in msg
            or ("profile" in msg and "in use" in msg))


class BrowserManager:
    """Owns one persistent Chromium context per account.

    Every Playwright call runs on the single dedicated browser thread
    (``self._executor``). Public methods may be called from any thread;
    they submit work to the executor and block for the result.
    """

    def __init__(self) -> None:
        self._executor = ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="leadhunter-browser"
        )
        self._lock = threading.Lock()
        # Browser-thread-only state (never touched outside the executor):
        #   account_name -> {"context", "page", "headed", "alive"}
        self._sessions: dict[str, dict[str, Any]] = {}
        self._playwright: Any = None
        self._closed = False

    # ------------------------------------------------------------------
    # Internal helpers — these run ONLY on the browser thread.
    # ------------------------------------------------------------------
    def _get_playwright(self) -> Any:
        """Start (once) and return the Playwright instance for this thread."""
        if self._playwright is None:
            from playwright.sync_api import sync_playwright

            self._playwright = sync_playwright().start()
        return self._playwright

    @staticmethod
    def _browser_is_alive(page: Any) -> bool:
        """True when the page's browser connection is still live.

        ``page.is_closed()`` alone cannot tell: it is local state, so
        a page whose Chromium process died still reports "not closed"
        — and every real call then throws "Playwright connection
        closed" (the live second-press failure: body_len=-1, every
        selector read "error"). ``browser.is_connected()`` is a local
        check of the connection itself, so it spots a dead browser
        instantly with no roundtrip. Any failure of the probe counts
        as dead — a page we cannot even probe is not worth reusing;
        relaunching from the profile dir is safe (the session lives
        there) and cheap compared with reusing a corpse.
        """
        try:
            if page.is_closed():
                return False
        except Exception:
            return False
        try:
            browser = page.context.browser
            return browser is not None and bool(browser.is_connected())
        except Exception:
            return False

    def _ensure_session(self, account_name: str, headed: bool) -> dict[str, Any]:
        """Return the live session dict for an account, creating it if needed.

        Creates a persistent Chromium context rooted at the account's
        profile dir. An already-running context is reused as-is (its
        headed/headless mode cannot change after launch). A dead
        browser connection is detected first and rebuilt — never
        silently reused.
        """
        session = self._sessions.get(account_name)
        if session is not None:
            try:
                page = session.get("page")
                if page is not None and self._browser_is_alive(page):
                    return session
            except Exception:
                pass  # fall through and rebuild the session below
            _log("Browser page is dead — relaunching")
            self._close_session_locked(account_name)

        playwright = self._get_playwright()
        pdir = profile_dir(account_name)
        pdir.mkdir(parents=True, exist_ok=True)
        _log(f"Browser: {'headed (visible window)' if headed else 'headless'}")
        _log(f"Chrome profile: {pdir} "
             f"(exists: {'yes' if pdir.exists() else 'no'})")
        try:
            context = playwright.chromium.launch_persistent_context(
                user_data_dir=str(pdir),
                headless=not headed,
                viewport={"width": 1280, "height": 800},
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--no-first-run",
                    "--no-default-browser-check",
                ],
            )
        except Exception as exc:
            if _is_profile_in_use_error(exc):
                raise ProfileInUseError(PROFILE_IN_USE_MESSAGE) from exc
            raise
        page = context.pages[0] if context.pages else context.new_page()
        session = {"context": context, "page": page, "headed": headed,
                   "alive": True}
        self._sessions[account_name] = session
        return session

    def _get_page(self, account_name: str, headed: bool) -> Any:
        """Return a live Page for the account, creating one if needed."""
        session = self._ensure_session(account_name, headed)
        page = session.get("page")
        if page is None or not self._browser_is_alive(page):
            page = session["context"].new_page()
            session["page"] = page
            session["alive"] = True
        return page

    def _fresh_tab(self, account_name: str) -> Any:
        """Swap the session to a brand-new tab; return the new page.

        A tab that just scrolled a huge Facebook feed is often hung
        or half-dead; reusing it made the 2nd job fail with "page did
        not load (state: empty)". Every job therefore starts on a
        clean tab (the same state as the very first job after start).
        The session/cookies live in the profile, so nothing is lost.

        If opening the new tab fails because the browser connection
        died ("Playwright connection closed"), the browser is
        relaunched from the same profile and the fresh tab comes from
        the new browser — the dead page is NEVER silently returned.
        Any other new-tab failure still falls back to the existing
        page. A relaunch failure surfaces (ProfileInUseError / launch
        error) instead of a silent dead page.
        """
        session = self._sessions.get(account_name)
        if session is None:
            return self._get_page(account_name, False)
        page = session.get("page")
        context = session.get("context")
        if context is None:
            return self._get_page(account_name, False)
        try:
            new_page = context.new_page()
        except Exception as exc:
            if not _is_dead_connection_error(exc):
                return page
            # The browser connection died after the job's page was
            # made: drop everything and relaunch from the same profile,
            # then take the fresh tab from the new browser.
            _log("Browser connection died while opening a new tab — "
                 "relaunching")
            self._close_session_locked(account_name)
            return self._get_page(account_name, False)
        try:
            if page is not None:
                page.close()
        except Exception:
            pass
        session["page"] = new_page
        session["alive"] = True
        return new_page

    def _close_session_locked(self, account_name: str) -> None:
        """Close one account's context. Browser thread only."""
        session = self._sessions.pop(account_name, None)
        if session is None:
            return
        for key in ("page", "context"):
            try:
                obj = session.get(key)
                if obj is not None:
                    obj.close()
            except Exception:
                pass

    # ------------------------------------------------------------------
    # Public API — callable from any thread.
    # ------------------------------------------------------------------
    def run_with_page(self, account_name: str, headed: bool,
                      fn: Callable[[Any], Any], fresh: bool = False) -> Any:
        """Run ``fn(page)`` on the browser thread and return fn's result.

        ``fn`` receives the account's live, persistent Page. It must return
        plain data (dicts/lists/str/bool) — never the Page itself, and never
        hold on to the Page after returning, because the Page belongs to
        the browser thread. ``fresh`` opens a clean tab first (one job
        per tab, like the old per-job fresh page).
        """
        if self._closed:
            raise RuntimeError("BrowserManager is shut down")

        def _run() -> Any:
            if fresh:
                # Ensure the session exists, then swap to a clean tab.
                self._get_page(account_name, headed)
                page = self._fresh_tab(account_name)
            else:
                page = self._get_page(account_name, headed)
            return fn(page)

        future = self._executor.submit(_run)
        return future.result()

    def open_for_signin(self, account_name: str, login_url: str) -> None:
        """Open a VISIBLE window for the account and go to the login URL.

        The user signs in himself in this window. The window (and the
        session) is left open afterwards — never closed here. Any
        running headless session for the account is closed first, so
        the visible window always appears (a reused headless context
        cannot turn visible); the session lives in the profile dir,
        so closing the context loses nothing.
        """
        if self._closed:
            raise RuntimeError("BrowserManager is shut down")
        self.close(account_name)

        def _open(page: Any) -> None:
            page.goto(login_url, wait_until="domcontentloaded")
            try:
                page.wait_for_timeout(1500)
            except Exception:
                pass

        self.run_with_page(account_name, headed=True, fn=_open)

    def browser_state(self, account_name: str) -> str:
        """"alive" | "dead" | "not-started" for the account's browser.

        Cached only — this never launches a browser and never blocks
        behind browser work. "alive" means the last browser-thread
        check found the connection live; a page that died since then
        is caught (and relaunched) by the next run_with_page call.
        """
        session = self._sessions.get(account_name)
        if session is None:
            return "not-started"
        return "alive" if session.get("alive") else "dead"

    def headed(self, account_name: str) -> bool:
        """True when the account's running browser is a visible window."""
        session = self._sessions.get(account_name)
        return bool(session.get("headed")) if session else False

    def relaunch(self, account_name: str) -> bool:
        """Close the account's browser and launch it fresh (headless).

        Returns True when the new browser connection is alive. This
        restarts the BROWSER only — the agent process keeps running.
        A launch failure (e.g. profile in use) raises instead of
        returning a dead browser.
        """
        if self._closed:
            raise RuntimeError("BrowserManager is shut down")

        def _relaunch() -> bool:
            self._close_session_locked(account_name)
            page = self._get_page(account_name, False)
            return self._browser_is_alive(page)

        future = self._executor.submit(_relaunch)
        return bool(future.result())

    def close(self, account_name: str) -> None:
        """Close one account's browser context (its window + session)."""
        if self._closed:
            return

        def _close() -> None:
            self._close_session_locked(account_name)

        future = self._executor.submit(_close)
        future.result()

    def shutdown(self) -> None:
        """Close every account context, stop Playwright, stop the thread."""
        if self._closed:
            return
        self._closed = True

        def _shutdown() -> None:
            for name in list(self._sessions.keys()):
                self._close_session_locked(name)
            if self._playwright is not None:
                try:
                    self._playwright.stop()
                except Exception:
                    pass
                self._playwright = None

        try:
            future = self._executor.submit(_shutdown)
            future.result(timeout=30)
        except Exception:
            pass
        self._executor.shutdown(wait=True)


# ----------------------------------------------------------------------
# Module-level convenience API (the contract names, like the old app).
# ----------------------------------------------------------------------
BROWSER = BrowserManager()


def run_with_page(account_name: str, headed: bool,
                  fn: Callable[[Any], Any], fresh: bool = False) -> Any:
    """Run ``fn(page)`` on the browser thread; see BrowserManager."""
    return BROWSER.run_with_page(account_name, headed, fn, fresh=fresh)


def open_for_signin(account_name: str, login_url: str) -> None:
    """Open a visible sign-in window for the account (user signs in)."""
    BROWSER.open_for_signin(account_name, login_url)


def close(account_name: str) -> None:
    """Close one account's browser context."""
    BROWSER.close(account_name)


def shutdown() -> None:
    """Shut the whole browser manager down (called on app shutdown)."""
    BROWSER.shutdown()
