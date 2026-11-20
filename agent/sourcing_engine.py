"""Data Sourcing engine: find groups/pages, judge them, scrape posts,
sync posts. Self-contained: it uses only a Playwright ``page`` and the
db module, never the older scraper code.

Every function is defensive: a failure becomes a job message, never a
crash. When a page does not look as expected (no posts, no comments
found while Facebook says there are some) a debug snapshot (png +
html) is written to ``agent/debug/`` so the extraction can be fixed
from a real page.
"""

from __future__ import annotations

import random
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE = "https://www.facebook.com"
DEBUG_DIR = Path(__file__).resolve().parent / "debug"

_RESERVED = {
    "search",
    "groups",
    "watch",
    "marketplace",
    "gaming",
    "events",
    "friends",
    "login",
    "login.php",
    "help",
    "policies",
    "privacy",
    "pages",
    "stories",
    "reel",
    "reels",
    "photo",
    "photo.php",
    "permalink.php",
    "story.php",
    "hashtag",
    "bookmarks",
    "notifications",
    "messages",
    "settings",
    "ads",
    "business",
    "profile.php",
    "share",
    "sharer",
    "dialog",
    "plugins",
    "l.php",
}


class EngineError(Exception):
    pass


# ----------------------------------------------------------------------
# small helpers
# ----------------------------------------------------------------------
def _now():
    return datetime.now(timezone.utc)


def _iso(dt):
    return dt.isoformat()


def _pause(lo=0.8, hi=1.8):
    time.sleep(random.uniform(lo, hi))


def _num(text):
    """'12K' -> 12000, '1,234' -> 1234, '2.5M' -> 2500000. None if no number."""
    m = re.search(r"(\d[\d.,]*)\s*([KMkm])?", text or "")
    if not m:
        return None
    raw, suf = m.group(1), (m.group(2) or "").upper()
    try:
        if suf:
            return int(
                round(float(raw.replace(",", "")) * (1000 if suf == "K" else 1_000_000))
            )
        return int(re.sub(r"[.,]", "", raw))
    except ValueError:
        return None


def snapshot(page, tag, note=None):
    """Save a screenshot + html of the current page for debugging."""
    try:
        DEBUG_DIR.mkdir(exist_ok=True)
        stamp = _now().strftime("%Y%m%d-%H%M%S")
        base = DEBUG_DIR / f"{stamp}-{re.sub(r'[^a-z0-9]+', '-', tag.lower())}"
        try:
            page.screenshot(path=str(base) + ".png", full_page=False)
        except Exception:
            pass
        try:
            Path(str(base) + ".html").write_text(page.content(), encoding="utf-8")
        except Exception:
            pass
        files = sorted(DEBUG_DIR.glob("*"), key=lambda p: p.stat().st_mtime)
        for old in files[:-8]:
            try:
                old.unlink()
            except Exception:
                pass
        if note:
            note(f"debug snapshot saved: agent/debug/{base.name}")
    except Exception:
        pass


def goto(page, url, note=None):
    """Open a Facebook page; raise EngineError on login wall / checkpoint."""
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=45000)
    except Exception as exc:  # noqa: BLE001
        raise EngineError(f"page did not load: {exc}") from exc
    _pause(1.0, 1.5)
    wait_ready(page)
    cur = (page.url or "").lower()
    if "checkpoint" in cur:
        raise EngineError("Facebook checkpoint: account needs a manual check")
    if "/login" in cur or "login.php" in cur:
        raise EngineError("Facebook is logged out: sign in again (Agent Control)")
    try:
        if page.locator('input[name="pass"]').count() > 0 and "/search" not in cur:
            raise EngineError("Facebook is logged out: sign in again (Agent Control)")
    except EngineError:
        raise
    except Exception:
        pass


def wait_ready(page, timeout=25):
    """Facebook shows a logo splash first; wait until real content is there."""
    end = time.time() + timeout
    while time.time() < end:
        try:
            n = page.evaluate(
                "() => ((document.body && document.body.innerText) || '').trim().length"
            )
            links = page.evaluate("() => document.querySelectorAll('a[href]').length")
        except Exception:
            n, links = 0, 0
        if n > 200 and links > 15:
            time.sleep(0.6)
            return
        time.sleep(0.5)


def scroll(page, rounds=1, wait=1.4):
    for _ in range(rounds):
        try:
            page.evaluate("window.scrollBy(0, Math.round(window.innerHeight * 0.9))")
        except Exception:
            pass
        time.sleep(wait + random.uniform(0, 0.6))


def body_text(page, limit=20000):
    try:
        return (page.inner_text("body") or "")[:limit]
    except Exception:
        return ""


# ----------------------------------------------------------------------
# 1. discovery (search results)
# ----------------------------------------------------------------------
_CANDIDATES_JS = r"""
(kind) => {
  const RESERVED = new Set(%RESERVED%);
  const out = []; const seen = new Set();
  const climb = (el) => {
    let cur = el, best = el;
    for (let i = 0; i < 7 && cur && cur.parentElement; i++) {
      cur = cur.parentElement;
      const t = (cur.innerText || '');
      if (t.length > 700) break;
      best = cur;
      if (/(members?|followers?|likes?)\b/i.test(t)) break;
    }
    return best;
  };
  for (const a of document.querySelectorAll('a[href]')) {
    let u;
    try { u = new URL(a.href, location.origin); } catch (e) { continue; }
    if (!/facebook\.com$/.test(u.hostname.replace(/^(www|m|web)\./, ''))) continue;
    const parts = u.pathname.split('/').filter(Boolean);
    let url = null, slug = null;
    if (kind === 'group') {
      if (parts[0] !== 'groups' || !parts[1] || parts[1] === 'feed' || parts[1] === 'discover') continue;
      slug = parts[1]; url = location.origin + '/groups/' + slug + '/';
    } else {
      if (parts.length === 0) continue;
      if (parts[0] === 'profile.php' && u.searchParams.get('id')) {
        slug = u.searchParams.get('id'); url = location.origin + '/profile.php?id=' + slug;
      } else {
        if (RESERVED.has(parts[0].toLowerCase()) || parts.length > 1) continue;
        slug = parts[0]; url = location.origin + '/' + slug;
      }
    }
    if (seen.has(slug.toLowerCase())) {
      continue;
    }
    const name = (a.innerText || '').trim().split('\n')[0];
    if (!name || name.length < 2 || name.length > 120) continue;
    if (/^(profile|cover) photo|^see all|^join|^view/i.test(name)) continue;
    seen.add(slug.toLowerCase());
    const box = climb(a);
    const info = (box.innerText || '').slice(0, 700);
    out.push({url, name, info});
  }
  return out;
}
""".replace("%RESERVED%", str(sorted(_RESERVED)).replace("'", '"'))


