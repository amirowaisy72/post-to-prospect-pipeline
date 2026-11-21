"""Open the RIGHT Messenger chat for one candidate - and prove it.

1) Click the profile's own "Message" button (it always opens the right
   person's chat) and read the thread URL - including encrypted chats,
   which live at /messages/e2ee/t/<id>.
2) Fallback: the profile's numeric ids (never the viewer's own id).
3) Every chat is VERIFIED before use: the chat header must show the
   candidate's name, or the page must link to the candidate's profile.
   When the agent cannot be sure it asks the user (help card with a
   screenshot) instead of guessing.
"""

from __future__ import annotations

import re
import time
from urllib.parse import urlparse

import help_requests
from facebook import _note, _pace, _same_url, _should_stop

BASE = "https://www.facebook.com"
_THREAD_RE = re.compile(r"/messages/(e2ee/)?t/(\d+)")
_MESSAGE_BUTTONS = (
    'a[aria-label="Message"]',
    'div[role="button"][aria-label="Message"]',
    'button:has-text("Message")',
    'div[role="button"]:has-text("Message")',
)
_ID_PATTERNS = (
    r"fb://profile/(\d+)",
    r'"entity_id":"(\d+)"',
    r'"profile_id":"(\d+)"',
    r'"userID":"(\d+)"',
)

# JS: every /messages/ link on the page (the opened chat's thread link).
_THREAD_LINKS_JS = r"""() => Array.from(document.querySelectorAll('a[href*="/messages/"]'))
  .map(a => a.getAttribute('href') || '').slice(0, 40)"""

# JS: who is the open chat with?
_WHO_JS = r"""(arg) => {
 const uids = (arg && arg.uids) || [];
 const user = ((arg && arg.user) || '').toLowerCase();
 let profileLink = false;
 for (const a of document.querySelectorAll('a[href]')) {
   const h = (a.getAttribute('href') || '').toLowerCase();
   if (h.indexOf('/messages/') !== -1) continue;
   for (const uid of uids) {
     if (h.indexOf('id=' + uid) !== -1) { profileLink = true; break; }
   }
   if (profileLink) break;
   if (user && (h.endsWith('/' + user) || h.endsWith('/' + user + '/') || h.indexOf('/' + user + '?') !== -1)) { profileLink = true; break; }
 }
 const sel = document.querySelector('a[aria-current="page"][href*="/messages/"]');
 let head = '';
 for (const el of document.querySelectorAll('span, h1, h2, h3, [dir="auto"]')) {
   const r = el.getBoundingClientRect();
   if (r.width && r.top > 40 && r.top < 150 && r.left > 370 && r.left < 900) {
     const t = (el.innerText || '').trim();
     if (t && t.length < 80) head += ' ' + t;
   }
 }
 head = head.replace(/\s+/g, ' ').slice(0, 200);
 return {
   profileLink: profileLink,
   selectedText: sel ? (sel.innerText || '').replace(/\s+/g, ' ').slice(0, 120) : '',
   selectedHref: sel ? (sel.getAttribute('href') || '') : '',
   mainHead: head,
 };
}"""


def _pause(page, seconds):
    try:
        page.wait_for_timeout(int(seconds * 1000))
    except Exception:
        time.sleep(seconds)


def _canon(url):
    """Canonical thread URL (keeps the e2ee form), or None."""
    m = _THREAD_RE.search(url or "")
    if not m:
        return None
    return f"{BASE}/messages/{'e2ee/' if m.group(1) else ''}t/{m.group(2)}"


def _username(profile_url):
    try:
        path = urlparse(profile_url or "").path.strip("/")
    except Exception:
        return ""
    first = path.split("/")[0] if path else ""
    return "" if first.lower() == "profile.php" else first


def _viewer_id(page):
    """The logged-in user's own id (c_user cookie) - never message that."""
    try:
        for c in page.context.cookies(BASE):
            if c.get("name") == "c_user":
                return str(c.get("value") or "")
    except Exception:
        pass
    return ""


def _is_self(thread_url, viewer):
    m = _THREAD_RE.search(thread_url or "")
    return bool(m and viewer and m.group(2) == viewer)


