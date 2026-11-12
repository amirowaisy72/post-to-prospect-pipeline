"""Tests for the LeadHunter browser layer (agent/browser.py).

The rebuild's core promise, proved here with a stubbed Playwright
(this VM cannot reach Facebook, and no test launches a real
browser):

- ALL Playwright calls run on ONE dedicated browser thread, no
  matter which thread (or asyncio loop) asks for the work — the
  fix for the live "Cannot switch to a different thread" (greenlet)
  and "Sync API inside the asyncio loop" errors.
- The agent owns its own Chrome profile per account under
  agent/profiles/<account> — no env var, no other app's profile.
- First sign-in opens a VISIBLE window at the Facebook login page
  for the user to sign in himself; later runs are headless.
- A dead browser connection is relaunched from the profile, never
  silently reused; a locked profile fails with a plain message.

Self-contained: the fake Playwright is built here (test files never
import fakes from each other).
"""

import sys
import threading
import types
from pathlib import Path
from unittest import mock

import pytest

AGENT_DIR = Path(__file__).resolve().parent.parent
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

import browser  # noqa: E402
from browser import (  # noqa: E402
    DEFAULT_ACCOUNT,
    PROFILE_IN_USE_MESSAGE,
    BrowserManager,
    ProfileInUseError,
    profile_dir,
)

LOGIN_URL = "https://www.facebook.com/login"


def _install_fake_playwright(monkeypatch, tmp_path, launch_side_effect=None):
    """Install a fake ``playwright.sync_api`` + a tmp profile dir.

    Returns (chromium, handle, page, context). The fake page reports
    a live connection until the test flips
    ``page.context.browser.is_connected``. The profile dir is
    redirected under tmp_path so no test ever creates
    agent/profiles/ on disk.
    """
    page = mock.MagicMock(name="page")
    page.is_closed.return_value = False
    page.context.browser.is_connected.return_value = True
    context = mock.MagicMock(name="context")
    context.pages = [page]
    chromium = mock.MagicMock(name="chromium")
    if launch_side_effect is not None:
        chromium.launch_persistent_context.side_effect = launch_side_effect
    else:
        chromium.launch_persistent_context.return_value = context
    handle = mock.MagicMock(name="playwright-handle")
    handle.chromium = chromium
    starter = mock.MagicMock(name="sync-playwright")
    starter.start.return_value = handle
    sync_api = types.ModuleType("playwright.sync_api")
    sync_api.sync_playwright = mock.MagicMock(return_value=starter)
    playwright_mod = types.ModuleType("playwright")
    playwright_mod.sync_api = sync_api
    monkeypatch.setitem(sys.modules, "playwright", playwright_mod)
    monkeypatch.setitem(sys.modules, "playwright.sync_api", sync_api)
    monkeypatch.setattr(
        browser, "profile_dir",
        lambda name: tmp_path / "profiles" / browser._safe_account_name(name))
    return chromium, handle, page, context


@pytest.fixture()
def manager(monkeypatch, tmp_path):
    """A fresh BrowserManager with stubbed Playwright; shut down after."""
    _install_fake_playwright(monkeypatch, tmp_path)
    mgr = BrowserManager()
    yield mgr
    try:
        mgr.shutdown()
    except Exception:
        pass


# ----------------------------------------------------------------------
# Single-thread dispatch — the live bug, proved gone
# ----------------------------------------------------------------------
def test_dispatch_from_three_threads_runs_on_one_browser_thread(manager):
    """run_with_page called from 3 different threads: the fn always
    runs on the SAME (browser) thread, never on any caller thread."""
    seen = []  # (caller ident, fn ident)
    errors = []

    def _call_from_thread():
        caller = threading.get_ident()
        try:
            manager.run_with_page(
                "acc-1", False,
                lambda page: seen.append((caller, threading.get_ident())))
        except Exception as exc:  # noqa: BLE001 - record, don't hide
            errors.append(exc)

    threads = [threading.Thread(target=_call_from_thread) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)
    assert not errors
    assert len(seen) == 3
    fn_idents = {fn_ident for _caller, fn_ident in seen}
    assert len(fn_idents) == 1, "all browser work ran on one thread"
    browser_thread = fn_idents.pop()
    assert browser_thread != threading.get_ident()
    assert all(caller != browser_thread for caller, _ in seen)