def iter_candidates(page, keyword, kind, note=None, should_stop=lambda: False):
    """Open the search results ONCE and yield new candidates
    [{url, name, member_count, private, kind}] as they appear, scrolling
    the results deeper only when everything seen so far was used. Ends
    when Facebook has no more results (5 scrolls without anything new)
    or the user stopped."""
    from urllib.parse import quote

    path = "groups" if kind == "group" else "pages"
    goto(page, f"{BASE}/search/{path}/?q={quote(keyword)}", note)
    seen = set()
    no_growth = 0
    yielded = 0
    while not should_stop():
        try:
            items = page.evaluate(_CANDIDATES_JS, kind) or []
        except Exception:
            items = []
        fresh = []
        for it in items:
            key = it["url"].lower()
            if key in seen:
                continue
            seen.add(key)
            info = it.get("info", "")
            members = None
            m = re.search(
                r"([\d.,]+\s*[KM]?)\s*(?:total\s+)?(members?|followers?)", info, re.I
            )
            if m:
                members = _num(m.group(1))
            fresh.append(
                {
                    "url": it["url"],
                    "name": it["name"],
                    "member_count": members,
                    "private": bool(re.search(r"private group", info, re.I)),
                    "info": info,
                    "kind": kind,
                }
            )
        for cand in fresh:
            yielded += 1
            yield cand
        if fresh:
            no_growth = 0
        else:
            no_growth += 1
            if no_growth >= 5:
                break
        scroll(page, 1, 1.4)
    if yielded == 0:
        snapshot(page, f"search-{kind}-empty", note)


# ----------------------------------------------------------------------
# 2. activity judgement (several posts, not just the first)
# ----------------------------------------------------------------------
_PERMALINK_RE = (
    r"/(?:posts|permalink)/[\w-]+|permalink\.php\?|story\.php\?|/groups/[^/]+/posts/"
)

_FEED_JS = r"""
() => {
  const links = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    const h = a.getAttribute('href') || '';
    if (/%PERM%/.test(h)) links.add(h.split('?')[0]);
  }
  // One comment button per post. The count is either in its aria-label
  // ("Comment on X's post, 223 comments") or the small number shown next to
  // the comment icon. Facebook removes old posts from the page while you
  // scroll, so posts are remembered across calls (window.__lh).
  window.__lh = window.__lh || {};
  const NUM = /(\d[\d.,]*\s*[KM]?)\s+comments?\b/i;
  const PURE = /^\d[\d.,]*\s*[KM]?$/;
  const OKLAB = /^(leave a comment|comment|comments?)$|comment on .*post|\d[\d.,]*\s*[KM]?\s+comments?\b/i;
  const btns = [];
  for (const el of document.querySelectorAll('[aria-label]')) {
    const lab = (el.getAttribute('aria-label') || '').trim();
    if (!lab || lab.length > 140 || !OKLAB.test(lab)) continue;
    if (/^(comment (by|as)|reply|write|view)\b/i.test(lab)) continue;
    btns.push([el, lab]);
  }
  const samples = [];
  for (const [el, lab] of btns) {
    let n = '0';
    const m = NUM.exec(lab);
    if (m) n = m[1];
    else {
      const own = (el.innerText || '').trim();
      const par = el.parentElement ? (el.parentElement.innerText || '').trim() : '';
      if (PURE.test(own)) n = own; else if (PURE.test(par)) n = par;
    }
    // the post container = highest ancestor that holds only this button
    let c = el;
    for (let i = 0; i < 16 && c.parentElement; i++) {
      const p = c.parentElement;
      if (btns.filter(x => p.contains(x[0])).length !== 1) break;
      if ((p.innerText || '').length > 4000) break;
      c = p;
    }
    const key = (c.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 90);
    if (!key) continue;
    window.__lh[key] = n;
    if (samples.length < 4) samples.push(lab + ' | ' + n);
  }
  const counts = Object.values(window.__lh);
  // Fallback: a small element that is exactly "N comments".
  if (counts.length === 0) {
    const t2 = new Set();
    for (const el of document.querySelectorAll('span, div, a')) {
      if (el.childElementCount !== 0) continue;
      const m = /^(\d[\d.,]*\s*[KM]?)\s+comments?$/i.exec((el.innerText || '').trim());
      if (!m) continue;
      const key = Math.round((el.getBoundingClientRect().top + window.scrollY) / 25);
      if (t2.has(key)) continue;
      t2.add(key); counts.push(m[1]);
    }
  }
  const head = (document.body.innerText || '').slice(0, 6000);
  const mem = /([\d.,]+\s*[KM]?)\s+(?:total\s+)?members?\b/i.exec(head);
  let name = (document.title || '').replace(/^\(\d+\)\s*/, '').replace(/\s*\|\s*Facebook\s*$/i, '').trim();
  if (!name || /^facebook$/i.test(name)) {
    const h1 = Array.from(document.querySelectorAll('h1')).map(h => (h.innerText || '').trim()).find(t => t.length > 1 && !/^notifications$/i.test(t));
    name = h1 || '';
  }
  return {permalinks: links.size, counts: counts, samples: samples, members: mem ? mem[1] : null, name: name,
          private: /private group/i.test(head)};
}
""".replace("%PERM%", _PERMALINK_RE.replace("/", "\\/"))


