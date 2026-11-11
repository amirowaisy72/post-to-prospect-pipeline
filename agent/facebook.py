"""Facebook worker for the LeadHunter agent.

Plain class — no Playwright import at module top (only typing), so the
module can be imported without a browser. All methods take a ``page``
supplied by the caller plus a ``ctx`` dict:

    ctx["should_stop"]() -> bool   stop work immediately when True
    ctx["pace"]()        -> None   sleep a safe gap between page loads
    ctx["note"](msg)               free-form note for logs

Proven Facebook shapes (verified live 2026-11-12, Stocks To Watch
group, signed in as Amir Owaisy, read-only):
- Group-feed posts ARE <article> elements headed "<Name>'s post"
  (e.g. "Courtney Hanson's post", "Anonymous participant's post"),
  with author link, timestamp link, post text, and Like/Comment/Share
  buttons naming the post author. "Loading..." placeholder articles
  must be skipped, and nested articles headed "Comment by ..." /
  "Reply by ..." are comments, not posts.
- The Comment button's accessible name is the gate count:
  "Comment on Courtney Hanson's post, 66 comments".
- The feed shows only ~2 comments per post at first, nested <article>
  elements inside the post article, headed "Comment by Trevor Munson
  19 hours ago". Replies hide behind "View N replies" buttons.
- A single post opens as a MODAL DIALOG (div[role="dialog"], titled
  "<Name>'s post"). 10 top-level comment articles load first; more
  load on SCROLLING the dialog — there is no "View more comments"
  button in the dialog. Replies appear as nested articles headed
  "Reply by X to Y's comment ..." after their "View N replies" button
  is expanded; a reply has no Follow button and no reaction count.
- Comments/replies are classified ONLY by their aria-label
  ("Comment by X" vs "Reply by X to Y's comment") — both are flat
  div[role="article"] siblings.
- Timestamps: the visible label ("5d", "19h") is relative, but the
  EXACT time is in the timestamp element's title attribute /
  aria-describedby text ("Wednesday 11 November 2026 at 05:43").
  _EXTRACT_POST_JS returns both per comment/reply (postedAtLabel +
  postedAtExact); the Python side parses the exact time first and
  falls back to the label (see timestamps.py).
- COMPLETENESS (hard rule): not a single comment or reply may be
  missed. extract_post scrolls the dialog until the stated comment
  total is loaded (or 5 no-new scrolls with no "Loading..."
  placeholders left), clicks every expand button until a pass clicks
  0, and repeats until a full scroll+expand pass adds nothing new.
  The collected count is then verified against the post's stated
  total (see jobs.py) — a mismatch is flagged, never silently
  reported as success.

The agent NEVER asks for, handles, or stores a Facebook password.
It runs in the user's own Chrome (persistent profile) and the user
signs in to Facebook once in that window.
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # typing only — no Playwright import at runtime top-level
    from playwright.sync_api import Page

__all__ = ["FacebookWorker"]

BLOCK_MARKERS = [
    "checkpoint",
    "verify your identity",
    "suspicious activity",
    "unusual activity",
    "captcha",
    "prove you're not a robot",
    "temporarily blocked",
    "action blocked",
    "we limit how often",
    "try again later",
    "log in to continue",
]

# JS: collect the feed's posts. Posts are top-level <article> elements
# headed "<Name>'s post"; nested "Comment by"/"Reply by" articles and
# "Loading..." placeholders are skipped. The post URL is the
# /permalink/<id>/ or /posts/<id>/ link inside the article; the
# comment count comes from the Comment button's aria-label
# ("Comment on X's post, N comments") inside the same article.
# Test doubles return their canned data when they see "feed-posts".
_FEED_POSTS_JS = r"""() => {
 /* feed-posts */
 function toNum(s) {
   const m = /(\d[\d.,]*)\s*([KM])?/i.exec(s || '');
   if (!m) return null;
   if (m[2]) return Math.round(parseFloat(m[1].replace(/,/g, '')) * (m[2].toUpperCase() === 'K' ? 1e3 : 1e6));
   return parseInt(m[1].replace(/[.,]/g, ''), 10);
 }
 function postLink(el) {
   const links = el.querySelectorAll('a[href]');
   for (const a of links) {
     const h = a.getAttribute('href') || '';
     const m = h.match(/\/(permalink|posts)\/(\d+)/);
     if (m) return 'https://www.facebook.com/' + m[1] + '/' + m[2] + '/';
   }
   return null;
 }
 function headingName(art) {
   const lab = art.getAttribute('aria-label') || '';
   let m = lab.match(/^\s*(.+?)'s post\b/i);
   if (m) return m[1].trim();
   const t = (art.innerText || '');
   m = t.match(/^\s*(.+?)'s post\b/m);
   if (m) return m[1].trim();
   return null;
 }
 function isNested(art) {
   let anc = art.parentElement;
   while (anc) {
     if (anc.getAttribute && anc.getAttribute('role') === 'article') return true;
     anc = anc.parentElement;
   }
   return false;
 }
 const out = [];
 const seen = new Set();
 for (const art of document.querySelectorAll('div[role="article"]')) {
   if (isNested(art)) continue;
   const lab = art.getAttribute('aria-label') || '';
   if (/^\s*(Comment|Reply) by /i.test(lab)) continue;
   const text = (art.innerText || '');
   if (/^\s*Loading\.\.\./.test(text)) continue;
   const name = headingName(art);
   if (!name) continue;
   const url = postLink(art);
   if (!url || seen.has(url)) continue;
   seen.add(url);
   let cc = null;
   for (const el of art.querySelectorAll('[aria-label]')) {
     const l2 = el.getAttribute('aria-label') || '';
     const cm = l2.match(/Comment on (.+?)'s post,\s*(\d[\d.,]*\s*[KM]?)\s+comments?/i);
     if (cm) { cc = toNum(cm[2]); break; }
   }
   out.push({post_url: url, author_name: name, comment_count: cc});
 }
 return out;
}"""

# JS: extract ONE post from its modal dialog — a port of
# extension/structured.js dialog mode, extended with timestamps.
# Returns {author_name, author_url, text, comments: [{author_name,
# author_url, text, posted_at_label, posted_at_exact, replies: [...]}]}
# or null when no post dialog is present. posted_at_label is the
# visible relative label ("5d"); posted_at_exact is the timestamp
# element's title / aria-describedby text
# ("Wednesday 11 November 2026 at 05:43"), or null.
# Test doubles return their canned data when they see "extract-post".
_EXTRACT_POST_JS = r"""() => {
 /* extract-post */
 var NAV = new Set(['search','groups','pages','events','marketplace','watch','login','settings','notifications','messages','friends','photos','videos','reels','reel','video','photo','story','gaming','fundraisers','saved','bookmarks','home','privacy','help','about','ads','business','developers','policies','dialog','plugins','sharer','tr','campaign','boost','live','stories','groups_feed','profile.php','professional_dashboard','creator_studio','monetization','creator','insights','publishing_tools','ads_manager']);
 function profileFromHref(href) {
   if (!href) return null;
   href = href.replace(/^https?:\/\/(www\.)?facebook\.com/i, '');
   var m = href.match(/^\/profile\.php\?id=(\d+)/);
   if (m) return 'https://www.facebook.com/profile.php?id=' + m[1];
   m = href.match(/^\/groups\/\d+\/user\/(\d+)/);
   if (m) return 'https://www.facebook.com/profile.php?id=' + m[1];
   m = href.match(/^\/([A-Za-z0-9._-]+)(\?|#|$)/);
   if (!m) return null;
   if (NAV.has(m[1].toLowerCase())) return null;
   if (!/[A-Za-z]/.test(m[1])) return null;
   return 'https://www.facebook.com/' + m[1];
 }
 function ownText(el) {
   var t = (el.innerText || '').trim();
   try {
     var nested = el.querySelectorAll('div[role="article"]');
     for (var ni = 0; ni < nested.length; ni++) {
       var nt = (nested[ni].innerText || '').trim();
       if (nt && t.indexOf(nt) !== -1) t = t.split(nt).join(' ');
     }
   } catch (e) {}
   return t.trim();
 }
 function cleanCommentText(raw, name) {
   var lines = raw.split('\n').map(function (s) { return s.trim(); })
     .filter(function (s) { return s.length > 0; });
   while (lines.length > 1) {
     var first = lines[0];
     if (name && first === name) { lines.shift(); continue; }
     if (/^·$/.test(first)) { lines.shift(); continue; }
     if (/^\d+[smhdw]$/.test(first)) { lines.shift(); continue; }
     if (/^\d+mo$/.test(first)) { lines.shift(); continue; }
     if (/^\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i.test(first)) { lines.shift(); continue; }
     if (/^(Yesterday|Just now)$/i.test(first)) { lines.shift(); continue; }
     if (/^Follow$/i.test(first)) { lines.shift(); continue; }
     if (/^\d+(\.\d+)?[KM]?$/.test(first)) { lines.shift(); continue; }
     break;
   }
   while (lines.length > 1) {
     var last = lines[lines.length - 1];
     if (name && last === name) { lines.pop(); continue; }
     if (/^(Reply|Like|Share|See translation|See original.*)(\s+\d+(\.\d+)?[KM]?)?$/i.test(last) ||
         /^\d+(\.\d+)?[KM]?$/.test(last)) {
       lines.pop();
     } else break;
   }
   return lines.join('\n').trim();
 }
 function firstProfileLink(el) {
   var links = el.querySelectorAll('a[href]');
   for (var li = 0; li < links.length; li++) {
     var url = profileFromHref(links[li].getAttribute('href') || '');
     if (!url) continue;
     var nm = (links[li].innerText || '').trim();
     if (nm) return { name: nm, url: url };
   }
   return null;
 }
 function stripTimestamp(name) {
   return (name || '')
     .replace(/\s+\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago\s*$/i, '')
     .replace(/\s+\d+mo\s*$/i, '')
     .replace(/\s+\d+[smhdw]\s*$/i, '')
     .replace(/\s+(Yesterday|Just now)\s*$/i, '').trim();
 }
 function articleKind(art) {
   var label = '';
   try { label = art.getAttribute('aria-label') || ''; } catch (e) {}
   var m = label.match(/^\s*Reply by (.+?) to (.+?)'s comment/i);
   if (m) return { kind: 'reply', author: stripTimestamp(m[1]), parent: stripTimestamp(m[2]) };
   m = label.match(/^\s*Comment by (.+?)(?:\s+·|\s*$)/i);
   if (m) return { kind: 'comment', author: stripTimestamp(m[1]), parent: null };
   return { kind: 'unknown', author: null, parent: null };
 }
 // Exact-time pattern for a timestamp description, e.g.
 // "Wednesday 11 November 2026 at 05:43" or "5 November at 21:02".
 var EXACT_RE = /(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+)?\d{1,2}\s+[A-Za-z]+\s+(?:\d{4}\s+)?at\s+\d{1,2}:\d{2}/i;
 var LABEL_RE = /(\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago|\d+mo|\d+[smhdw]|Yesterday(?:\s+at\s+.*)?|Just now)\s*$/i;
 var LABEL_LINE_RE = /^(\d+[smhdw]|\d+mo|\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago|Yesterday|Just now)$/i;
 // Per-article timestamps: posted_at_label is the visible relative
 // label (aria-label trailing timestamp, else the leading timestamp
 // line of the article text); posted_at_exact is the timestamp
 // element's title attribute, else the text of the element its
 // aria-describedby points at — whichever matches the exact-time
 // pattern. Both may be null when Facebook shows neither.
 function timestampInfo(art) {
   var label = null;
   var exact = null;
   var ariaLabel = '';
   try { ariaLabel = art.getAttribute('aria-label') || ''; } catch (e) {}
   var lm = ariaLabel.match(LABEL_RE);
   if (lm) label = lm[1].trim();
   var described = [];
   try {
     var els = art.querySelectorAll('[title], [aria-describedby]');
     for (var ei = 0; ei < els.length; ei++) {
       var el = els[ei];
       var title = el.getAttribute('title') || '';
       var tm = title.match(EXACT_RE);
       if (tm) { exact = tm[0]; break; }
       var ids = (el.getAttribute('aria-describedby') || '').split(/\s+/);
       for (var di = 0; di < ids.length; di++) {
         if (!ids[di]) continue;
         var target = document.getElementById(ids[di]);
         if (!target) continue;
         var dtxt = (target.textContent || '').trim();
         var dm = dtxt.match(EXACT_RE);
         if (dm) { exact = dm[0]; described.push(dtxt); break; }
       }
       if (exact) break;
     }
   } catch (e) {}
   if (!label) {
     var lines = ownText(art).split('\n');
     for (var li = 0; li < lines.length; li++) {
       var line = (lines[li] || '').trim();
       if (LABEL_LINE_RE.test(line)) { label = line; break; }
     }
   }
   return { label: label, exact: exact };
 }
 function buildCommentTree(articles) {
   var roots = [];
   var flat = [];
   for (var i = 0; i < articles.length; i++) {
     var art = articles[i];
     var author = firstProfileLink(art);
     if (!author) {
       var kind0 = articleKind(art);
       if (kind0.author) author = { name: kind0.author, url: null };
     }
     if (!author) continue;
     var ctext = cleanCommentText(ownText(art), author.name);
     if (!ctext) continue;
     var kind = articleKind(art);
     var ts = timestampInfo(art);
     var node = { author_name: author.name, author_url: author.url, text: ctext,
                  posted_at_label: ts.label, posted_at_exact: ts.exact, replies: [] };
     if (kind.kind === 'reply') {
       var parent = null;
       for (var j = flat.length - 1; j >= 0; j--) {
         if (flat[j].author_name === kind.parent) { parent = flat[j]; break; }
       }
       if (!parent) {
         for (var k = roots.length - 1; k >= 0; k--) {
           parent = roots[k]; break;
         }
       }
       if (parent) parent.replies.push(node);
       else roots.push(node);
     } else {
       roots.push(node);
     }
     flat.push(node);
   }
   return roots;
 }
 function cleanPostText(raw, authorName) {
   var t = raw;
   if (authorName && t.indexOf(authorName) !== -1) {
     t = t.split(authorName).join(' ');
   }
   t = t.replace(/'s post\b/g, ' ');
   t = t.replace(/\bFollow\b/g, ' ');
   t = t.replace(/^\s*(\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago|\d+[smhdw]|\d+mo|Yesterday at [^ ]+ [^ ]+|Just now)\s*/i, ' ');
   t = t.replace(/(?:Facebook\s+){2,}/gi, ' ');
   var lines = t.split('\n').map(function (s) { return s.trim(); })
     .filter(function (s) { return s.length > 0; });
   lines = lines.filter(function (s) {
     if (/^Facebook$/i.test(s)) return false;
     if (/^View \d+ repl(?:y|ies)$/i.test(s)) return false;
     if (/^Most relevant$/i.test(s)) return false;
     if (/^Comment as /i.test(s)) return false;
     return true;
   });
   while (lines.length > 1) {
     var last = lines[lines.length - 1];
     if (/^(Comment|Share|React|Like|Most relevant|See who reacted.*|View .* replies?)$/i.test(last) ||
         /^\d+(\.\d+)?[KM]?$/.test(last)) {
       lines.pop();
     } else break;
   }
   return lines.join(' ').replace(/\s+/g, ' ').trim();
 }
 var dialogs = document.querySelectorAll('div[role="dialog"]');
 for (var di = 0; di < dialogs.length; di++) {
   var dlg = dialogs[di];
   var dlgText = (dlg.innerText || '');
   if (!/'s post/i.test(dlgText)) continue;
   var author = null;
   var hm = (dlg.innerText || '').match(/^\s*(.+?)'s post\b/im);
   var headingName = hm ? hm[1].trim() : null;
   if (headingName) {
     var links = dlg.querySelectorAll('a[href]');
     for (var li = 0; li < links.length; li++) {
       var url = profileFromHref(links[li].getAttribute('href') || '');
       if (!url) continue;
       var nm = (links[li].innerText || '').trim();
       if (nm && nm === headingName) { author = { name: nm, url: url }; break; }
     }
     if (!author) author = { name: headingName, url: null };
   }
   if (!author) author = firstProfileLink(dlg);
   if (!author) continue;
   var postText = cleanPostText(ownText(dlg), author.name);
   var articles = dlg.querySelectorAll('div[role="article"]');
   // The dialog header states the total ("229 comments") — the
   // completeness check compares the collected count against it.
   var tm = dlgText.match(/([\d,]+)\s+comments/i);
   return { author_name: author.name, author_url: author.url, text: postText,
            comment_total: tm ? parseInt(tm[1].replace(/,/g, ''), 10) : null,
            comments: buildCommentTree(articles) };
 }
 return null;
}"""

# JS: click expand buttons so hidden content enters the DOM — "See more"
# (truncated post/comment text), "View more comments" / "View previous
# comments" (hidden comments), "View replies" / "N replies" (comment
# replies). Returns how many buttons it clicked (cap 15 per call).
# In the single-post dialog there is no "View more comments" button —
# scrolling the dialog loads more comments — but the "View N replies"
# buttons here are what reveal replies. Test doubles return 0 when
# they see the "expand-buttons" marker.
_EXPAND_JS = r"""() => {
 /* expand-buttons */
 const pats = [/see more/i, /view more comments/i, /view more answers/i, /view previous comments/i,
 /view .*replies/i, /^\d+ replies?$/i, /show .*replies/i, /view all comments/i];
 const els = [];
 document.querySelectorAll('div[role="button"], span, a').forEach(el => {
   const t = (el.innerText || '').trim();
   if (!t || t.length > 60) return;
   if (pats.some(p => p.test(t))) els.push(el);
 });
 let clicked = 0;
 for (const el of els.slice(0, 15)) {
   try { el.click(); clicked++; } catch (e) {}
 }
 return clicked;
}"""

# JS: how many div[role="article"] are currently in the DOM. Used to
# wait for the feed to actually render before the first extraction.
# Test doubles return their canned count when they see "article-count".
_ARTICLE_COUNT_JS = r"""() => {
 /* article-count */
 try { return document.querySelectorAll('div[role="article"]').length; }
 catch (e) { return 0; }
}"""

# JS: state of the single-post dialog for the exhaustiveness loop —
# the post's stated comment total (dialog stats "229 comments", else
# the Comment button aria-label), how many top-level comment articles
# ("Comment by ...") have loaded, and how many "Loading..."
# placeholder articles remain. Test doubles return their canned
# state when they see "dialog-state".
_DIALOG_STATE_JS = r"""() => {
 /* dialog-state */
 const dlg = document.querySelector('div[role="dialog"]');
 if (!dlg) return null;
 function toNum(s) {
   const m = /(\d[\d.,]*)\s*([KM])?/i.exec(s || '');
   if (!m) return null;
   if (m[2]) return Math.round(parseFloat(m[1].replace(/,/g, '')) * (m[2].toUpperCase() === 'K' ? 1e3 : 1e6));
   return parseInt(m[1].replace(/[.,]/g, ''), 10);
 }
 let total = null;
 const txt = dlg.innerText || '';
 const m = txt.match(/([\d,]+)\s+comments/i);
 if (m) total = parseInt(m[1].replace(/,/g, ''), 10);
 if (total === null) {
   for (const el of dlg.querySelectorAll('[aria-label]')) {
     const lab = el.getAttribute('aria-label') || '';
     const cm = lab.match(/Comment on (.+?)'s post,\s*(\d[\d.,]*\s*[KM]?)\s+comments?/i);
     if (cm) { total = toNum(cm[2]); break; }
   }
 }
 let top = 0, loading = 0;
 for (const art of dlg.querySelectorAll('div[role="article"]')) {
   const lab = art.getAttribute('aria-label') || '';
   if (/^\s*Comment by /i.test(lab)) top++;
   if (/^\s*Loading\.\.\./.test((art.innerText || ''))) loading++;
 }
 return {total: total, top_comments: top, loading: loading};
}"""

# JS: scroll the single-post dialog down one screen so more comments
# load (the dialog has no "View more comments" button).
_DIALOG_SCROLL_JS = r"""() => {
 /* dialog-scroll */
 const dlg = document.querySelector('div[role="dialog"]');
 if (!dlg) return false;
 dlg.scrollTop = dlg.scrollTop + dlg.clientHeight;
 return true;
}"""


def _should_stop(ctx: dict | None) -> bool:
    try:
        fn = (ctx or {}).get("should_stop")
        return bool(fn()) if callable(fn) else False
    except Exception:
        return False


def _pace(ctx: dict | None) -> None:
    try:
        fn = (ctx or {}).get("pace")
        if callable(fn):
            fn()
    except Exception:
        pass


def _note(ctx: dict | None, msg: str) -> None:
    try:
        fn = (ctx or {}).get("note")
        if callable(fn):
            fn(msg)
    except Exception:
        pass


class FacebookWorker:
    """Facebook browsing worker. Methods take a live ``page`` + ``ctx``."""

    key = "facebook"
    display_name = "Facebook"
    base_url = "https://www.facebook.com"
    login_url = "https://www.facebook.com/login"
    home_url = "https://www.facebook.com"

    # ------------------------------------------------------------------
    # Login / block detection
    # ------------------------------------------------------------------
    def check_session(self, page: Page, ctx: dict | None = None) -> str:
        """Classify the current page: ok | logged_out | checkpoint |
        blocked | empty. Never raises.

        'empty' means the page never rendered any content — different
        from logged out, and it must not be treated as "0 results".
        A login prompt ("log in to continue") is logged_out, never a
        block. Login wall is checked before generic block markers.
        """
        try:
            url = (page.url or "").lower()
        except Exception:
            url = ""
        try:
            title = (page.title() or "")
        except Exception:
            title = ""
        try:
            body = page.inner_text("body") or ""
        except Exception:
            body = ""
        low = body.lower()
        if "/checkpoint" in url or "checkpoint" in url:
            return "checkpoint"
        if "verify your identity" in low or "checkpoint" in low:
            return "checkpoint"
        try:
            if page.locator('input[type="password"]').count() > 0:
                return "logged_out"
        except Exception:
            pass
        if "/login" in url:
            return "logged_out"
        if title.strip().lower() in ("log in", "login", "log into facebook"):
            return "logged_out"
        if "log in to continue" in low:
            return "logged_out"
        for marker in BLOCK_MARKERS:
            if marker in low:
                return "blocked"
        # Logged-in chrome present -> ok even if the body is thin.
        for selector in (
            'a[aria-label="Your profile"]',
            'a[aria-label="Account"]',
            'a[href="/me/"]',
            '[aria-label="Messenger"]',
        ):
            try:
                if page.locator(selector).count() > 0:
                    return "ok"
            except Exception:
                continue
        if not body.strip():
            try:
                links = page.query_selector_all("a[href]")
            except Exception:
                links = []
            if not links:
                return "empty"
        return "ok"

    def session_state(self, page: Page, ctx: dict | None = None) -> dict:
        """Full session snapshot for logs / health."""
        try:
            url = page.url or ""
        except Exception:
            url = "?"
        try:
            title = page.title() or ""
        except Exception:
            title = ""
        try:
            body = page.inner_text("body") or ""
        except Exception:
            body = ""
        try:
            login_form = page.locator('input[type="password"]').count() > 0
        except Exception:
            login_form = False
        checkpoint = "checkpoint" in (url + " " + body).lower()
        try:
            links = len(page.query_selector_all("a[href]"))
        except Exception:
            links = 0
        return {
            "state": self.check_session(page, ctx),
            "url": url,
            "title": title.strip()[:120],
            "body_len": len(body),
            "login_form": login_form,
            "checkpoint": checkpoint,
            "links": links,
        }

    def verify_session(self, page: Page, ctx: dict | None) -> str:
        """Load home, classify the session. Returns the session state
        ('ok' when the session is alive). Callers must STOP the job on
        any non-ok state. Never raises."""
        state = "empty"
        try:
            if self._goto(page, self.home_url, ctx, "home"):
                self._wait_ready(page, ctx)
                state = self.check_session(page, ctx)
            else:
                state = "empty"
        except Exception as exc:  # noqa: BLE001 - never raise on a check
            _note(ctx, f"session check failed: {exc}")
            state = "empty"
        if state != "ok":
            _note(ctx, f"Facebook session state: {state} — sign in to "
                       "Facebook in the agent Chrome window.")
        return state

    # ------------------------------------------------------------------
    # Page loading
    # ------------------------------------------------------------------
    def _goto(self, page: Page, url: str, ctx: dict | None,
              label: str, timeout_ms: int = 20000) -> bool:
        """Goto with an explicit timeout + ONE retry on failure.
        Returns True when the navigation completed. Never raises."""
        for attempt in (1, 2):
            try:
                page.goto(url, wait_until="domcontentloaded",
                          timeout=timeout_ms)
                return True
            except Exception as exc:  # noqa: BLE001 - retry once, then give up
                if attempt == 1:
                    _note(ctx, f"goto {label} failed, retrying once: {exc}")
                    try:
                        page.wait_for_timeout(3000)
                    except Exception:
                        time.sleep(3)
                    continue
                _note(ctx, f"goto {label} failed after retry: {exc}")
                return False
        return False

    def _wait_ready(self, page: Page, ctx: dict | None,
                    timeout_s: float = 10.0, poll_ms: int = 500) -> bool:
        """Poll until the page shows real content (or the bound expires).
        Facebook is a React SPA: domcontentloaded fires long before the
        content renders. Bounded by poll count so it can never hang.
        Never raises."""
        polls = max(1, int(timeout_s * 1000 / poll_ms))
        for _ in range(polls):
            if _should_stop(ctx):
                return False
            try:
                if (page.inner_text("body") or "").strip():
                    return True
            except Exception:
                pass
            try:
                if page.query_selector_all("a[href]"):
                    return True
            except Exception:
                pass
            try:
                if page.locator("h1").count() > 0:
                    return True
            except Exception:
                pass
            try:
                page.wait_for_timeout(poll_ms)
            except Exception:
                time.sleep(poll_ms / 1000.0)
        return False

    def _load(self, page: Page, url: str, ctx: dict | None,
              label: str, timeout_ms: int = 20000) -> bool:
        """Load a page: pace, goto+retry, readiness wait, session check.
        Returns True only when the page loaded with a live session.
        On a dead session returns False (noted once) — the caller must
        stop. Never raises."""
        _pace(ctx)
        if not self._goto(page, url, ctx, label, timeout_ms=timeout_ms):
            return False
        self._wait_ready(page, ctx)
        state = self.check_session(page, ctx)
        if state != "ok":
            _note(ctx, f"session {state} on {label}")
            return False
        return True

    def _wait_for_articles(self, page: Page, ctx: dict | None,
                           timeout_s: float = 20.0,
                           poll_ms: int = 500) -> int:
        """Poll _ARTICLE_COUNT_JS until articles appear (up to 20s).
        Returns the last count seen (0 when the feed never rendered).
        Never raises."""
        count = 0
        polls = max(1, int(timeout_s * 1000 / poll_ms))
        for _ in range(polls):
            if _should_stop(ctx):
                break
            try:
                count = int(page.evaluate(_ARTICLE_COUNT_JS) or 0)
            except Exception:
                count = 0
            if count > 0:
                return count
            try:
                page.wait_for_timeout(poll_ms)
            except Exception:
                time.sleep(poll_ms / 1000.0)
        return count

    # ------------------------------------------------------------------
    # Feed collection + single-post extraction
    # ------------------------------------------------------------------
    def collect_feed_post_urls(self, page: Page, source_url: str,
                               known_urls, limit: int,
                               ctx: dict | None = None) -> list:
        """Collect NEW post URLs from a group/page feed.

        Loads the feed, waits for articles, then rounds of
        _FEED_POSTS_JS + scroll. Stops at ``limit``, after a streak of
        10 already-known URLs, or after 5 rounds that bring nothing
        new (Facebook loads lazily, so a few empty rounds are normal).
        Each round checks ctx stop. Returns only URLs not in
        ``known_urls``. Never raises.
        """
        known = set(known_urls or [])
        if not self._load(page, source_url, ctx, "source"):
            return []
        self._wait_for_articles(page, ctx)
        found: list = []
        seen = set(known)
        known_streak = 0
        empty_rounds = 0
        for _ in range(60):
            if _should_stop(ctx):
                break
            if len(found) >= limit:
                break
            try:
                rows = page.evaluate(_FEED_POSTS_JS) or []
            except Exception:
                rows = []
            new_this_round = 0
            for row in rows or []:
                url = (row or {}).get("post_url")
                if not url:
                    continue
                if url in known:
                    known_streak += 1
                    if known_streak >= 10:
                        break
                    continue
                if url in seen:
                    continue
                seen.add(url)
                found.append(url)
                new_this_round += 1
                known_streak = 0
                if len(found) >= limit:
                    break
            if known_streak >= 10:
                break
            if new_this_round == 0:
                empty_rounds += 1
                if empty_rounds >= 5:
                    break
            else:
                empty_rounds = 0
            try:
                page.evaluate("window.scrollBy(0, window.innerHeight)")
            except Exception:
                try:
                    page.mouse.wheel(0, 800)
                except Exception:
                    pass
            try:
                page.wait_for_timeout(2000)
            except Exception:
                time.sleep(2)
        return found

    def _dialog_state(self, page: Page) -> dict:
        """Current dialog state via _DIALOG_STATE_JS, or {} when there
        is no dialog / the check fails. Never raises."""
        try:
            state = page.evaluate(_DIALOG_STATE_JS)
        except Exception:
            return {}
        return state if isinstance(state, dict) else {}

    def _scroll_dialog_until_loaded(self, page: Page,
                                    ctx: dict | None = None) -> dict:
        """Scroll the post dialog until the loaded top-level comment
        count reaches the post's stated total, OR until 5 consecutive
        scrolls bring no new comments and no "Loading..." placeholders
        remain. Each scroll is followed by a ~1.5s wait. Returns the
        last dialog state. Never raises."""
        state = self._dialog_state(page)
        total = (state or {}).get("total")
        prev_top = (state or {}).get("top_comments") or 0
        no_new = 0
        for _ in range(60):
            if _should_stop(ctx):
                break
            if total and prev_top >= total:
                break
            if no_new >= 5 and not (state or {}).get("loading"):
                break
            try:
                page.evaluate(_DIALOG_SCROLL_JS)
            except Exception:
                pass
            try:
                page.wait_for_timeout(1500)
            except Exception:
                time.sleep(1.5)
            state = self._dialog_state(page)
            top = (state or {}).get("top_comments") or 0
            total = (state or {}).get("total") or total
            if top > prev_top:
                prev_top = top
                no_new = 0
            else:
                no_new += 1
        return state

    def _expand_all(self, page: Page, ctx: dict | None = None) -> int:
        """Click EVERY expand button ("View N replies", "View more
        comments" / "View more answers", "See more", ...) until a full
        pass clicks 0 — re-scanning after each round, because replies
        that appear may themselves contain nested expand buttons.
        Capped at 200 clicks per post. Returns the clicks made.
        Never raises."""
        total_clicked = 0
        while total_clicked < 200:
            if _should_stop(ctx):
                break
            try:
                clicked = int(page.evaluate(_EXPAND_JS) or 0)
            except Exception:
                clicked = 0
            total_clicked += clicked
            if clicked == 0:
                break
            try:
                page.wait_for_timeout(1000)
            except Exception:
                time.sleep(1)
        if total_clicked:
            _note(ctx, f"expanded {total_clicked} buttons in post dialog")
        return total_clicked

    def extract_post(self, page: Page, post_url: str,
                     ctx: dict | None = None) -> dict | None:
        """Extract one post (with comments/replies) from its dialog —
        EXHAUSTIVELY. No comment or reply may be missed.

        Gotos the post URL, waits up to 20s for the dialog, then
        repeats scroll+expand cycles until a full pass adds nothing
        new: scroll the dialog until the stated comment total is
        loaded (or 5 no-new scrolls with no "Loading..." placeholders
        left), click every expand button until a pass clicks 0, then
        scroll again (expanding can trigger more loading). Only then
        is the post extracted. The returned dict carries
        ``comment_total`` (the post's stated total, or None) alongside
        the usual author/text/comments. Returns None when the dialog
        never appears. Never raises.
        """
        if not self._goto(page, post_url, ctx, "post"):
            return None
        self._wait_ready(page, ctx)
        data = None
        for _ in range(40):  # up to ~20s for the dialog to appear
            if _should_stop(ctx):
                return None
            try:
                data = page.evaluate(_EXTRACT_POST_JS)
            except Exception:
                data = None
            if data and data.get("author_name"):
                break
            try:
                page.wait_for_timeout(500)
            except Exception:
                time.sleep(0.5)
        if not data or not data.get("author_name"):
            _note(ctx, f"post dialog never appeared: {post_url}")
            return None
        for _ in range(6):  # scroll+expand cycles until a pass adds nothing
            if _should_stop(ctx):
                break
            before = self._dialog_state(page)
            before_top = (before or {}).get("top_comments") or 0
            self._scroll_dialog_until_loaded(page, ctx)
            clicked = self._expand_all(page, ctx)
            self._scroll_dialog_until_loaded(page, ctx)
            after = self._dialog_state(page)
            after_top = (after or {}).get("top_comments") or 0
            if clicked == 0 and after_top == before_top:
                break
        try:
            fresh = page.evaluate(_EXTRACT_POST_JS)
        except Exception:
            fresh = None
        if fresh and fresh.get("author_name"):
            data = fresh
        state = self._dialog_state(page)
        if data.get("comment_total") is None and state.get("total") is not None:
            data["comment_total"] = state.get("total")
        return data