def test_dispatch_from_inside_asyncio_via_to_thread(manager, monkeypatch,
                                                    tmp_path):
    """The exact live failure shape: sync Playwright work requested
    from INSIDE the asyncio loop. Dispatched via asyncio.to_thread
    it succeeds — and still lands on the browser thread, never the
    loop thread."""
    import asyncio

    seen = []

    def _fn(page):
        seen.append(threading.get_ident())
        return "ok"

    async def _from_loop():
        return await asyncio.to_thread(
            manager.run_with_page, "acc-1", False, _fn)

    assert asyncio.run(_from_loop()) == "ok"
    assert len(seen) == 1
    browser_thread = seen[0]
    assert browser_thread != threading.get_ident()

    # A direct call from another thread lands on the same thread.
    seen2 = []
    thread = threading.Thread(
        target=lambda: manager.run_with_page(
            "acc-1", False, lambda p: seen2.append(threading.get_ident())))
    thread.start()
    thread.join(timeout=10)
    assert seen2 == [browser_thread]


# ----------------------------------------------------------------------
# Own profile
# ----------------------------------------------------------------------
def test_profile_dir_under_agent_profiles_and_sanitised():
    base = Path(browser.__file__).resolve().parent / "profiles"
    assert profile_dir("acc-1") == base / "acc-1"
    assert profile_dir("Master") == base / "Master"
    # Slashes/spaces can never escape the profiles dir.
    assert profile_dir("a/b\\c d") == base / "a_b_c_d"
    assert profile_dir("../escape") == base / "escape"
    assert profile_dir("") == base / DEFAULT_ACCOUNT
    assert profile_dir("   ") == base / DEFAULT_ACCOUNT


def test_launch_uses_own_profile_headless_by_default(manager, monkeypatch,
                                                     tmp_path):
    chromium, _handle, _page, _ctx = _install_fake_playwright(
        monkeypatch, tmp_path)
    manager.run_with_page("acc-1", False, lambda page: "done")
    assert chromium.launch_persistent_context.call_count == 1
    kwargs = chromium.launch_persistent_context.call_args.kwargs
    assert kwargs["user_data_dir"] == str(tmp_path / "profiles" / "acc-1")
    assert kwargs["headless"] is True
    assert kwargs["viewport"] == {"width": 1280, "height": 800}
    assert "--disable-blink-features=AutomationControlled" in kwargs["args"]
    assert "--no-first-run" in kwargs["args"]
    assert "--no-default-browser-check" in kwargs["args"]


def test_reuses_live_page_and_session(manager, monkeypatch, tmp_path):
    chromium, _handle, page, _ctx = _install_fake_playwright(
        monkeypatch, tmp_path)
    got = []
    manager.run_with_page("acc-1", False, lambda p: got.append(p))
    manager.run_with_page("acc-1", False, lambda p: got.append(p))
    assert got == [page, page]
    assert chromium.launch_persistent_context.call_count == 1
    assert manager.browser_state("acc-1") == "alive"
    assert manager.headed("acc-1") is False
    assert manager.browser_state("no-such-account") == "not-started"


def test_fresh_tab_opens_new_tab_and_closes_old(manager, monkeypatch,
                                                tmp_path):
    chromium, _handle, page, context = _install_fake_playwright(
        monkeypatch, tmp_path)
    fresh_page = mock.MagicMock(name="fresh-page")
    fresh_page.is_closed.return_value = False
    fresh_page.context.browser.is_connected.return_value = True
    context.new_page.return_value = fresh_page
    got = []
    manager.run_with_page("acc-1", False, lambda p: got.append(p), fresh=True)
    assert got == [fresh_page]
    assert context.new_page.call_count == 1
    page.close.assert_called_once()


def test_dead_connection_relaunches_from_same_profile(manager, monkeypatch,
                                                     tmp_path):
    page1 = mock.MagicMock(name="page1")
    page1.is_closed.return_value = False
    page1.context.browser.is_connected.return_value = True
    context1 = mock.MagicMock(name="context1")
    context1.pages = [page1]
    page2 = mock.MagicMock(name="page2")
    page2.is_closed.return_value = False
    page2.context.browser.is_connected.return_value = True
    context2 = mock.MagicMock(name="context2")
    context2.pages = [page2]
    chromium, _handle, _p, _c = _install_fake_playwright(
        monkeypatch, tmp_path,
        launch_side_effect=[context1, context2])
    got = []
    manager.run_with_page("acc-1", False, lambda p: got.append(p))
    assert got == [page1]
    # The Chromium process died after the 1st job, although the page
    # itself was never closed — the next call must relaunch.
    page1.context.browser.is_connected.return_value = False
    manager.run_with_page("acc-1", False, lambda p: got.append(p))
    assert got == [page1, page2]
    assert chromium.launch_persistent_context.call_count == 2
    context1.close.assert_called_once()