def judge(counts, seen, min_comments):
    """Pure rule: is this an ACTIVE community? Returns (ok, why, active, need).

    A post is "active" when it has at least ``thr`` comments
    (thr = max(2, min_comments)). The source passes when at least 5
    posts were seen and at least max(3, 40% of them) are active, so
    one popular post or a few 1-comment posts never qualify."""
    thr = max(2, int(min_comments or 0))
    active = sum(1 for c in counts if c >= thr)
    need = max(3, -(-seen * 2 // 5))
    if seen < 5:
        return (
            False,
            f"sirf {seen} post(s) nazar aayi (kam az kam 5 chahiye)",
            active,
            need,
        )
    if active < need:
        return (
            False,
            f"{seen} posts mein se sirf {active} par {thr}+ comments (chahiye {need})",
            active,
            need,
        )
    return True, "", active, need


def check_activity(page, url, min_comments, note=None, should_stop=lambda: False):
    """Open a source and judge whether it is an active community (see
    ``judge``). Decides as soon as the evidence is clear so dead
    sources cost only a few seconds. Returns {name, posts, active,
    comments, members, private, ok, why}."""
    res = {
        "name": "",
        "posts": 0,
        "active": 0,
        "comments": 0,
        "members": None,
        "private": False,
        "ok": False,
        "why": "",
    }
    goto(page, url, note)
    thr = max(2, int(min_comments or 0))
    best = None
    for _ in range(9):
        if should_stop():
            break
        try:
            got = page.evaluate(_FEED_JS) or {}
        except Exception:
            got = {}
        counts = [_num(c) or 0 for c in got.get("counts", [])]
        seen = max(len(counts), int(got.get("permalinks") or 0))
        active = sum(1 for c in counts if c >= thr)
        best = {
            "counts": counts,
            "seen": seen,
            "members": got.get("members"),
            "samples": got.get("samples") or [],
            "name": got.get("name") or "",
            "private": bool(got.get("private")),
        }
        if seen >= 5 and judge(counts, seen, min_comments)[0]:
            break  # clearly active
        if seen >= 6 and active == 0:
            break  # clearly dead
        if seen >= 10:
            break
        scroll(page, 1, 1.2)
    if not best or best["seen"] == 0:
        snapshot(page, "activity-no-posts", note)
        res["why"] = (
            "private group (posts nazar nahi aaye)"
            if best and best["private"]
            else "page par koi post detect nahi hui (debug snapshot dekhen)"
        )
        res["private"] = bool(best and best["private"])
        return res
    counts = best["counts"]
    ok, why, active, _need = judge(counts, best["seen"], min_comments)
    res.update(
        {
            "name": best["name"],
            "posts": best["seen"],
            "active": active,
            "comments": sum(counts),
            "members": _num(best["members"] or ""),
            "ok": ok,
            "why": why,
        }
    )
    note(
        f"activity {best['name'] or url}: posts={res['posts']} comments per post={counts[:12]} -> {'ACTIVE' if ok else 'skip'}"
    )
    return res


# ----------------------------------------------------------------------
# 3. join / follow
# ----------------------------------------------------------------------
def _click_button(page, pattern):
    try:
        loc = page.get_by_role("button", name=re.compile(pattern, re.I))
        for i in range(min(loc.count(), 4)):
            b = loc.nth(i)
            if b.is_visible():
                b.click(timeout=5000)
                return True
    except Exception:
        pass
    return False


def join_group(page, url, note=None):
    """Join a group. Returns "joined", "pending" or "failed"."""
    try:
        goto(page, url, note)
        txt = body_text(page, 4000)
        if re.search(r"\bJoined\b", txt) and not re.search(
            r"\bJoin group\b", txt, re.I
        ):
            return "joined"
        if not _click_button(page, r"^join( group)?$"):
            snapshot(page, "join-no-button", note)
            return "failed"
        _pause(2.5, 4.0)
        # Questions dialog: cannot answer on the user's behalf.
        if (
            page.locator(
                'div[role="dialog"] input, div[role="dialog"] textarea'
            ).count()
            > 0
        ):
            _click_button(page, r"^(cancel|close|not now)$")
            return "failed"
        _click_button(page, r"^(submit|done|ok)$")
        _pause(1.5, 2.5)
        txt = body_text(page, 4000)
        if re.search(r"Cancel request|Pending", txt, re.I):
            return "pending"
        if re.search(r"\bJoined\b", txt) or re.search(r"Leave group", txt, re.I):
            return "joined"
        snapshot(page, "join-unclear", note)
        return "failed"
    except EngineError:
        raise
    except Exception:
        return "failed"


def follow_page(page, url, note=None):
    try:
        goto(page, url, note)
        txt = body_text(page, 4000)
        if re.search(r"\bFollowing\b", txt):
            return True
        if not _click_button(page, r"^follow$"):
            snapshot(page, "follow-no-button", note)
            return False
        _pause(2.0, 3.0)
        return bool(re.search(r"\bFollowing\b", body_text(page, 4000)))
    except EngineError:
        raise
    except Exception:
        return False


def _click_role(page, role, pattern):
    try:
        loc = page.get_by_role(role, name=re.compile(pattern, re.I))
        for i in range(min(loc.count(), 4)):
            el = loc.nth(i)
            if el.is_visible():
                el.click(timeout=5000)
                return True
    except Exception:
        pass
    return False


def leave_group(page, url, note=None):
    """Leave a group (or cancel a pending join request). True when the
    account is no longer a member afterwards."""
    try:
        goto(page, url, note)
        txt = body_text(page, 5000)
        if re.search(r"\bJoin group\b", txt, re.I) and not re.search(
            r"\bJoined\b", txt
        ):
            return True  # not a member already
        if _click_button(page, r"^cancel request$"):
            _pause(1.5, 2.5)
            _click_button(page, r"^(cancel request|confirm|yes)$")
            return True
        if not _click_button(page, r"^joined$"):
            snapshot(page, "leave-no-joined-button", note)
            return False
        _pause(1.0, 1.6)
        if not _click_role(page, "menuitem", r"^leave group$"):
            if not _click_button(page, r"^leave group$"):
                snapshot(page, "leave-no-menu-item", note)
                return False
        _pause(1.2, 2.0)
        _click_button(page, r"^leave( group)?$")  # confirm dialog
        _pause(2.0, 3.0)
        after = body_text(page, 5000)
        if re.search(r"\bJoin group\b", after, re.I):
            return True
        snapshot(page, "leave-unclear", note)
        return False
    except EngineError:
        raise
    except Exception:
        return False


def unfollow_page(page, url, note=None):
    """Unfollow a page. True when no longer following."""
    try:
        goto(page, url, note)
        txt = body_text(page, 5000)
        if re.search(r"\bFollow\b", txt) and not re.search(r"\bFollowing\b", txt):
            return True
        if not _click_button(page, r"^following$"):
            snapshot(page, "unfollow-no-button", note)
            return False
        _pause(1.0, 1.6)
        if not _click_role(page, "menuitem", r"^unfollow"):
            snapshot(page, "unfollow-no-menu-item", note)
            return False
        _pause(1.5, 2.5)
        after = body_text(page, 5000)
        return not re.search(r"\bFollowing\b", after)
    except EngineError:
        raise
    except Exception:
        return False


def delete_source(page, db, source_id, force=False, note=None):
    """Delete a source everywhere. If the account joined/followed it,
    leave/unfollow on Facebook FIRST; only when that worked (or
    ``force``) the records (source, posts, comments, replies, memory)
    are removed. Returns {ok, left, detail}."""
    src = db.get_source_by_id(source_id)
    if src is None:
        return {"ok": False, "left": False, "detail": "source nahi mila"}
    left = False
    if (src.get("status") or "") == "joined" and src.get("url"):
        try:
            if src.get("type") == "group":
                left = leave_group(page, src["url"], note)
            else:
                left = unfollow_page(page, src["url"], note)
        except EngineError as exc:
            if not force:
                return {"ok": False, "left": False, "detail": str(exc)}
        if not left and not force:
            what = "group leave" if src.get("type") == "group" else "page unfollow"
            return {
                "ok": False,
                "left": False,
                "detail": f"Facebook par {what} nahi ho saka — record rakha hai",
            }
    db.delete_source(source_id)
    try:
        _memory_init(db)
        with db._connect() as conn:
            conn.execute(
                "DELETE FROM source_checks WHERE url=?", (_canon(src.get("url")),)
            )
    except Exception:
        pass
    return {
        "ok": True,
        "left": left,
        "detail": (
            "Facebook se leave/unfollow kiya aur record hata diya"
            if left
            else "record hata diya"
        ),
    }


# ----------------------------------------------------------------------
# 4. feed -> post links
# ----------------------------------------------------------------------
_LINKS_JS = r"""
() => {
  const out = []; const seen = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    let u; try { u = new URL(a.href, location.origin); } catch (e) { continue; }
    let key = null, url = null;
    let m = /^\/groups\/([^/]+)\/(?:posts|permalink)\/([\w-]+)/.exec(u.pathname);
    if (m) { key = 'g' + m[1] + m[2]; url = location.origin + '/groups/' + m[1] + '/posts/' + m[2] + '/'; }
    if (!m) {
      m = /^\/([^/]+)\/posts\/([\w-]+)/.exec(u.pathname);
      if (m) { key = 'p' + m[1] + m[2]; url = location.origin + '/' + m[1] + '/posts/' + m[2]; }
    }
    if (!m && /^\/(permalink|story)\.php$/.test(u.pathname) && u.searchParams.get('story_fbid')) {
      const id = u.searchParams.get('story_fbid'), o = u.searchParams.get('id') || '';
      key = 's' + id + o; url = location.origin + u.pathname + '?story_fbid=' + id + (o ? '&id=' + o : '');
    }
    if (!key || seen.has(key)) continue;
    seen.add(key); out.push(url);
  }
  return out;
}
"""


_TS_JS = r"""
() => {
  const TIME = /^(\d+\s*[smhdwy]|\d+\s*(sec|min|hr|hour|day|week|month|year)s?( ago)?|just now|yesterday|[A-Z][a-z]{2,8}\s+\d{1,2}(,\s*\d{4})?(\s+at\s+[\d:]+\s*[AP]?M?)?)$/i;
  window.__lhn = window.__lhn || 0;
  const ids = [];
  for (const a of document.querySelectorAll('a')) {
    if (a.dataset.lhDone) continue;
    const t = (a.innerText || '').trim();
    if (!t || t.length > 40 || !TIME.test(t)) continue;
    const c = a.closest('[role="article"]');
    if (c && /^(comment|reply) by /i.test(c.getAttribute('aria-label') || '')) continue;
    const h = a.getAttribute('href') || '';
    if (/\/(posts|permalink)\/|permalink\.php|story\.php/.test(h)) { a.dataset.lhDone = '1'; continue; }
    const r = a.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (!a.dataset.lhTs) a.dataset.lhTs = String(++window.__lhn);
    ids.push(a.dataset.lhTs);
  }
  return ids;
}
"""


def _canon_post_url(href):
    """Canonical post URL from a (possibly long) Facebook link, else None."""
    from urllib.parse import parse_qs, urlparse

    try:
        u = urlparse(href if "://" in href else BASE + href)
    except Exception:
        return None
    path = u.path or ""
    m = re.match(r"^/groups/([^/]+)/(?:posts|permalink)/([\w-]+)", path)
    if m:
        return f"{BASE}/groups/{m.group(1)}/posts/{m.group(2)}/"
    m = re.match(r"^/([^/]+)/posts/([\w-]+)", path)
    if m:
        return f"{BASE}/{m.group(1)}/posts/{m.group(2)}"
    if path in ("/permalink.php", "/story.php"):
        q = parse_qs(u.query)
        fid = (q.get("story_fbid") or [""])[0]
        if fid:
            oid = (q.get("id") or [""])[0]
            return f"{BASE}{path}?story_fbid={fid}" + (f"&id={oid}" if oid else "")
    return None


def _resolve_hover_links(page, max_n=12):
    """Facebook only puts the real post link on a timestamp when the
    mouse is over it. Hover the timestamps that have no link yet and
    read the link that appears."""
    found = []
    try:
        ids = page.evaluate(_TS_JS) or []
    except Exception:
        return found
    for ident in ids[:max_n]:
        loc = page.locator(f'a[data-lh-ts="{ident}"]').first
        try:
            loc.hover(timeout=1500)
            time.sleep(0.25)
            href = loc.get_attribute("href") or ""
            page.evaluate(
                "(i) => { const a = document.querySelector('a[data-lh-ts=\"' + i + '\"]'); if (a) a.dataset.lhDone = '1'; }",
                ident,
            )
        except Exception:
            continue
        url = _canon_post_url(href)
        if url:
            found.append(url)
    return found


def feed_post_links(
    page, source_url, known, limit, note=None, should_stop=lambda: False
):
    """Open a source and return up to ``limit`` NEW post URLs in feed
    order. Scrolls as deep as needed: already-scraped posts are skipped,
    so a second Scrap run continues where the first one stopped."""
    goto(page, source_url, note)
    ordered = []
    seen = set()
    no_growth = 0
    for rnd in range(400):
        if should_stop():
            break
        try:
            links = page.evaluate(_LINKS_JS) or []
        except Exception:
            links = []
        links = list(links) + _resolve_hover_links(page)
        before = len(seen)
        for u in links:
            if u in seen:
                continue
            seen.add(u)
            if u in known:
                continue
            ordered.append(u)
        if len(ordered) >= limit:
            break
        no_growth = no_growth + 1 if len(seen) == before else 0
        if rnd % 5 == 0 and note:
            note(
                f"feed scroll {rnd}: {len(seen)} post links seen, {len(ordered)} new, {len(known)} already saved"
            )
        if no_growth >= 8:
            break
        scroll(page, 2, 1.4)
    if not ordered and not seen:
        snapshot(page, "feed-no-links", note)
    return ordered[:limit]


# ----------------------------------------------------------------------
# 5. one post -> full data
# ----------------------------------------------------------------------
_EXPAND_JS = r"""
() => {
  const pats = [/view (\d+ )?more comments?/i, /view previous comments?/i, /more comments?$/i,
                /view (all )?\d+ repl(y|ies)/i, /^\d+ repl(y|ies)$/i, /view more repl(y|ies)/i, /^see more$/i];
  let clicked = 0;
  for (const el of document.querySelectorAll('div[role="button"], span[role="button"], a[role="button"]')) {
    const t = (el.innerText || '').trim();
    if (!t || t.length > 60) continue;
    if (pats.some(p => p.test(t))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      try { el.click(); clicked++; } catch (e) {}
      if (clicked >= 6) break;
    }
  }
  return clicked;
}
"""

_POST_JS = r"""
() => {
  const NOISE = /^(facebook|like|reply|share|edited|author|top fan|follow|·|\.|admin|moderator|most relevant|all comments|newest|write a comment.*|see translation|see original|rate this translation|hide|reactions?)$/i;
  // A post opened in a dialog sits on top of the group feed: read ONLY the
  // dialog, never the posts and comments behind it.
  const dlgs = Array.from(document.querySelectorAll('[role="dialog"]'));
  const dlgTop = dlgs.filter(d => /['\u2019]s (post|photo|video|reel)\b/i.test((d.querySelector('h2, h1') || {}).innerText || '')).pop()
    || dlgs.filter(d => /comment as /i.test(d.innerText || '')).pop() || null;
  const arts = Array.from((dlgTop || document).querySelectorAll('[role="article"]'));
  const isC = a => /^(comment|reply) by /i.test(a.getAttribute('aria-label') || '');
  const main = arts.find(a => !isC(a) && !a.closest('[role="article"][aria-label]')) || null;
  const leaf = (root, skipName) => {
    const parts = [];
    for (const d of root.querySelectorAll('div[dir="auto"], span[dir="auto"]')) {
      if (d.closest('a') || d.querySelector('div[dir="auto"]')) continue;
      if (d.closest('[role="button"]')) continue;
      const t = (d.innerText || '').trim();
      if (!t || NOISE.test(t) || t === skipName) continue;
      if (parts.length && parts[parts.length - 1] === t) continue;
      parts.push(t);
    }
    return parts.join('\n');
  };
  const person = (root, name) => {
    for (const a of root.querySelectorAll('a[href]')) {
      const t = (a.innerText || '').trim();
      const h = a.getAttribute('href') || '';
      if (!t || /\/(comment|reactions|posts|permalink)/.test(h) && t !== name) continue;
      if (name ? t === name : true) {
        let u; try { u = new URL(a.href, location.origin); } catch (e) { return ''; }
        const keep = u.pathname === '/profile.php' ? 'profile.php?id=' + u.searchParams.get('id') : u.pathname.replace(/^\//, '');
        return location.origin + '/' + keep;
      }
    }
    return '';
  };
  let post = {text: '', author: '', author_url: ''};
  if (main) {
    const head = main.querySelector('h2 a, h3 a, h4 a, strong a');
    post.author = head ? (head.innerText || '').trim() : '';
    post.author_url = head ? person(main, post.author) : '';
    const mainOnly = main.cloneNode(true);
    mainOnly.querySelectorAll('[role="article"]').forEach(n => n.remove());
    const msg = mainOnly.querySelector('[data-ad-preview="message"]');
    post.text = msg ? (msg.innerText || '').trim() : leaf(mainOnly, post.author);
  }
  // Fallback: Facebook often opens a post inside a dialog (or without a
  // plain post article). Find author + text from the page structure.
  if (!post.text || !post.author) {
    const scope = dlgTop || document.querySelector('[role="main"]') || document.body;
    const inC = el => { const x = el.closest('[role="article"]'); return !!x && isC(x); };
    const firstC = arts.find(isC) || null;
    const before = el => !firstC || !!(firstC.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING);
    let titleName = '';
    const tEl = scope.querySelector('h1, h2');
    const tm = tEl ? /^(.+?)['’]s (post|photo|video|reel)$/i.exec((tEl.innerText || '').trim()) : null;
    if (tm) titleName = tm[1].trim();
    if (!post.author) {
      for (const a of scope.querySelectorAll('a[href]')) {
        const t = (a.innerText || '').trim();
        const h = a.getAttribute('href') || '';
        if (!t || t.length > 80 || inC(a) || !before(a)) continue;
        if (/\/groups\//.test(h) && !/\/user\//.test(h)) continue;
        if (/\/(posts|permalink|photo|videos|reel|hashtag)\b|^#|l\.facebook|\/share/.test(h)) continue;
        let u; try { u = new URL(a.href, location.origin); } catch (e) { continue; }
        post.author = t;
        post.author_url = u.origin + u.pathname + (u.pathname === '/profile.php' ? '?id=' + u.searchParams.get('id') : '');
        break;
      }
      if (!post.author && titleName) post.author = titleName;
    }
    if (!post.text) {
      const msg = scope.querySelector('[data-ad-preview="message"]');
      if (msg && !inC(msg)) post.text = (msg.innerText || '').trim();
    }
    if (!post.text) {
      const TIME = /^(\d+\s*[smhdwy]|\d+\s*(sec|min|hr|hour|day|week|month|year)s?( ago)?|just now|yesterday|[A-Z][a-z]{2,8}\s+\d{1,2}(,\s*\d{4})?(\s+at\s+[\d:]+\s*[AP]?M?)?|[\d.,]+\s*[KM]?)$/i;
      const parts = [];
      for (const d of scope.querySelectorAll('div[dir="auto"], span[dir="auto"]')) {
        if (d.closest('a') || d.closest('[role="button"]') || d.querySelector('div[dir="auto"]')) continue;
        if (inC(d) || !before(d)) continue;
        const t = (d.innerText || '').trim();
        if (!t || NOISE.test(t) || TIME.test(t) || t === post.author || /see original|rate this translation/i.test(t) || /['’]s (post|photo|video)$/i.test(t) || /^comment as /i.test(t)) continue;
        if (parts.length && parts[parts.length - 1] === t) continue;
        parts.push(t);
      }
      post.text = parts.join('\n').slice(0, 6000);
    }
  }
  const comments = [];
  for (const a of arts) {
    if (!isC(a)) continue;
    const label = a.getAttribute('aria-label') || '';
    const isReply = /^reply by /i.test(label);
    const t = /(\d+\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|months?|years?|yrs?|[smhdwy])\s*ago|an?\s+(?:minute|hour|day|week|month|year)\s+ago|yesterday|just now|[A-Z][a-z]{2,8}\s+\d{1,2}(?:,\s*\d{4})?(?:\s+at\s+[\d:]+\s*[AP]M)?)\s*$/.exec(label);
    const label_time = t ? t[1] : '';
    let head = label.replace(/^(comment|reply) by /i, '');
    if (label_time) head = head.slice(0, head.length - label_time.length).trim();
    head = head.replace(/\s+to\s+.+?'s?\s+comment$/i, '').trim();
    const name = head;
    comments.push({isReply, name, url: person(a, name), time: label_time, text: leaf(a, name)});
  }
  const rootEl = dlgTop || main || document.body;
  const cm = /(\d[\d.,]*\s*[KM]?)\s+comments?\b/i.exec(rootEl.innerText || '');
  let expected = cm ? cm[1] : null;
  if (!expected) {
    for (const el of rootEl.querySelectorAll('[aria-label]')) {
      if (!/^(leave a comment|comment)$/i.test((el.getAttribute('aria-label') || '').trim())) continue;
      const own = (el.innerText || '').trim();
      const par = el.parentElement ? (el.parentElement.innerText || '').trim() : '';
      const pure = /^\d[\d.,]*\s*[KM]?$/;
      if (pure.test(own)) { expected = own; break; }
      if (pure.test(par)) { expected = par; break; }
    }
  }
  return {post, comments, expected: expected, articles: arts.length};
}
"""

_UNITS = {
    "s": "seconds",
    "sec": "seconds",
    "second": "seconds",
    "m": "minutes",
    "min": "minutes",
    "minute": "minutes",
    "h": "hours",
    "hr": "hours",
    "hour": "hours",
    "d": "days",
    "day": "days",
    "w": "weeks",
    "wk": "weeks",
    "week": "weeks",
    "month": "months",
    "y": "years",
    "yr": "years",
    "year": "years",
}


def approx_time(label, base):
    """Relative label ("3 days ago", "5d", "yesterday") -> approximate ISO."""
    t = (label or "").strip().lower()
    if not t:
        return None
    if t in ("just now",):
        return _iso(base)
    if t == "yesterday":
        return _iso(base - timedelta(days=1))
    m = re.match(r"(\d+|an?)\s*([a-z]+?)s?(?:\s+ago)?$", t)
    if not m:
        return None
    n = 1 if m.group(1) in ("a", "an") else int(m.group(1))
    unit = _UNITS.get(m.group(2))
    if not unit:
        return None
    if unit == "months":
        return _iso(base - timedelta(days=30 * n))
    if unit == "years":
        return _iso(base - timedelta(days=365 * n))
    return _iso(base - timedelta(**{unit: n}))


_SCROLL_ALL_JS = r"""
() => {
  let moved = false;
  for (const el of document.querySelectorAll('div')) {
    const cs = getComputedStyle(el);
    if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 80) {
      const before = el.scrollTop;
      el.scrollTop = el.scrollHeight;
      if (el.scrollTop !== before) moved = true;
    }
  }
  window.scrollTo(0, document.body.scrollHeight);
  return moved;
}
"""


def extract_post(page, url, note=None):
    """Open one post and return its full data (comments in the order
    Facebook shows them, replies under their comment). Raises
    EngineError when the page cannot be read at all."""
    goto(page, url, note)
    collected = _now()
    idle = 0
    for _ in range(40):
        try:
            n = page.evaluate(_EXPAND_JS) or 0
        except Exception:
            n = 0
        if n == 0:
            idle += 1
            if idle >= 3:
                break
            # Posts opened in a dialog scroll inside the dialog, not the
            # window: scroll every scrollable box so lazy comments load.
            try:
                page.evaluate(_SCROLL_ALL_JS)
            except Exception:
                pass
            time.sleep(1.4)
        else:
            idle = 0
            _pause(1.2, 2.2)
    try:
        got = page.evaluate(_POST_JS) or {}
    except Exception as exc:  # noqa: BLE001
        raise EngineError(f"could not read the post: {exc}") from exc
    post = got.get("post") or {}
    out_comments = []
    for c in got.get("comments") or []:
        item = {
            "author_name": c.get("name") or "",
            "author_url": c.get("url") or "",
            "text": c.get("text") or "",
            "posted_at": approx_time(c.get("time"), collected),
            "posted_at_label": c.get("time") or "",
        }
        if c.get("isReply") and out_comments:
            out_comments[-1].setdefault("replies", []).append(item)
        else:
            item["replies"] = []
            out_comments.append(item)
    got_total = sum(1 + len(c.get("replies") or []) for c in out_comments)
    expected = _num(got.get("expected") or "") or 0
    if not post.get("text") and not out_comments:
        snapshot(page, "post-empty", note)
        raise EngineError("post page did not show any post or comments")
    if note:
        note(
            f"post {url}: {got_total} comments+replies captured, Facebook shows {expected or '?'}"
        )
    if expected and got_total < max(1, int(expected * 0.5)):
        snapshot(page, "post-few-comments", note)
    return {
        "post_url": url,
        "author_name": post.get("author") or "",
        "author_url": post.get("author_url") or "",
        "text": post.get("text") or "",
        "comments": out_comments,
        "collected_at": _iso(collected),
        "expected": expected,
        "got": got_total,
    }


# ----------------------------------------------------------------------
# jobs (same signature the agent's job thread already calls)
# ----------------------------------------------------------------------
def _note_fn(note):
    return note if callable(note) else (lambda *_a, **_k: None)


def _finish(db, job_id, status, message, **extra):
    db.update_job(
        job_id, status=status, finished_at=_iso(_now()), message=message, **extra
    )


def _fail(db, job_id, message):
    db.update_job(
        job_id,
        status="failed",
        finished_at=_iso(_now()),
        error=str(message),
        message=str(message),
    )


def _canon(url):
    return (url or "").strip().lower().rstrip("/")


def _source_known(db, url):
    row = db.get_source_by_url(url)
    if row is not None:
        return True
    row = (
        db.get_source_by_url(url.rstrip("/"))
        if url.endswith("/")
        else db.get_source_by_url(url + "/")
    )
    return row is not None


_MEMORY_DAYS = 14


def _memory_init(db):
    with db._connect() as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS source_checks ("
            "url TEXT PRIMARY KEY, verdict TEXT, reason TEXT, checked_at TEXT)"
        )


def _remember(db, url, verdict, reason):
    try:
        _memory_init(db)
        with db._connect() as conn:
            conn.execute(
                "INSERT INTO source_checks (url, verdict, reason, checked_at) VALUES (?,?,?,?) "
                "ON CONFLICT(url) DO UPDATE SET verdict=excluded.verdict, reason=excluded.reason, "
                "checked_at=excluded.checked_at",
                (_canon(url), verdict, reason, _iso(_now())),
            )
    except Exception:
        pass


def _recently_rejected(db, url):
    """Reason string when this URL was judged unfit in the last 14 days."""
    try:
        _memory_init(db)
        with db._connect() as conn:
            row = conn.execute(
                "SELECT * FROM source_checks WHERE url=?", (_canon(url),)
            ).fetchone()
        if not row or row["verdict"] != "rejected":
            return None
        age = _now() - datetime.fromisoformat(row["checked_at"])
        return row["reason"] if age < timedelta(days=_MEMORY_DAYS) else None
    except Exception:
        return None


def _hint_score(cand):
    """Cheap ranking from the search card: busy groups first."""
    info = cand.get("info", "")
    score = 0
    m = re.search(r"(\d+)\+?\s*posts?\s+(?:a|per)\s+day", info, re.I)
    if m:
        score += 1000 + min(int(m.group(1)), 500)
    elif re.search(r"posts?\s+(?:a|per)\s+week", info, re.I):
        score += 300
    return score + min(cand.get("member_count") or 0, 200000) / 1000.0


def _batches(it, size):
    batch = []
    for item in it:
        batch.append(item)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch


def _variants(keyword):
    """Search phrasings: Facebook shows a limited result list per
    phrase, so rephrasing reaches different groups."""
    kw = keyword.strip()
    return [
        kw,
        f"{kw} group",
        f"{kw} community",
        f"{kw} discussion",
        f"{kw} forum",
        f"{kw} traders",
    ]


def run_collect(worker, page, db, job, should_stop, note=None):
    import uuid

    job_id = job["id"]
    note = _note_fn(note)
    work = None
    try:
        keyword = (job.get("keyword") or "").strip()
        if not keyword:
            return _fail(db, job_id, "keyword missing")
        country = (job.get("country") or "").strip()
        if country:
            keyword = f"{keyword} {country}"
        kind_arg = (job.get("type") or "group").lower()
        kinds = (
            ["group", "page"]
            if kind_arg == "both"
            else [kind_arg if kind_arg in ("group", "page") else "group"]
        )
        want = max(1, int(job.get("max_new") or 5))
        min_comments = int(job.get("min_comments") or 0)
        min_members = int(job.get("min_members") or 0)
        join = job.get("join") is not False
        account_id = job.get("account_id") or ""
        try:
            # Second tab judges candidates, so the search tab keeps
            # its scroll position and never has to be reloaded.
            work = page.context.new_page()
        except Exception as exc:  # noqa: BLE001
            return _fail(db, job_id, f"could not open a work tab: {exc}")
        saved, rejected, checked = [], [], 0
        counts = {
            "already": 0,
            "remembered": 0,
            "few_members": 0,
            "inactive": 0,
            "private": 0,
            "join_failed": 0,
        }
        stopped = False

        def reject(c, why, key):
            counts[key] += 1
            if key in ("inactive", "few_members", "private"):
                _remember(db, c["url"], "rejected", why)
            if len(rejected) < 150:
                rejected.append(
                    {
                        "name": c.get("name") or c["url"],
                        "url": c["url"],
                        "type": c["kind"],
                        "memberCount": c.get("member_count"),
                        "why": why,
                    }
                )
            note(f"skip {c.get('name') or c['url']}: {why}")
            db.update_job(
                job_id,
                posts_processed=checked,
                new_posts=len(saved),
                result={"sources": saved, "rejected": rejected},
            )

        recheck = bool(job.get("recheck"))
        _memory_init(db)
        tried = set()
        for kind in kinds:
            for phrase in _variants(keyword):
                if stopped or len(saved) >= want:
                    break
                note(f"{kind}s search: {phrase}")
                for batch in _batches(
                    iter_candidates(page, phrase, kind, note, should_stop), 12
                ):
                    if stopped or len(saved) >= want:
                        break
                    batch.sort(key=_hint_score, reverse=True)
                    for cand in batch:
                        if len(saved) >= want:
                            break
                        if should_stop():
                            stopped = True
                            break
                        url = cand["url"]
                        if url.lower() in tried:
                            continue
                        tried.add(url.lower())
                        checked += 1
                        if _source_known(db, url):
                            counts["already"] += 1
                            continue
                        if not recheck:
                            old = _recently_rejected(db, url)
                            if old:
                                counts["remembered"] += 1
                                note(f"skip (pehle dekha, {old}): {cand['name']}")
                                continue
                        members = cand.get("member_count")
                        if members is not None and members < min_members:
                            reject(
                                cand,
                                f"sirf {members} members (chahiye {min_members})",
                                "few_members",
                            )
                            continue
                        if re.search(
                            r"posts?\s+(a|per)\s+(month|year)|no posts",
                            cand.get("info", ""),
                            re.I,
                        ):
                            reject(
                                cand,
                                "search card ke mutabiq group kam active hai",
                                "inactive",
                            )
                            continue
                        if cand.get("private"):
                            reject(
                                cand,
                                "private group: join kiye baghair posts nahi dikhte",
                                "private",
                            )
                            continue
                        act = check_activity(work, url, min_comments, note, should_stop)
                        if act["name"]:
                            cand["name"] = act["name"]
                        members = members if members is not None else act.get("members")
                        cand["member_count"] = members
                        if members is not None and members < min_members:
                            reject(
                                cand,
                                f"sirf {members} members (chahiye {min_members})",
                                "few_members",
                            )
                            continue
                        if not act["ok"]:
                            reject(cand, act["why"], "inactive")
                            continue
                        status = "not-joined"
                        if join:
                            if kind == "group":
                                r = join_group(work, url, note)
                                if r == "failed":
                                    reject(cand, "join nahi ho saka", "join_failed")
                                    continue
                                status = "joined" if r == "joined" else "not-joined"
                                if r == "pending":
                                    note(
                                        f"join request pending (admin approval): {cand['name']}"
                                    )
                            else:
                                status = (
                                    "joined"
                                    if follow_page(work, url, note)
                                    else "not-joined"
                                )
                        sid = uuid.uuid4().hex
                        db.upsert_source(
                            sid,
                            cand["name"],
                            kind,
                            url,
                            members,
                            status,
                            account_id or None,
                        )
                        saved.append(
                            {
                                "id": sid,
                                "name": cand["name"],
                                "type": kind,
                                "url": url,
                                "memberCount": members,
                                "status": status,
                            }
                        )
                        note(f"saved {kind}: {cand['name']} ({status})")
                        db.update_job(
                            job_id,
                            posts_processed=checked,
                            new_posts=len(saved),
                            result={"sources": saved, "rejected": rejected},
                        )
                    if should_stop():
                        stopped = True
                if should_stop():
                    stopped = True
        msg = (
            f"{len(saved)} source save hue (chahiye {want}). Checked {checked}: "
            f"{counts['already']} pehle se, {counts['remembered']} pehle reject hue the, {counts['few_members']} kam members, "
            f"{counts['inactive']} inactive, {counts['private']} private, {counts['join_failed']} join fail"
        )
        if len(saved) < want and not stopped:
            msg += ". Search results khatam ho gaye"
        _finish(
            db,
            job_id,
            "stopped" if stopped else "done",
            msg,
            posts_processed=checked,
            new_posts=len(saved),
            result={"sources": saved, "rejected": rejected, "counts": counts},
        )
    except EngineError as exc:
        _fail(db, job_id, exc)
    except Exception as exc:  # noqa: BLE001
        _fail(db, job_id, exc)
    finally:
        if work is not None:
            try:
                work.close()
            except Exception:
                pass


def _save(db, source_id, account_id, data, synced):
    db.save_post(
        {
            "source_id": source_id,
            "account_id": account_id,
            "post_url": data["post_url"],
            "author_name": data["author_name"],
            "author_url": data["author_url"],
            "text": data["text"],
            "collected_at": data["collected_at"],
            "comments": data["comments"],
        },
        last_synced_at=synced,
    )


def run_scrape(worker, page, db, job, should_stop, note=None):
    job_id = job["id"]
    note = _note_fn(note)
    try:
        source_id = job.get("source_id")
        account_id = job.get("account_id") or ""
        src = db.get_source_by_id(source_id) if source_id else None
        url = (src or {}).get("url") or job.get("source_url")
        if not url:
            return _fail(db, job_id, "source url missing")
        if src is None and source_id:
            db.upsert_source(
                source_id,
                job.get("source_name") or source_id,
                job.get("source_type") or "group",
                url,
                None,
                "joined",
                account_id or None,
            )
        limit = max(1, int(job.get("limit") or 20))
        known = (
            {p["post_url"] for p in db.get_posts_for_source(source_id)}
            if source_id
            else set()
        )
        links = feed_post_links(page, url, known, limit, note, should_stop)
        note(f"{len(links)} naye post links mile")
        done = failed = 0
        problems = []
        stopped = False
        for link in links:
            # Stop is checked only BETWEEN posts: the post in progress
            # is always finished and saved first.
            if should_stop():
                stopped = True
                break
            try:
                data = extract_post(page, link, note)
                _save(db, source_id, account_id, data, None)
                done += 1
                if data["expected"] and data["got"] < data["expected"] * 0.5:
                    problems.append(f"{data['got']}/{data['expected']} comments")
            except EngineError as exc:
                failed += 1
                note(f"post fail: {exc}")
                if "logged out" in str(exc) or "checkpoint" in str(exc):
                    _fail(db, job_id, exc)
                    return
            db.update_job(job_id, posts_processed=done + failed, new_posts=done)
            _pause(2.0, 4.5)
        if source_id:
            db.touch_source_scraped(source_id, _iso(_now()))
        msg = f"{done} post save hue" + (f", {failed} fail" if failed else "")
        if not links:
            msg = (
                "koi naya post nahi mila (debug snapshot agent/debug mein ho sakta hai)"
            )
        if problems:
            msg += f". Kam comments mile: {len(problems)} post(s) mein"
        _finish(
            db,
            job_id,
            "stopped" if stopped else "done",
            msg,
            posts_processed=done + failed,
            new_posts=done,
        )
    except EngineError as exc:
        _fail(db, job_id, exc)
    except Exception as exc:  # noqa: BLE001
        _fail(db, job_id, exc)


def run_sync(worker, page, db, job, should_stop, note=None):
    job_id = job["id"]
    note = _note_fn(note)
    try:
        if job.get("post_id"):
            posts = [p for p in [db.get_post_by_id(job["post_id"])] if p]
        elif job.get("source_id"):
            posts = db.get_posts_for_source(job["source_id"])
        else:
            return _fail(db, job_id, "sync needs a post or source")
        if not posts:
            return _fail(db, job_id, "post not found")
        done = 0
        stopped = False
        notes = []
        for old in posts:
            if should_stop():
                stopped = True
                break
            try:
                data = extract_post(page, old["post_url"], note)
            except EngineError as exc:
                if "logged out" in str(exc) or "checkpoint" in str(exc):
                    return _fail(db, job_id, exc)
                notes.append(str(exc))
                continue
            old_n = sum(
                1 + len(c.get("replies") or []) for c in old.get("comments") or []
            )
            if (
                data["expected"]
                and data["got"] < data["expected"] * 0.7
                and old_n <= data["expected"]
            ):
                # Facebook showed fewer comments this time: keep the
                # richer old snapshot, only mark the post as synced.
                data["comments"] = [
                    {**c, "replies": [dict(r) for r in c.get("replies") or []]}
                    for c in old.get("comments") or []
                ]
                notes.append("kam comments dikhe, purana data rakha")
            if not data["text"]:
                data["text"] = old.get("text") or ""
            if not data["author_name"]:
                data["author_name"] = old.get("author_name") or ""
                data["author_url"] = old.get("author_url") or ""
            data["collected_at"] = old.get("collected_at")
            _save(
                db,
                old.get("source_id"),
                old.get("account_id") or "",
                data,
                _iso(_now()),
            )
            done += 1
            db.update_job(job_id, posts_processed=done, new_posts=0)
            _pause(2.0, 4.0)
        msg = f"{done} post sync hue" + (
            f" ({'; '.join(sorted(set(notes)))})" if notes else ""
        )
        _finish(db, job_id, "stopped" if stopped else "done", msg, posts_processed=done)
    except EngineError as exc:
        _fail(db, job_id, exc)
    except Exception as exc:  # noqa: BLE001
        _fail(db, job_id, exc)