def _candidate_ids(page, profile_url, viewer):
    """Possible numeric ids of the profile we are on (viewer excluded)."""
    ids = []
    m = re.search(r"[?&]id=(\d+)", profile_url or "")
    if m:
        ids.append(m.group(1))
    try:
        html = page.content() or ""
    except Exception:
        html = ""
    for pattern in _ID_PATTERNS:
        for found in re.findall(pattern, html)[:5]:
            if found != "0" and found not in ids:
                ids.append(found)
    return [i for i in ids if i != viewer][:4]


def _find_thread(page, ctx, seconds=8):
    """After clicking Message: the chat's thread URL (page URL or link)."""
    for _ in range(int(seconds * 2)):
        if _should_stop(ctx):
            return None
        try:
            found = _canon(page.url or "")
        except Exception:
            found = None
        if found:
            return found
        try:
            for href in page.evaluate(_THREAD_LINKS_JS) or []:
                found = _canon(href)
                if found:
                    return found
        except Exception:
            pass
        _pause(page, 0.5)
    return None


def _wait_box(worker, page, ctx):
    """'ok' | 'pin' | 'nobox' | 'stopped'."""
    for _ in range(30):
        if _should_stop(ctx):
            return "stopped"
        try:
            if "secured" in (page.inner_text("body") or "").lower():
                cont = page.locator(
                    'div[role="button"]:has-text("Continue"), button:has-text("Continue")'
                ).last
                if cont.count() > 0 and cont.is_visible():
                    cont.click(timeout=3000)
                    _pause(page, 2.0)
        except Exception:
            pass
        try:
            if "this content isn't available" in (
                page.inner_text("body") or ""
            ).lower().replace("\u2019", "'"):
                return "gone"
        except Exception:
            pass
        if worker.messenger_gate(page, ctx) != "clear":
            return "pin"
        try:
            if page.locator('div[contenteditable="true"]').count() > 0:
                return "ok"
        except Exception:
            pass
        _pause(page, 0.5)
    return "nobox"


def _open_via_search(worker, page, name, ctx):
    """Last resort: find the person with Messenger's own search box."""
    if not name:
        return None
    try:
        if not worker._goto(page, f"{BASE}/messages/", ctx, "open_chat_search"):
            return None
        _pause(page, 2.5)
        box = page.locator(
            'input[placeholder*="Search Messenger"], input[aria-label*="Search Messenger"]'
        ).first
        if box.count() == 0:
            return None
        box.click()
        box.fill(name)
        _pause(page, 3.0)
        try:
            page.get_by_text(name, exact=True).first.click(timeout=4000)
            for _ in range(20):
                try:
                    if "new message to" in (page.inner_text("body") or "").lower():
                        return "compose:" + name
                except Exception:
                    pass
                found = _canon(page.url or "")
                if found:
                    return found
                _pause(page, 0.5)
        except Exception:
            pass
        for sel in ('a[role="link"]', 'div[role="option"]', 'div[role="button"]'):
            hit = page.locator(sel, has_text=name).first
            if hit.count() > 0 and hit.is_visible():
                hit.click(timeout=4000)
                for _ in range(12):
                    found = _canon(page.url or "")
                    if found:
                        return found
                    _pause(page, 0.5)
                return None
    except Exception as exc:  # noqa: BLE001
        _note(ctx, f"open chat search failed: {exc}")
    return None


_MARK_JS = r"""(toks) => {
 for (const c of document.querySelectorAll('div[contenteditable="true"]')) c.removeAttribute('data-lh-target');
 let hit = null, n = 0;
 for (const c of document.querySelectorAll('div[contenteditable="true"]')) {
   const r0 = c.getBoundingClientRect();
   if (!r0.width || !r0.height) continue;
   let el = c, box = null;
   for (let i = 0; i < 14 && el; i++) {
     el = el.parentElement;
     if (!el) break;
     const r = el.getBoundingClientRect();
     if (r.width >= 260 && r.width <= 520 && r.height >= 280) { box = el; break; }
   }
   if (!box) continue;
   const head = (box.innerText || '').replace(/\s+/g, ' ').slice(0, 80).toLowerCase();
   if (toks.every(t => head.indexOf(t) !== -1)) { hit = c; n++; }
 }
 if (n === 1) { hit.setAttribute('data-lh-target', '1'); return true; }
 return false;
}"""