def test_profile_in_use_raises_plain_message(manager, monkeypatch, tmp_path):
    _install_fake_playwright(
        monkeypatch, tmp_path,
        launch_side_effect=Exception(
            "browserType.launchPersistentContext: Failed to launch: "
            "user data directory is already in use"))
    with pytest.raises(ProfileInUseError) as excinfo:
        manager.run_with_page("acc-1", False, lambda page: None)
    assert str(excinfo.value) == PROFILE_IN_USE_MESSAGE
    assert "acc-1" not in manager._sessions


def test_shutdown_closes_everything(manager, monkeypatch, tmp_path):
    chromium, handle, _page, context = _install_fake_playwright(
        monkeypatch, tmp_path)
    manager.run_with_page("acc-1", False, lambda p: None)
    manager.shutdown()
    context.close.assert_called_once()
    handle.stop.assert_called_once()
    assert manager.browser_state("acc-1") == "not-started"
    with pytest.raises(RuntimeError, match="shut down"):
        manager.run_with_page("acc-1", False, lambda p: None)


def test_relaunch_returns_alive(manager, monkeypatch, tmp_path):
    chromium, _handle, _page, context1 = _install_fake_playwright(
        monkeypatch, tmp_path)
    manager.run_with_page("acc-1", False, lambda p: None)
    assert manager.relaunch("acc-1") is True
    assert chromium.launch_persistent_context.call_count == 2
    context1.close.assert_called_once()
    assert manager.browser_state("acc-1") == "alive"


# ----------------------------------------------------------------------
# First sign-in — visible window, user signs in himself
# ----------------------------------------------------------------------
def test_open_for_signin_headed_and_login_url(manager, monkeypatch, tmp_path):
    chromium, _handle, page, _ctx = _install_fake_playwright(
        monkeypatch, tmp_path)
    manager.open_for_signin("acc-1", LOGIN_URL)
    kwargs = chromium.launch_persistent_context.call_args.kwargs
    assert kwargs["headless"] is False  # visible window
    assert kwargs["user_data_dir"] == str(tmp_path / "profiles" / "acc-1")
    page.goto.assert_called_once_with(
        LOGIN_URL, wait_until="domcontentloaded")
    assert manager.headed("acc-1") is True
    assert manager.browser_state("acc-1") == "alive"


def test_open_for_signin_closes_headless_session_first(manager, monkeypatch,
                                                       tmp_path):
    chromium, _handle, page, context = _install_fake_playwright(
        monkeypatch, tmp_path)
    manager.run_with_page("acc-1", False, lambda p: None)
    assert manager.headed("acc-1") is False
    manager.open_for_signin("acc-1", LOGIN_URL)
    # The headless context was closed so the visible window appears.
    context.close.assert_called_once()
    assert chromium.launch_persistent_context.call_count == 2
    assert manager.headed("acc-1") is True


# ----------------------------------------------------------------------
# No other app's profile anywhere in agent code
# ----------------------------------------------------------------------
def test_no_client_hunting_profile_reference():
    """The old env-var dependency is gone: no agent file, no .bat
    and no README may point at another app's Chrome profile. (Port
    credits naming Client Hunting are fine — only the profile path
    and the env var names are forbidden.)"""
    forbidden = [
        "LEADHUNTER_CHROME_PROFILE",
        "LEADHUNTER_HEADED",
        "client-hunting\\data\\profiles",
        "client-hunting/data/profiles",
        "G:\\Web Apps\\client-hunting",
    ]
    files = list(AGENT_DIR.glob("*.py"))
    files += [AGENT_DIR / "run-agent.bat", AGENT_DIR / "README.md",
              AGENT_DIR.parent / "start.bat"]
    assert files, "no agent files found to scan"
    for path in files:
        text = path.read_text(errors="ignore")
        for frag in forbidden:
            assert frag not in text, f"{path} still mentions {frag!r}"