def mark_popup(page, name):
    """True only when exactly ONE chat popup shows this person's full name in its header."""
    toks = [t for t in re.split(r"\s+", (name or "").lower()) if len(t) > 1]
    if not toks:
        return False
    try:
        return bool(page.evaluate(_MARK_JS, toks))
    except Exception:
        return False


def _close_popups(page):
    """Close chat popups left open from earlier chats."""
    try:
        for _ in range(6):
            btn = page.locator('[aria-label="Close chat"]').first
            if btn.count() == 0 or not btn.is_visible():
                break
            btn.click(timeout=2000)
            _pause(page, 0.6)
    except Exception:
        pass


def _who(page, uids, user):
    try:
        got = page.evaluate(_WHO_JS, {"uids": uids, "user": user})
    except Exception:
        got = None
    return got if isinstance(got, dict) else {}


def open_chat(worker, page, profile_url, ctx):
    """Return (thread_url, detail). thread_url is None on failure.
    Never raises."""
    if _should_stop(ctx):
        return None, "stopped"
    try:
        _pace(ctx)
        if not worker._goto(page, profile_url, ctx, "open_chat"):
            return None, "profile page did not load"
        _pause(page, 2.5)
        if worker._check_block(page, ctx):
            return None, "blocked"

        name = ((ctx or {}).get("profile_name") or "").strip()
        first = name.split()[0].lower() if name else ""
        viewer = _viewer_id(page)
        user = _username(profile_url)
        candidates = _candidate_ids(page, profile_url, viewer)  # while on the profile

        attempts = []  # (how, thread_url)
        _close_popups(page)
        if worker._click_first_visible(page, _MESSAGE_BUTTONS):
            _pause(page, 2.5)
            try:
                if (
                    page.locator('div[contenteditable="true"]').count() > 0
                    and first
                    and first in (page.inner_text("body") or "").lower()
                ):
                    if mark_popup(page, name):
                        attempts.append(("profile popup", "compose:" + name))
            except Exception:
                pass
            via_button = _find_thread(page, ctx)
            if via_button and not _is_self(via_button, viewer):
                attempts.append(("Message button", via_button))
        for uid in candidates:
            attempts.append(("profile id", f"{BASE}/messages/t/{uid}"))
        attempts.append(("messenger search", None))

        fallback_url = None
        seen = ""
        for how, url in attempts:
            if url is None:
                url = _open_via_search(worker, page, name, ctx)
                if not url:
                    continue
            if _should_stop(ctx):
                return None, "stopped"
            try:
                same = _same_url(page.url or "", url)
            except Exception:
                same = False
            if (
                not same
                and not url.startswith("compose:")
                and not worker._goto(page, url, ctx, "open_chat_thread")
            ):
                continue
            state = _wait_box(worker, page, ctx)
            if state == "stopped":
                return None, "stopped"
            if state == "pin":
                return None, "needs your help: Messenger PIN (see the card above)"
            if state != "ok":
                continue
            _pause(page, 1.0)
            who = _who(page, candidates, user)
            blob = " ".join(
                [who.get("selectedText") or "", who.get("mainHead") or ""]
            ).lower()
            seen = blob
            final = _canon(page.url or "") or _canon(who.get("selectedHref")) or url
            try:
                body_low = (page.inner_text("body") or "").lower()
            except Exception:
                body_low = ""
            hits = body_low.count(first) if first else 0
            seen = blob + f" [name x{hits}]"
            if bool(who.get("profileLink")) or bool(
                first and (first in blob or hits >= 3)
            ):
                _note(ctx, f"open chat verified via {how}: {final}")
                return final, f"opened (verified via {how})"
            fallback_url = final
            _note(
                ctx,
                f"open chat via {how}: cannot confirm it is '{name}' | seen: {blob[:120]}",
            )

        if fallback_url and help_requests.is_confirmed(profile_url):
            return fallback_url, "opened (confirmed by you)"
        worker.report_stuck(
            page,
            ctx,
            f"the agent could not confirm the open chat is with '{name}'. If the "
            "screenshot below shows the right person's chat, just "
            "press 'I fixed it — Continue'",
        )
        return None, (
            f"cannot confirm the open chat is with '{name}' | "
            f"tried {len(attempts)} | seen: {seen[:150]}"
        )
    except Exception as exc:  # noqa: BLE001
        _note(ctx, f"open chat failed ({profile_url}): {exc}")
        return None, str(exc)
