"""Facebook worker for the LeadHunter agent.

Plain class — no Playwright import at module top (only typing), so the
module can be imported without a browser. All methods take a ``page``
supplied by the caller plus a ``ctx`` dict:

    ctx["should_stop"]() -> bool   stop work immediately when True
    ctx["pace"]()        -> None   sleep a safe gap between page loads
    ctx["note"](msg)               free-form note for logs

Proven Facebook shapes — CORRECTED 2026-11-12 ~04:50 PKT by the
agent's own feed diagnostic on the live Stock Market Traders.
group (earlier "proven" claims were WRONG and caused three rounds
of 0-post scrapes; do not reintroduce them):
- Feed items ARE div[role="article"] (0 literal <article> tags in
  the live feed). Posts and comments are FLAT SIBLINGS, not nested.
- There is NO "<Name>'s post" heading anywhere in the feed — a
  heading gate rejects every real post. A post's author is its
  first innerText line (Facebook repeats the name: "Jj Mathosi
  Jj Mathosi") or a plain-name aria-label.
- Comments are identifiable ONLY by aria-label starting
  "Comment by " / "Reply by " (time appended, e.g. "Comment by
  David Vaughn 25 weeks ago").
- A post is identified by its OWN timestamp link: a
  /permalink/<id>/ or /posts/<id>/ link WITHOUT a comment_id
  parameter. A comment's timestamp link points at the same post
  but carries ?comment_id=... — that is what tells them apart.
- The strict Comment-button pattern ("Comment on X's post, N
  comments") matches NOTHING in the live feed. Comment counts
  are optional: any descendant whose aria-label contains
  "comment" with a number near it.
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

import random
import re
import time
from typing import TYPE_CHECKING, Any
from urllib.parse import parse_qs, quote, urlparse

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

# JS: collect the feed's posts. CORRECTED from the live diagnostic
# (2026-11-12 ~04:50 PKT, Stock Market Traders. group): feed items
# ARE div[role="article"] (literal <article> tags do not occur, but
# the selector covers both forms anyway); posts and comments are
# FLAT SIBLINGS. There is NO "<Name>'s post" heading — a heading
# gate rejected every real post, so it is GONE: a post is a
# top-level article whose aria-label does NOT start with
# "Comment by " / "Reply by ", and which contains a /permalink/ or
# /posts/ link WITHOUT a comment_id parameter (a comment's
# timestamp link carries ?comment_id=... — that is what tells a
# post from a comment). The author is the first innerText line
# (doubled names collapsed) or a plain-name aria-label, and is
# NEVER a gate — an empty name is still collected. The comment
# count is OPTIONAL (null when not found): any descendant whose
# aria-label contains "comment" with a number near it. A post with
# no permalink link (e.g. a photo post) is still kept when it has
# a comment button — it is opened via that button later, keyed by
# author + comment count + text head so it can be found again.
# Test doubles return their canned data when they see "feed-posts".
_FEED_POSTS_JS = r"""() => {
 /* feed-posts */
 function toNum(s) {
   const m = /(\d[\d.,]*)\s*([KM])?/i.exec(s || '');
   if (!m) return null;
   if (m[2]) return Math.round(parseFloat(m[1].replace(/,/g, '')) * (m[2].toUpperCase() === 'K' ? 1e3 : 1e6));
   return parseInt(m[1].replace(/[.,]/g, ''), 10);
 }
 function barePostLink(el) {
   const links = el.querySelectorAll('a[href]');
   for (const a of links) {
     const h = a.getAttribute('href') || '';
     const m = h.match(/\/(permalink|posts)\/(\d+)/);
     if (m && !/[?&]comment_id=/.test(h)) return 'https://www.facebook.com/' + m[1] + '/' + m[2] + '/';
   }
   return null;
 }
 function collapseDoubled(name) {
   const n = (name || '').trim();
   const m = n.match(/^(.+?)\s+\1$/);
   return m ? m[1].trim() : n;
 }
 function authorName(art) {
   const lab = (art.getAttribute('aria-label') || '').trim();
   if (lab && !/^\s*(Comment|Reply) by /i.test(lab)) return collapseDoubled(lab);
   const lines = (art.innerText || '').split('\n');
   for (const line of lines) {
     const t = line.trim();
     if (t) return collapseDoubled(t);
   }
   return '';
 }
 function commentCount(art) {
   for (const el of art.querySelectorAll('[aria-label]')) {
     const l = el.getAttribute('aria-label') || '';
     if (!/comment/i.test(l)) continue;
     let m = l.match(/(\d[\d.,]*\s*[KM]?)\s*comments?/i);
     if (m) return toNum(m[1]);
     const t = (el.innerText || '').trim();
     if (t.length <= 12) {
       m = t.match(/^(\d[\d.,]*\s*[KM]?)$/);
       if (m) return toNum(m[1]);
     }
   }
   return null;
 }
 function commentButton(art) {
   let fallback = null;
   for (const el of art.querySelectorAll('[aria-label]')) {
     const l = el.getAttribute('aria-label') || '';
     if (!/comment/i.test(l)) continue;
     const tag = (el.tagName || '').toUpperCase();
     const role = (el.getAttribute('role') || '').toLowerCase();
     if (tag === 'INPUT' || tag === 'TEXTAREA' || role === 'textbox') continue;
     if (!fallback) fallback = el;
     if (tag === 'BUTTON' || role === 'button' || /^comment$/i.test(l.trim())) return el;
   }
   return fallback;
 }
 function entryKey(name, cc, text) {
   const head = (text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
   return name + '|' + (cc === null || cc === undefined ? '' : cc) + '|' + head;
 }
 function isNested(art) {
   let anc = art.parentElement;
   while (anc) {
     if (anc.tagName === 'ARTICLE') return true;
     if (anc.getAttribute && anc.getAttribute('role') === 'article') return true;
     anc = anc.parentElement;
   }
   return false;
 }
 const out = [];
 const seen = new Set();
 const seenKeys = new Set();
 for (const art of document.querySelectorAll('article, div[role="article"]')) {
   if (isNested(art)) continue;
   const lab = art.getAttribute('aria-label') || '';
   if (/^\s*(Comment|Reply) by /i.test(lab)) continue;
   const text = (art.innerText || '');
   if (/^\s*Loading\.\.\./.test(text)) continue;
   const url = barePostLink(art);
   const cc = commentCount(art);
   const btn = url ? null : commentButton(art);
   if (!url && !btn) continue;
   const name = authorName(art);
   const key = entryKey(name, cc, text);
   if (url) {
     if (seen.has(url)) continue;
     seen.add(url);
   } else {
     if (seenKeys.has(key)) continue;
     seenKeys.add(key);
   }
   out.push({post_url: url, author_name: name, comment_count: cc, has_comment_button: !!btn, key: key});
 }
 /* document-wide fallback: the live group feed does not always wrap a
    post in its own article, so also take every post permalink on the
    page that is NOT a comment link (no comment_id) - keeps the
    /groups/<id>/ prefix so the URL opens the right post. */
 const doneIds = new Set();
 for (const o of out) {
   const mm = (o.post_url || '').match(/(\d+)\/?$/);
   if (mm) doneIds.add(mm[1]);
 }
 for (const a of document.querySelectorAll('a[href]')) {
   const h = a.getAttribute('href') || '';
   if (/[?&](reply_)?comment_id=/.test(h)) continue;
   const m = h.match(/\/(permalink|posts)\/(\d+)/);
   if (!m || doneIds.has(m[2])) continue;
   doneIds.add(m[2]);
   const g = h.match(/\/groups\/([^\/?#]+)\/(permalink|posts)\/(\d+)/);
   const url = g ? 'https://www.facebook.com/groups/' + g[1] + '/' + g[2] + '/' + g[3] + '/'
                 : 'https://www.facebook.com/' + m[1] + '/' + m[2] + '/';
   out.push({post_url: url, author_name: '', comment_count: null, has_comment_button: false, key: url});
 }
 return out;
}"""

# JS: one diagnostic pass over the feed when a scrape finds 0 new
# posts — how many article-ish elements exist, in which form, how
# many are top-level / headed / linkable / openable, plus the first
# 3 top-level NON-COMMENT articles in full detail (aria-label,
# 300-char text head, first 5 hrefs, all descendant aria-labels
# containing "comment") so the next 0-found run names exactly what
# the page contained and whether the new post identification fits
# it. Test doubles return their canned data when they see
# "feed-diag".
_FEED_DIAG_JS = r"""() => {
 /* feed-diag */
 function hasBarePermalink(el) {
   const links = el.querySelectorAll('a[href]');
   for (const a of links) {
     const h = a.getAttribute('href') || '';
     if (/\/(permalink|posts)\/\d+/.test(h) && !/[?&]comment_id=/.test(h)) return true;
   }
   return false;
 }
 function hasAnyPermalink(el) {
   const links = el.querySelectorAll('a[href]');
   for (const a of links) {
     const h = a.getAttribute('href') || '';
     if (/\/(permalink|posts)\/\d+/.test(h)) return true;
   }
   return false;
 }
 function hasHeading(art) {
   const lab = art.getAttribute('aria-label') || '';
   if (/^\s*(.+?)'s post\b/i.test(lab)) return true;
   return /^\s*(.+?)'s post\b/m.test(art.innerText || '');
 }
 function hasCommentButton(art) {
   for (const el of art.querySelectorAll('[aria-label]')) {
     if (/Comment on (.+?)'s post,\s*\d[\d.,]*\s*[KM]?\s+comments?/i.test(el.getAttribute('aria-label') || '')) return true;
   }
   return false;
 }
 function commentLabels(art) {
   const out = [];
   for (const el of art.querySelectorAll('[aria-label]')) {
     const l = el.getAttribute('aria-label') || '';
     if (/comment/i.test(l)) out.push(l.slice(0, 120));
   }
   return out.slice(0, 5);
 }
 function firstHrefs(el) {
   const out = [];
   const links = el.querySelectorAll('a[href]');
   for (const a of links) {
     out.push((a.getAttribute('href') || '').slice(0, 120));
     if (out.length >= 5) break;
   }
   return out;
 }
 function isNested(art) {
   let anc = art.parentElement;
   while (anc) {
     if (anc.tagName === 'ARTICLE') return true;
     if (anc.getAttribute && anc.getAttribute('role') === 'article') return true;
     anc = anc.parentElement;
   }
   return false;
 }
 function isComment(art) {
   return /^\s*(Comment|Reply) by /i.test(art.getAttribute('aria-label') || '');
 }
 const els = document.querySelectorAll('article, div[role="article"]');
 let articleTags = 0, roleArticles = 0, topLevel = 0, nested = 0;
 let withHeading = 0, withPermalink = 0, withCommentButton = 0;
 let nonCommentTop = 0, withBarePermalink = 0, withCommentLabel = 0;
 const samples = [];
 for (const art of els) {
   if (art.tagName === 'ARTICLE') articleTags++;
   if (art.getAttribute && art.getAttribute('role') === 'article') roleArticles++;
   const nest = isNested(art);
   if (nest) nested++; else topLevel++;
   const h = hasHeading(art);
   const p = hasAnyPermalink(art);
   const c = hasCommentButton(art);
   if (h) withHeading++;
   if (p) withPermalink++;
   if (c) withCommentButton++;
   // "Loading..." placeholders are top-level non-comment elements
   // but not candidate posts — they must not inflate the count
   // or take a sample slot.
   const loading = /^\s*Loading\.\.\./.test(art.innerText || '');
   if (!nest && !isComment(art) && !loading) {
     nonCommentTop++;
     if (hasBarePermalink(art)) withBarePermalink++;
     const cls = commentLabels(art);
     if (cls.length) withCommentLabel++;
     if (samples.length < 3) {
       samples.push({
         aria_label: (art.getAttribute('aria-label') || '').slice(0, 120),
         text_head: (art.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
         hrefs: firstHrefs(art),
         comment_labels: cls,
         has_bare_permalink: hasBarePermalink(art),
         has_permalink: p,
         has_comment_button: c,
       });
     }
   }
 }
 let docPostLinks = 0, docCommentIdLinks = 0; const docLinkSamples = [];
 for (const a of document.querySelectorAll('a[href]')) {
   const h = a.getAttribute('href') || '';
   if (!/\/(permalink|posts)\/\d+/.test(h)) continue;
   if (/[?&](reply_)?comment_id=/.test(h)) { docCommentIdLinks++; continue; }
   docPostLinks++;
   if (docLinkSamples.length < 3) docLinkSamples.push(h.slice(0, 120));
 }
 let docCommentLabels = 0; const docLabelSamples = [];
 for (const el of document.querySelectorAll('[aria-label]')) {
   const l = el.getAttribute('aria-label') || '';
   if (!/comment/i.test(l) || /^\s*(Comment|Reply) by /i.test(l)) continue;
   docCommentLabels++;
   if (docLabelSamples.length < 5) docLabelSamples.push(((el.tagName || '') + '|' + (el.getAttribute('role') || '') + '|' + l).slice(0, 120));
 }
 return {doc_post_links: docPostLinks, doc_comment_id_links: docCommentIdLinks, doc_link_samples: docLinkSamples, doc_comment_labels: docCommentLabels, doc_label_samples: docLabelSamples, total: els.length, article_tags: articleTags, role_articles: roleArticles, top_level: topLevel, nested: nested, non_comment_top: nonCommentTop, with_heading: withHeading, with_permalink: withPermalink, with_bare_permalink: withBarePermalink, with_comment_button: withCommentButton, with_comment_label: withCommentLabel, samples: samples};
}"""

# JS: open one feed post by clicking its comment button — the path
# for posts with no /permalink/ or /posts/ link (e.g. photo posts).
# Takes the entry key from _FEED_POSTS_JS (author + comment count +
# text head); finds the matching top-level article, scrolls it into
# view and clicks its Comment button, which opens the post as a
# dialog. The button is found the same broad way as in
# _FEED_POSTS_JS (any descendant whose aria-label contains
# "comment", preferring a real button; the "Comment as ..." composer
# is never a button). Returns true when a button was clicked.
# Test doubles return their canned result when they see
# "open-feed-post".
_OPEN_FEED_POST_JS = r"""(key) => {
 /* open-feed-post */
 function toNum(s) {
   const m = /(\d[\d.,]*)\s*([KM])?/i.exec(s || '');
   if (!m) return null;
   if (m[2]) return Math.round(parseFloat(m[1].replace(/,/g, '')) * (m[2].toUpperCase() === 'K' ? 1e3 : 1e6));
   return parseInt(m[1].replace(/[.,]/g, ''), 10);
 }
 function collapseDoubled(name) {
   const n = (name || '').trim();
   const m = n.match(/^(.+?)\s+\1$/);
   return m ? m[1].trim() : n;
 }
 function authorName(art) {
   const lab = (art.getAttribute('aria-label') || '').trim();
   if (lab && !/^\s*(Comment|Reply) by /i.test(lab)) return collapseDoubled(lab);
   const lines = (art.innerText || '').split('\n');
   for (const line of lines) {
     const t = line.trim();
     if (t) return collapseDoubled(t);
   }
   return '';
 }
 function commentCount(art) {
   for (const el of art.querySelectorAll('[aria-label]')) {
     const l = el.getAttribute('aria-label') || '';
     if (!/comment/i.test(l)) continue;
     let m = l.match(/(\d[\d.,]*\s*[KM]?)\s*comments?/i);
     if (m) return toNum(m[1]);
     const t = (el.innerText || '').trim();
     if (t.length <= 12) {
       m = t.match(/^(\d[\d.,]*\s*[KM]?)$/);
       if (m) return toNum(m[1]);
     }
   }
   return null;
 }
 function commentButton(art) {
   let fallback = null;
   for (const el of art.querySelectorAll('[aria-label]')) {
     const l = el.getAttribute('aria-label') || '';
     if (!/comment/i.test(l)) continue;
     const tag = (el.tagName || '').toUpperCase();
     const role = (el.getAttribute('role') || '').toLowerCase();
     if (tag === 'INPUT' || tag === 'TEXTAREA' || role === 'textbox') continue;
     if (!fallback) fallback = el;
     if (tag === 'BUTTON' || role === 'button' || /^comment$/i.test(l.trim())) return el;
   }
   return fallback;
 }
 function entryKey(name, cc, text) {
   const head = (text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
   return name + '|' + (cc === null || cc === undefined ? '' : cc) + '|' + head;
 }
 function isNested(art) {
   let anc = art.parentElement;
   while (anc) {
     if (anc.tagName === 'ARTICLE') return true;
     if (anc.getAttribute && anc.getAttribute('role') === 'article') return true;
     anc = anc.parentElement;
   }
   return false;
 }
 for (const art of document.querySelectorAll('article, div[role="article"]')) {
   if (isNested(art)) continue;
   const lab = art.getAttribute('aria-label') || '';
   if (/^\s*(Comment|Reply) by /i.test(lab)) continue;
   const text = (art.innerText || '');
   if (/^\s*Loading\.\.\./.test(text)) continue;
   const name = authorName(art);
   const cc = commentCount(art);
   const btn = commentButton(art);
   if (!btn) continue;
   if (entryKey(name, cc, text) !== key) continue;
   try { art.scrollIntoView({block: 'center'}); } catch (e) {}
   try { btn.click(); return true; } catch (e) { return false; }
 }
 return false;
}"""

# JS: close the single-post dialog (its Close button, else Escape).
# Returns true when no dialog remains. Test doubles return their
# canned result when they see "close-dialog".
_CLOSE_DIALOG_JS = r"""() => {
 /* close-dialog */
 const dlg = document.querySelector('div[role="dialog"]');
 if (!dlg) return true;
 const btn = dlg.querySelector('[aria-label="Close"]');
 if (btn) {
   try { btn.click(); } catch (e) {}
 } else {
   try { document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})); } catch (e) {}
   try { document.dispatchEvent(new KeyboardEvent('keyup', {key: 'Escape', bubbles: true})); } catch (e) {}
 }
 return !document.querySelector('div[role="dialog"]');
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

# JS: how many article-ish elements are currently in the DOM —
# literal <article> tags AND div[role="article"] (the live feed
# uses literal <article> tags; the dialog's comments use the role
# form). Used to wait for the feed to actually render before the
# first extraction. Test doubles return their canned count when
# they see "article-count".
_ARTICLE_COUNT_JS = r"""() => {
 /* article-count */
 try { return document.querySelectorAll('article, div[role="article"]').length; }
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


# ----------------------------------------------------------------------
# Ported from ~/workspace/client-hunting/app/facebook.py (the tested
# sources finder). These helpers + methods are VERBATIM copies of the
# proven code — do not "improve" them without a live reason. They
# power keyword search, the comments gate, join/leave and the member
# count used by the collect-sources job (see jobs.py).
# ----------------------------------------------------------------------

# URL path segments that are never a person/page profile.
_NAV_PATHS = {
    "search",
    "groups",
    "pages",
    "events",
    "marketplace",
    "watch",
    "login",
    "settings",
    "notifications",
    "messages",
    "friends",
    "photos",
    "videos",
    "reels",
    "reel",
    "video",
    "photo",
    "story",
    "gaming",
    "fundraisers",
    "saved",
    "bookmarks",
    "home",
    "privacy",
    "help",
    "about",
    "ads",
    "business",
    "developers",
    "policies",
    "dialog",
    "plugins",
    "sharer",
    "tr",
    "campaign",
    "boost",
    "live",
    "stories",
    "groups_feed",
    "profile.php",
    # Facebook internal product pages — these appear as links in group
    # and page chrome (e.g. "Creator Dashboard" in a group header) and
    # must NEVER become a lead. A real person is never named after one
    # of these; a false lead here destroys trust in Step 1 quality.
    "professional_dashboard",
    "professional",
    "creator_studio",
    "monetization",
    "creator",
    "creators",
    "insights",
    "publishing_tools",
    "ads_manager",
    "business_suite",
    "meta_business_suite",
    "commerce_manager",
    "creator_support",
    "support_inbox",
    "activity_log",
    "memories",
    "feeds",
    "explore",
    "discover",
    "jobs",
    "offers",
    "services",
    "notes",
    "weather",
    "birthdays",
    "subscriptions",
    "payments",
    "orders",
    "apps",
    "games",
    "instant_games",
    "shows",
    "places",
    "local",
    "community",
    "support",
    "directory",
    "nearby",
    "meta",
    "ai",
}

_FILE_EXT_RE = re.compile(
    r"\.(jpg|jpeg|png|gif|webp|svg|html|htm|php|pdf|mp4|css|js|json|ico)(\?|#|$)", re.I
)


def _clean_text(text: str, limit: int = 200) -> str:
    """Collapse whitespace and truncate a snippet for logging."""
    return re.sub(r"\s+", " ", text or "").strip()[:limit]


def _same_url(a: str, b: str) -> bool:
    """Same Facebook page, ignoring scheme/host case, a trailing
    slash and any query/fragment — a feed already open at the
    target URL must not be reloaded (a same-URL reload of a heavy
    feed is slow and can time out even with the goto retry)."""

    def norm(u):
        try:
            p = urlparse((u or "").strip())
            return (p.scheme.lower(), p.netloc.lower(), (p.path.rstrip("/") or "/"))
        except Exception:
            return ("", "", (u or "").strip().rstrip("/"))

    return bool(a and b) and norm(a) == norm(b)


# ----------------------------------------------------------------------
# Member counts
# ----------------------------------------------------------------------

_MEMBER_COUNT_RE = re.compile(
    r"(\d[\d,]*\.?\d*)\s*([KMkm]?)\s*(members?|followers?)", re.I
)


def _parse_member_count(text: str) -> int | None:
    """Parse a member/follower count from nearby text, or None.

    Handles "12K members" (12000), "1,234 members" (1234),
    "5.2K followers" (5200), "10k followers" (10000) and
    "1.2M members" (1200000). Returns None when no count pattern
    matches — a missing count must never block a run.
    """
    if not text:
        return None
    try:
        m = _MEMBER_COUNT_RE.search(str(text))
        if not m:
            return None
        num = float(m.group(1).replace(",", ""))
        suffix = (m.group(2) or "").upper()
        if suffix == "K":
            num *= 1_000
        elif suffix == "M":
            num *= 1_000_000
        return int(num)
    except Exception:
        return None


def _clean_title(title: str) -> str:
    """Strip a trailing ' | Facebook' suffix from a page title."""
    title = _clean_text(title or "", 120)
    title = re.sub(r"\s*\|\s*Facebook\s*$", "", title, flags=re.I).strip()
    return title


# JS: walk an anchor's ancestors (bounded) to the nearest container
# whose text is longer than the link text. Prefers a [role="article"]
# or comment-like container; falls back to the first longer ancestor.
_COMMENT_JS = (
    "(el) => {"
    " if (!el) return '';"
    " const linkText = (el.innerText || '').trim();"
    " let node = el.parentElement; let fallback = '';"
    " for (let i = 0; i < 10 && node; i++) {"
    "   const t = (node.innerText || '').trim();"
    "   if (t && t.length > linkText.length + 10) {"
    "     if (!fallback) fallback = t;"
    "     const role = node.getAttribute ? node.getAttribute('role') : null;"
    "     const html = (node.outerHTML || '').slice(0, 2000);"
    "     if (role === 'article' || /comment/i.test(html)) return t.slice(0, 500);"
    "   }"
    "   node = node.parentElement;"
    " }"
    " return fallback.slice(0, 500);"
    "}"
)

# JS: same ancestor walk, but any longer container counts (used for the
# member/follower count printed near a group/page result card).
_NEARBY_JS = (
    "(el) => {"
    " if (!el) return '';"
    " const linkText = (el.innerText || '').trim();"
    " let node = el.parentElement;"
    " for (let i = 0; i < 10 && node; i++) {"
    "   const t = (node.innerText || '').trim();"
    "   if (t && t.length > linkText.length + 10) return t.slice(0, 1000);"
    "   node = node.parentElement;"
    " }"
    " return '';"
    "}"
)

# JS: count posts + comments straight from the Comment buttons'
# aria-labels ("Comment on X's post, 223 comments"). One button = one
# post, the sum = the total. In the group feed the posts are NOT
# div[role="article"] (those are the comments themselves), so article
# iteration finds no posts at all — the button count IS the post
# count. Test doubles return their canned data when they see
# "gate-count".
_GATE_COUNT_JS = (
    "() => {"
    " /* gate-count */"
    " const RE = /(\\d[\\d.,]*\\s*[KM]?)\\s+comments?\\b/i;"
    " const toNum = s => {"
    "   const m = /(\\d[\\d.,]*)\\s*([KM])?/i.exec(s || '');"
    "   if (!m) return 0;"
    "   if (m[2]) return Math.round(parseFloat(m[1].replace(/,/g, '')) * (m[2].toUpperCase() === 'K' ? 1e3 : 1e6));"
    "   return parseInt(m[1].replace(/[.,]/g, ''), 10);"
    " };"
    " let posts = 0, total = 0, active = 0; const seen = new Set();"
    " for (const el of document.querySelectorAll('[aria-label]')) {"
    "   const lab = el.getAttribute('aria-label') || '';"
    "   const m = RE.exec(lab);"
    "   if (m && !seen.has(el)) { seen.add(el); posts++; const n = toNum(m[1]); total += n; if (n > 0) active++; }"
    " }"
    " return {posts: posts, comments: total, active: active};"
    "}"
)

# JS: are "Loading..." placeholders still present in the feed?
# Facebook lazy-loads the group feed — only ~1 post is on the
# first screen and more arrive as you scroll, with empty
# "Loading..." placeholder articles in between. A gate count taken
# while placeholders remain undercounts. Test doubles return their
# canned data when they see "feed-loading".
_FEED_LOADING_JS = (
    "() => {"
    " /* feed-loading */"
    " const arts = document.querySelectorAll('article, [role=\"article\"]');"
    " for (const a of arts) {"
    "   const t = (a.innerText || '').trim();"
    "   if (t === 'Loading...' || t.indexOf('Loading...') === 0) return {loading: true};"
    " }"
    " return {loading: false};"
    "}"
)

# JS: diagnostic for the comment-count check — how many [aria-label]
# elements exist inside feed articles, how many carry a comment total
# ("142 comments"), and how many look like the Comment action button
# (label contains "comment" but is not a "view more" link) with a
# number in their visible text. This tells us, on a live run, which
# signal the count parsing can actually see. Test doubles return None
# for unknown JS, so the diagnostic is zeros there.
_DIAG_ARIA_JS = (
    "() => {"
    " /* diag-aria */"
    " let total = 0, matched = 0, btns = 0, btnNums = 0; const samples = [];"
    " const articles = document.querySelectorAll('div[role=\"article\"]');"
    " for (const art of articles) {"
    "   const labelled = art.querySelectorAll('[aria-label]');"
    "   for (const el of labelled) {"
    "     total++;"
    "     const lab = (el.getAttribute('aria-label') || '').trim();"
    "     if (/([\\d,]+)\\s+comments?/i.test(lab)) {"
    "       matched++;"
    "       if (samples.length < 3) samples.push(lab.slice(0, 80));"
    "     }"
    "     if (/comment/i.test(lab) && !/view more/i.test(lab) && !/view previous/i.test(lab) && !/replies/i.test(lab)) {"
    "       btns++;"
    "       const t = (el.innerText || '').trim();"
    "       if (/[\\d,]+/.test(t)) { btnNums++; if (samples.length < 3) samples.push('btn:' + t.slice(0, 40)); }"
    "     }"
    "   }"
    " }"
    " const parentBtns = [];"
    " const first = articles[0];"
    " if (first && first.parentElement) {"
    "   const pbtns = first.parentElement.querySelectorAll('[role=\"button\"]');"
    "   for (const b of pbtns) {"
    "     if (parentBtns.length >= 8) break;"
    "     parentBtns.push(((b.getAttribute('aria-label') || '') + ' | ' + (b.textContent || '').trim()).slice(0, 80));"
    "   }"
    " }"
    " return {total: total, matched: matched, btns: btns, btnNums: btnNums, samples: samples, parentBtns: parentBtns};"
    "}"
)

# JS: read one Messenger thread's messages. Marker "chat-thread-messages".
# Returns [{text, side}] in DOM order (consecutive duplicates collapsed,
# like client-hunting's read_thread). Side is a bounding-rect heuristic:
# my bubbles sit on the right half of the message list, theirs on the
# left. When the rect cannot be read the side is "unknown" and the
# Python side falls back to comparing text against the agent's own sent
# texts. Test doubles return canned data when they see the marker.
_THREAD_MESSAGES_JS = r"""() => {
 /* chat-thread-messages */
 const box = document.querySelector('div[contenteditable="true"]'); let list = box; while (list && (list.getBoundingClientRect().width < 450 || list.getBoundingClientRect().height < 300)) list = list.parentElement; if (!box) return []; list = list || document.body;
 const rect = list.getBoundingClientRect();
 const bb = box ? box.getBoundingClientRect() : rect; const cl = bb.left - 160, cr = bb.right + 45; const mid = (cl + cr) / 2;
 const out = [];
 const nodes = document.querySelectorAll('[dir="auto"]');
 let prev = null;
 for (const n of nodes) {
   const t = (n.innerText || '').trim();
   if (!t || t === prev || /^(messenger|enter|active now|active today|seen|sent|delivered|today|yesterday|you sent|\d{1,2}:\d{2}\s?(am|pm)?)$/i.test(t)) continue;
   prev = t; try { const q = n.getBoundingClientRect(); const bt = box ? box.getBoundingClientRect().top : 99999; if (q.top < 130 || q.left < cl || q.right > cr || q.top > bt || Math.abs((q.left + q.right) / 2 - mid) < 20 || /end-to-end|secured with/i.test(t)) continue; } catch (e) {}
   let side = 'unknown';
   try {
     const r = n.getBoundingClientRect();
     if (r && r.width) side = (r.left + r.width / 2) > mid ? 'me' : 'them';
   } catch (e) {}
   out.push({text: t, side: side});
 }
 return out;
}"""


def _comment_text_for(page, anchor) -> str:
    """Comment text the anchor belongs to, or "".

    Test doubles can supply it directly via a ``comment_text``
    attribute on the anchor; otherwise the ancestor walk above runs
    through ``page.evaluate``. Never raises.
    """
    try:
        supplied = getattr(anchor, "comment_text", None)
        if isinstance(supplied, str) and supplied.strip():
            return _clean_text(supplied, 500)
    except Exception:
        pass
    try:
        text = page.evaluate(_COMMENT_JS, anchor)
    except Exception:
        return ""
    try:
        return _clean_text(text or "", 500)
    except Exception:
        return ""


def _nearby_text_for(page, anchor) -> str:
    """Text of the nearest ancestor container holding the anchor.

    Test doubles can supply it via a ``nearby_text`` (or
    ``member_count_text``) attribute; otherwise the ancestor walk
    above runs through ``page.evaluate``. Never raises.
    """
    try:
        for attr in ("member_count_text", "nearby_text"):
            supplied = getattr(anchor, attr, None)
            if isinstance(supplied, str) and supplied.strip():
                return _clean_text(supplied, 1000)
    except Exception:
        pass
    try:
        text = page.evaluate(_NEARBY_JS, anchor)
    except Exception:
        return ""
    try:
        return _clean_text(text or "", 1000)
    except Exception:
        return ""


def _found_via_for_label(label: str) -> str:
    """found_via for a _collect_from_links label.

    "comment" when the label is a comments source (group_comments /
    page_comments); "search" for search results and friend lists
    (both are search-style discovery, not a comment).
    """
    label = (label or "").lower()
    if "comment" in label:
        return "comment"
    return "search"


def _activity(ctx: dict | None, kind: str, msg: str) -> None:
    try:
        fn = (ctx or {}).get("activity")
        if callable(fn):
            fn(kind, msg)
    except Exception:
        pass


def _blocked(ctx: dict | None, reason: str) -> None:
    try:
        fn = (ctx or {}).get("blocked")
        if callable(fn):
            fn(reason)
    except Exception:
        pass


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


def _stage(ctx: dict | None, stage: str, detail: str = "") -> None:
    """Report a send step (first-message send only).

    The callback lives on ctx["stage"] when the caller wants it
    (chat.start_chat sets one); every other caller — the watcher
    included — has none, so this is a silent no-op for them. Never
    raises, never changes the send.
    """
    try:
        fn = (ctx or {}).get("stage")
        if callable(fn):
            fn(stage, detail)
    except Exception:
        pass


class FacebookWorker:
    """Facebook browsing worker. Methods take a live ``page`` + ``ctx``."""

    key = "facebook"
    display_name = "Facebook"
    base_url = "https://www.facebook.com"
    login_url = "https://www.facebook.com/login"
    home_url = "https://www.facebook.com"

    # Selectors that prove a signed-in top bar. One list for both
    # check_session and the retry diagnostic below, so the
    # diagnostic can never report different selectors than the
    # check itself uses. (label, selector) pairs.
    _LOGGED_IN_SELECTORS = (
        ("Your profile", 'a[aria-label="Your profile"]'),
        ("Account", 'a[aria-label="Account"]'),
        ("/me/", 'a[href="/me/"]'),
        ("Messenger", '[aria-label="Messenger"]'),
    )

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
            title = page.title() or ""
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
        for _label, selector in self._LOGGED_IN_SELECTORS:
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

    def check_session_with_retry(
        self, page: Page, ctx: dict | None = None, retries: int = 3, delay: float = 0.5
    ) -> str:
        """Re-check the session, retrying ONLY a transient "empty".

        Gemini's diagnosis of the live second-press failure: on the
        second Scrap the check runs immediately on the already-open
        page, and if Facebook's SPA is mid re-hydration / feed
        update at that instant, every read momentarily returns
        empty or throws — a false-positive "empty". A non-empty
        state (ok / logged_out / checkpoint / blocked) is a real
        answer and returns at once, with no extra attempts. When
        the page stays "empty" after all retries, one diagnostic
        note names what the page actually looked like. Never
        raises.
        """
        attempts = max(1, retries)
        state = "empty"
        for attempt in range(attempts):
            try:
                state = self.check_session(page, ctx)
            except Exception:
                state = "empty"
            if state != "empty":
                return state
            if attempt < attempts - 1:
                try:
                    time.sleep(delay)
                except Exception:
                    pass
        self._note_session_empty(page, ctx, attempts)
        return "empty"

    def session_diagnostic(self, page: Page) -> dict:
        """Structured detail for a session check: URL, title, body
        length, link count, and each logged-in selector's count
        ("error" when the read itself threw, -1 when the body/link
        read threw). Never raises — a diagnostic must not fail the
        check it explains. Used by the Agent Control page and by
        _note_session_empty (same reads, one place)."""
        try:
            url = page.url or "?"
        except Exception:
            url = "?"
        try:
            title = (page.title() or "")[:80]
        except Exception:
            title = "?"
        try:
            body_len = len(page.inner_text("body") or "")
        except Exception:
            body_len = -1
        try:
            links_count = len(page.query_selector_all("a[href]") or [])
        except Exception:
            links_count = -1
        selectors: dict[str, int | str] = {}
        for label, selector in self._LOGGED_IN_SELECTORS:
            try:
                selectors[label] = page.locator(selector).count()
            except Exception:
                selectors[label] = "error"
        return {
            "url": url,
            "title": title,
            "body_len": body_len,
            "links_count": links_count,
            "selectors": selectors,
        }

    def _note_session_empty(self, page: Page, ctx: dict | None, attempts: int) -> None:
        """Note what the page actually looked like when the session
        check stayed "empty" after all retries: URL, title, body
        length, link count, and each logged-in selector's count
        ("error" when the read itself threw, -1 when the body /
        link read threw). Never raises — a diagnostic must not
        fail the job it explains.
        """
        try:
            d = self.session_diagnostic(page)
            parts = [f"{label}={count}" for label, count in d["selectors"].items()]
            _note(
                ctx,
                f"session check empty after {attempts} attempts: "
                f"url={d['url']}, title={d['title']!r}, body_len={d['body_len']}, "
                f"links_count={d['links_count']}, "
                f"selectors={{{', '.join(parts)}}}",
            )
        except Exception:
            pass

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

    def search_url(self, keyword: str, kind: str = "groups") -> str:
        """Facebook search URL for ``keyword`` ("groups" or "pages").

        Single place that builds the search URL, so the session
        check and the search itself can never disagree about it.
        """
        return f"{self.base_url}/search/{kind}?q={quote(keyword)}"

    def verify_session(
        self, page: Page, ctx: dict | None, target_url: str | None = None
    ) -> str:
        """Classify the session, returning 'ok' when it is alive.
        Callers must STOP the job on any non-ok state. Never raises.

        The Facebook home page is NEVER used as the session gate:
        home hangs in this Chromium, so a home load cannot tell a
        live session from a dead one. The check is, in order:
        (0) one bounded readiness wait, so a mid-render page (still
            loading feed content after the previous run's scrolling)
            is not misread as "empty";
        (1) the page the browser is already on — a loaded,
            signed-in group/feed page proves the session with no
            navigation at all. The check retries briefly when it
            reads "empty", so a transient SPA teardown (the live
            second-press failure) does not fail the job;
        (2) the job's own target page (the source's group/page URL
            for scrape/sync, the search URL for collect) — if it
            loads with a live session the job is already where it
            needs to be, so the page is left there for the job's
            own load to reuse. When the browser is ALREADY on the
            target URL the reload is skipped entirely: a same-URL
            reload of a heavy Facebook feed is slow (domcontentloaded
            can exceed the 20s timeout even with the retry) and is
            pure cost when the page is already there. The re-check
            on the already-open target retries "empty" the same way;
        (3) otherwise the actual detected state (logged_out /
            checkpoint / blocked / empty) — an unloaded page is
            reported as "empty", never as "not signed in". On
            failure the path taken is noted AND stored on the
            worker as last_session_path (current URL + state,
            whether the target navigation was skipped or attempted
            and failed) so the job error in the app names the exact
            step that broke — the agent console alone is not
            visible to the user.
        """
        target = (target_url or "").strip()
        target_nav = "no target"
        # The failure path of THIS check only — cleared first so a
        # previous job's failure can never leak into the next one.
        self.last_session_path = None
        try:
            self._wait_ready(page, ctx)
        except Exception:
            pass
        try:
            current_url = page.url or ""
        except Exception:
            current_url = ""
        try:
            state = self.check_session_with_retry(page, ctx)
        except Exception:
            state = "empty"
        if state == "ok":
            return "ok"
        if target:
            if _same_url(current_url, target):
                # Already on the target: wait for it to settle and
                # check as-is — never reload it.
                target_nav = "skipped (already on target)"
                try:
                    self._wait_ready(page, ctx)
                except Exception:
                    pass
                try:
                    state = self.check_session_with_retry(page, ctx)
                except Exception:
                    state = "empty"
                if state == "empty":
                    # The page we are sitting on is dead/hung (typical
                    # after a long scrolled feed). Do NOT give up:
                    # drop it to a blank page and load the target
                    # fresh, then check again.
                    target_nav = "skipped (already on target), reloaded"
                    try:
                        try:
                            page.goto("about:blank", timeout=15000)
                        except Exception:
                            pass
                        if self._goto(
                            page, target, ctx, "session_recover", timeout_ms=45000
                        ):
                            if not self._wait_ready(page, ctx):
                                self._wait_ready(page, ctx)
                            state = self.check_session_with_retry(page, ctx)
                        else:
                            state = "empty"
                            target_nav += " (goto failed)"
                    except Exception as exc:  # noqa: BLE001
                        _note(ctx, f"session recover failed: {exc}")
                        state = "empty"
            else:
                target_nav = "attempted"
                try:
                    if self._goto(
                        page, target, ctx, "session_target", timeout_ms=45000
                    ):
                        if not self._wait_ready(page, ctx):
                            # Slow SPA load: one more bounded readiness
                            # wait before calling the page empty.
                            self._wait_ready(page, ctx)
                        state = self.check_session(page, ctx)
                    else:
                        state = "empty"
                        target_nav = "attempted, goto failed"
                except Exception as exc:  # noqa: BLE001 - never raise
                    _note(ctx, f"session check failed: {exc}")
                    state = "empty"
                    target_nav = "attempted, raised"
        if state != "ok":
            # The path is stored on the worker as well as noted: the
            # agent console is not visible to the user, so jobs.py
            # appends last_session_path to the job's stored error
            # and the app UI shows the exact step that broke.
            self.last_session_path = (
                f"session check: state={state}, "
                f"current_url={current_url or '?'}, "
                f"target_nav={target_nav}"
            )
            _note(
                ctx,
                f"session check failed: state={state} "
                f"current_url={current_url or '?'} "
                f"target={target or 'none'} target_nav={target_nav}",
            )
            if state == "empty":
                _note(
                    ctx,
                    "Facebook session state: empty — the target "
                    "page did not load; the browser may still "
                    "be signed in.",
                )
            else:
                _note(
                    ctx,
                    f"Facebook session state: {state} — sign in to "
                    "Facebook in the agent Chrome window.",
                )
        return state

    # ------------------------------------------------------------------
    # Page loading
    # ------------------------------------------------------------------
    def _goto(
        self,
        page: Page,
        url: str,
        ctx: dict | None,
        label: str,
        timeout_ms: int = 20000,
    ) -> bool:
        """Goto with an explicit timeout + ONE retry on failure.
        Returns True when the navigation completed. Never raises."""
        for attempt in (1, 2):
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
                return True
            except Exception as exc:  # noqa: BLE001 - retry once, then give up
                # A heavy Facebook page often hits the domcontentloaded
                # timeout although the navigation already happened and
                # the page is usable. Treat that as loaded - the
                # readiness / session checks decide if it is really OK.
                try:
                    if _same_url(page.url, url):
                        _note(
                            ctx,
                            f"goto {label} timed out but the page "
                            f"is already on the target - continuing",
                        )
                        return True
                except Exception:
                    pass
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

    def _wait_ready(
        self, page: Page, ctx: dict | None, timeout_s: float = 10.0, poll_ms: int = 500
    ) -> bool:
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

    def _load(
        self,
        page: Page,
        url: str,
        ctx: dict | None,
        label: str,
        timeout_ms: int = 20000,
    ) -> bool:
        """Load a page: pace, goto+retry, readiness wait, session check.
        Returns True only when the page loaded with a live session.
        On a dead session returns False (noted once) — the caller must
        stop. Never raises."""
        _pace(ctx)
        if not self._goto(page, url, ctx, label, timeout_ms=timeout_ms):
            return False
        self._wait_ready(page, ctx)
        state = self.check_session_with_retry(page, ctx)
        if state != "ok":
            _note(ctx, f"session {state} on {label}")
            return False
        return True

    def _wait_for_articles(
        self, page: Page, ctx: dict | None, timeout_s: float = 20.0, poll_ms: int = 500
    ) -> int:
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

    def _feed_diagnostic(self, page: Page, ctx: dict | None = None):
        """One diagnostic pass over the feed when a scrape finds 0
        new posts: how many article-ish elements exist, in which
        form, how many are top-level / headed / linkable / openable
        — plus the first 3 top-level samples with which opening path
        each has. Noted to the job log and returned as text (None
        when the pass fails). Never raises."""
        try:
            diag = page.evaluate(_FEED_DIAG_JS) or {}
        except Exception:
            return None
        if not isinstance(diag, dict) or not diag:
            return None
        samples = []
        for s in (diag.get("samples") or [])[:3]:
            s = s or {}
            hrefs = s.get("hrefs") or []
            labels = s.get("comment_labels") or []
            parts = [
                f"\"{s.get('aria_label') or ''}\" ",
                f"\"{s.get('text_head') or ''}\" ",
                f"(bare permalink: "
                f"{'yes' if s.get('has_bare_permalink') else 'no'}, "
                f"comment button: "
                f"{'yes' if s.get('has_comment_button') else 'no'})",
            ]
            if hrefs:
                parts.append(f" hrefs: [{', '.join(hrefs)}]")
            if labels:
                parts.append(f" comment labels: [{', '.join(labels)}]")
            samples.append("".join(parts))
        text = (
            f"feed diagnostic: {diag.get('total') or 0} article-ish elements "
            f"({diag.get('article_tags') or 0} <article>, "
            f"{diag.get('role_articles') or 0} div[role=\"article\"]), "
            f"{diag.get('top_level') or 0} top-level, "
            f"{diag.get('non_comment_top') or 0} non-comment top-level, "
            f"{diag.get('with_heading') or 0} with \"<Name>'s post\" heading, "
            f"{diag.get('with_permalink') or 0} with permalink, "
            f"{diag.get('with_bare_permalink') or 0} with bare permalink, "
            f"{diag.get('with_comment_button') or 0} with comment button, "
            f"{diag.get('with_comment_label') or 0} with comment label; "
            f"document-wide: {diag.get('doc_post_links') or 0} post links, "
            f"{diag.get('doc_comment_id_links') or 0} comment links, "
            f"{diag.get('doc_comment_labels') or 0} comment labels "
            f"{diag.get('doc_label_samples') or []} "
            f"{diag.get('doc_link_samples') or []}"
            + (f"; samples: {'; '.join(samples)}" if samples else "")
        )
        _note(ctx, text)
        return text

    def _close_dialog(self, page: Page, ctx: dict | None = None) -> bool:
        """Close the single-post dialog (its Close button, else
        Escape) so the next post starts from a clean page. Returns
        True when no dialog remains. Never raises."""
        for _ in range(2):
            try:
                closed = page.evaluate(_CLOSE_DIALOG_JS)
            except Exception:
                return True
            if closed is not False:
                return True
            try:
                page.wait_for_timeout(500)
            except Exception:
                time.sleep(0.5)
        return False

    def _ensure_on_feed(
        self, page: Page, source_url: str, ctx: dict | None = None
    ) -> bool:
        """Make sure the browser is on the source feed: skip the
        reload when it is already there (a same-URL reload of a
        heavy feed is slow), else load it. Returns False when the
        feed did not load with a live session. Never raises."""
        try:
            if _same_url(page.url, source_url):
                self._wait_ready(page, ctx)
                if self.check_session_with_retry(page, ctx) == "ok":
                    return True
        except Exception:
            pass
        return self._load(page, source_url, ctx, "source", timeout_ms=45000)

    # ------------------------------------------------------------------
    # Feed collection + single-post extraction
    # ------------------------------------------------------------------
    def collect_feed_posts(
        self,
        page: Page,
        source_url: str,
        known_urls,
        limit: int,
        ctx: dict | None = None,
    ):
        """Collect NEW feed posts as entries {post_url|None,
        author_name, comment_count, has_comment_button, key}.

        Loads the feed, waits for articles, then rounds of
        _FEED_POSTS_JS + scroll. Stops at ``limit``, after a streak
        of 10 already-known URLs, or after 5 rounds that bring
        nothing new (Facebook loads lazily, so a few empty rounds
        are normal). A post with no /permalink/ or /posts/ link
        (e.g. a photo post) is kept when it has a comment button —
        it is opened via that button later. Returns (entries, diag):
        ``diag`` is the 0-found diagnostic text when nothing new
        was found, else None. Never raises.
        """
        known = set(known_urls or [])
        if not self._ensure_on_feed(page, source_url, ctx):
            return [], (
                "feed did not load - Facebook never showed the "
                "source page with a live session"
            )
        self._wait_for_articles(page, ctx, timeout_s=30.0)
        found: list = []
        seen = set(known)
        seen_keys = set()
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
                key = (row or {}).get("key") or ""
                if url:
                    if url in known:
                        known_streak += 1
                        if known_streak >= 10:
                            break
                        continue
                    if url in seen:
                        continue
                    seen.add(url)
                else:
                    if not (row or {}).get("has_comment_button"):
                        continue
                    if key and key in seen_keys:
                        continue
                    if key:
                        seen_keys.add(key)
                found.append(row)
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
        diag = None
        if not found:
            # Facebook empties posts that are scrolled far out of view.
            # Go back to the top, let them re-render, and look once more.
            try:
                page.evaluate("window.scrollTo(0, 0)")
            except Exception:
                pass
            try:
                page.wait_for_timeout(4000)
            except Exception:
                time.sleep(4)
            try:
                rows = page.evaluate(_FEED_POSTS_JS) or []
            except Exception:
                rows = []
            for row in rows or []:
                url = (row or {}).get("post_url")
                if url and url not in seen and url not in known:
                    seen.add(url)
                    found.append(row)
                    if len(found) >= limit:
                        break
        if not found:
            diag = self._feed_diagnostic(page, ctx)
        return found, diag

    def collect_feed_post_urls(
        self,
        page: Page,
        source_url: str,
        known_urls,
        limit: int,
        ctx: dict | None = None,
    ) -> list:
        """URLs of new feed posts (see collect_feed_posts). Kept for
        callers that only need links; posts without a permalink are
        dropped here — use collect_feed_posts to open those via
        their comment button. Never raises.
        """
        entries, _ = self.collect_feed_posts(page, source_url, known_urls, limit, ctx)
        return [e.get("post_url") for e in entries if e.get("post_url")]

    def _dialog_state(self, page: Page) -> dict:
        """Current dialog state via _DIALOG_STATE_JS, or {} when there
        is no dialog / the check fails. Never raises."""
        try:
            state = page.evaluate(_DIALOG_STATE_JS)
        except Exception:
            return {}
        return state if isinstance(state, dict) else {}

    def _scroll_dialog_until_loaded(self, page: Page, ctx: dict | None = None) -> dict:
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

    def _extract_dialog_contents(
        self, page: Page, ctx: dict | None = None, label: str = "post"
    ) -> dict | None:
        """Wait for the post dialog, then repeat scroll+expand
        cycles until a full pass adds nothing new: scroll the dialog
        until the stated comment total is loaded (or 5 no-new
        scrolls with no "Loading..." placeholders left), click every
        expand button until a pass clicks 0, then scroll again
        (expanding can trigger more loading). Only then is the post
        extracted. The returned dict carries ``comment_total`` (the
        post's stated total, or None) alongside the usual
        author/text/comments. Returns None when the dialog never
        appears. Never raises. The caller closes the dialog."""
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
            _note(ctx, f"post dialog never appeared: {label}")
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

    def extract_post(
        self, page: Page, post_url: str, ctx: dict | None = None
    ) -> dict | None:
        """Extract one post (with comments/replies) from its dialog —
        EXHAUSTIVELY. No comment or reply may be missed.

        Gotos the post URL, waits up to 20s for the dialog, then
        extracts via _extract_dialog_contents. The dialog is closed
        before returning so the next post starts from a clean page —
        a dialog left open is what left the second post stranded
        (its navigation then reported "page did not load").
        Returns None when the dialog never appears. Never raises.
        """
        if not self._goto(page, post_url, ctx, "post"):
            return None
        self._wait_ready(page, ctx)
        data = self._extract_dialog_contents(page, ctx, post_url)
        self._close_dialog(page, ctx)
        return data

    def extract_post_via_comment_button(
        self, page: Page, source_url: str, entry, ctx: dict | None = None
    ):
        """Open a feed post that has no permalink URL by clicking its
        comment button ("Comment on <Name>'s post, N comments") —
        the button opens the post as a dialog — then extract from
        the dialog with the same exhaustive code. The real post URL
        is read from the address bar once the dialog opens, and is
        used for dedupe/saving. Returns (post_url, data) or None
        when the post cannot be opened (noted, never raised — the
        job skips it and moves on to the next post). The dialog is
        closed before returning so the next post starts clean.
        """
        entry = entry or {}
        key = (entry.get("key") or "").strip()
        author = entry.get("author_name") or "post"
        if not key:
            _note(
                ctx, f"cannot open post by comment button " f"(no feed key): {author}"
            )
            return None
        if not self._ensure_on_feed(page, source_url, ctx):
            return None
        self._wait_for_articles(page, ctx)
        opened = False
        for _ in range(20):  # scroll the feed until the post is found
            if _should_stop(ctx):
                return None
            try:
                opened = bool(page.evaluate(_OPEN_FEED_POST_JS, key))
            except Exception:
                opened = False
            if opened:
                break
            try:
                page.evaluate("window.scrollBy(0, window.innerHeight)")
            except Exception:
                try:
                    page.mouse.wheel(0, 800)
                except Exception:
                    pass
            try:
                page.wait_for_timeout(1500)
            except Exception:
                time.sleep(1.5)
        if not opened:
            _note(
                ctx,
                f"could not open post by comment button "
                f"(not found in feed): {author}",
            )
            return None
        data = self._extract_dialog_contents(page, ctx, f"comment-button:{author}")
        try:
            post_url = (page.url or "").strip() or None
        except Exception:
            post_url = None
        self._close_dialog(page, ctx)
        if not data:
            return None
        if not post_url or _same_url(post_url, source_url):
            _note(
                ctx,
                f"post opened via comment button but no post "
                f"URL could be read: {author}",
            )
            return None
        return (post_url, data)

    # ------------------------------------------------------------------
    # Ported from client-hunting: block detection, page state, search,
    # comments gate, join / leave. Verbatim copies of the tested code.
    # ------------------------------------------------------------------
    # ------------------------------------------------------------------
    # Messenger (Inbox chat) — ported from client-hunting's proven
    # read_threads / read_thread / send_message (same selectors, same
    # reload-and-verify discipline). No official Messenger API exists
    # for personal profiles, so the agent drives the user's own
    # logged-in browser. A message counts as sent ONLY when it is
    # still present after a reload.
    # ------------------------------------------------------------------
    def open_chat_with_profile(
        self, page: Page, profile_url: str, ctx: dict | None
    ) -> tuple[str | None, str]:
        """Open a Messenger chat with a profile page.

        Goes to the profile, clicks its "Message" button, and returns
        the thread URL (``/messages/t/<id>``) — either from the page
        URL after navigation or from the chat tab's thread link.
        Returns (None, detail) when no chat opens: the profile may
        not accept messages from this account. Never raises.
        """
        if _should_stop(ctx):
            return None, "stopped"
        try:
            _pace(ctx)
            if not self._goto(page, profile_url, ctx, "open_chat"):
                return None, "profile page did not load"
            try:
                page.wait_for_timeout(2500)
            except Exception:
                time.sleep(2.5)
            if self._check_block(page, ctx):
                return None, "blocked"
            clicked = self._click_first_visible(
                page,
                (
                    'a[aria-label="Message"]',
                    'div[role="button"][aria-label="Message"]',
                    'button:has-text("Message")',
                    'div[role="button"]:has-text("Message")',
                ),
            )
            if not clicked:
                return None, "no Message button on this profile"
            try:
                page.wait_for_timeout(2500)
            except Exception:
                time.sleep(2.5)
            try:
                current = page.url or ""
            except Exception:
                current = ""
            m = re.search(r"/messages/t/(\d+)", current or "")
            if m:
                return f"{self.base_url}/messages/t/{m.group(1)}", "opened"
            for href, _text in self._links(page):
                m = re.search(r"/messages/(?:e2ee/)?t/(\d+)", href or "")
                if m:
                    return (
                        f"{self.base_url}/messages/t/{m.group(1)}",
                        "opened (chat tab)",
                    )
            # Facebook often opens a small docked chat and the URL does
            # not change. Fall back to the thread URL from the numeric id.
            user_id = self._profile_numeric_id(page, profile_url)
            if not user_id:
                _note(ctx, "open chat: no numeric id | " + self._page_state(page))
                return (
                    None,
                    "Message clicked but no chat thread opened (profile id not found)",
                )
            direct_url = f"{self.base_url}/messages/t/{user_id}"
            if not self._goto(page, direct_url, ctx, "open_chat_thread"):
                return None, "chat thread page did not load"
            for _ in range(20):
                if self.messenger_gate(page, ctx) != "clear":
                    return (
                        None,
                        "needs your help: Messenger PIN (upar wala card dekhein)",
                    )
                try:
                    if page.locator('div[contenteditable="true"]').count() > 0:
                        break
                except Exception:
                    pass
                try:
                    page.wait_for_timeout(500)
                except Exception:
                    time.sleep(0.5)
            self._wait_ready(page, ctx)
            try:
                page.wait_for_timeout(2500)
            except Exception:
                time.sleep(2.5)
            try:
                has_box = False
                for _ in range(30):
                    if (
                        page.locator(
                            'div[contenteditable="true"], [role="textbox"], textarea'
                        ).count()
                        > 0
                    ):
                        has_box = True
                        break
                    page.wait_for_timeout(500)
            except Exception:
                has_box = False
            if not has_box:
                try:
                    self.report_stuck(
                        page, ctx, "chat khul gayi lekin message box nahi mila"
                    )
                    page.screenshot(path="open_chat_debug.png")
                except Exception:
                    pass
                _note(
                    ctx,
                    "open chat: no message box | page end: "
                    + _clean_text((page.inner_text("body") or "")[-300:], 300),
                )
                return (
                    None,
                    "chat page opened but no message box | " + self._page_state(page),
                )
            wanted = ((ctx or {}).get("profile_name") or "").strip().lower()
            if wanted:
                try:
                    body_low = (page.inner_text("body") or "").lower()
                except Exception:
                    body_low = ""
                if wanted.split()[0] not in body_low:
                    return (
                        None,
                        f"chat opened but name '{wanted}' not seen on page, not sending",
                    )
            return direct_url, "opened (direct thread URL)"
        except Exception as exc:  # noqa: BLE001
            _note(ctx, f"open chat failed ({profile_url}): {exc}")
            return None, str(exc)

    def _profile_numeric_id(self, page: Page, profile_url: str) -> str | None:
        """Numeric Facebook id of the profile page we are on."""
        m = re.search(r"[?&]id=(\d+)", profile_url or "")
        if m:
            return m.group(1)
        try:
            html = page.content() or ""
        except Exception:
            return None
        for pattern in (
            r"fb://profile/(\d+)",
            r'"entity_id":"(\d+)"',
            r'"profile_id":"(\d+)"',
            r'"userID":"(\d+)"',
        ):
            m = re.search(pattern, html)
            if m and m.group(1) != "0":
                return m.group(1)
        return None

    def pin_screen_present(self, page: Page) -> bool:
        """True when Messenger is showing its PIN screen."""
        try:
            low = (page.inner_text("body") or "").lower()
        except Exception:
            return False
        return "enter your pin" in low or "restore your chats" in low

    def messenger_gate(self, page: Page, ctx: dict | None) -> str:
        """'clear' | 'needs_pin' | 'pin_wrong'. When Messenger asks for
        its PIN: ask the user (help card) if we have none, else type it."""
        if not self.pin_screen_present(page):
            return "clear"
        import help_requests

        pin = help_requests.get_pin()
        if not pin:
            help_requests.raise_help(
                "pin",
                "Messenger apna PIN maang raha hai. Neeche PIN daalein — "
                "agent baaki kaam khud kar lega.",
            )
            _note(ctx, "Messenger asks for its PIN - waiting for the user")
            return "needs_pin"
        try:
            box = page.locator('div[role="dialog"] input').first
            if box.count() > 0:
                box.click(timeout=3000)
        except Exception:
            pass
        try:
            page.keyboard.type(pin, delay=150)
        except Exception:
            _note(ctx, "could not type the PIN")
        for _ in range(40):
            try:
                page.wait_for_timeout(500)
            except Exception:
                time.sleep(0.5)
            if not self.pin_screen_present(page):
                _note(ctx, "Messenger PIN accepted")
                return "clear"
        help_requests.clear_pin()
        help_requests.raise_help(
            "pin", "Messenger ne PIN qubool nahi kiya. Sahi PIN dobara daalein."
        )
        return "pin_wrong"

    def report_stuck(self, page: Page, ctx: dict | None, what: str) -> None:
        """Ask the user for help (with a screenshot) instead of failing blindly."""
        import os

        import help_requests

        try:
            here = os.path.dirname(os.path.abspath(__file__))
            page.screenshot(path=os.path.join(here, "last_problem.png"))
        except Exception:
            pass
        help_requests.raise_help(
            "stuck",
            f"Agent ruk gaya: {what}. Neeche screenshot mein dekhein agent ko kya "
            "dikh raha hai. 'Window kholein' dabayein, masla khud theek karein "
            "(popup band karein / PIN daalein), phir 'Maine theek kar diya' dabayein.",
        )

    def read_messenger_threads(
        self, page: Page, ctx: dict | None, source: str = "inbox"
    ) -> list[dict]:
        """Messenger thread list -> [{thread_url, name, last_text,
        unread, source}]. ``source`` is "inbox" (/messages) or
        "message_requests" (/messages/requests) — a first message to
        a stranger lands in Message Requests until they accept.
        Ported from client-hunting's _collect_threads. Best-effort;
        never raises.
        """
        url = (
            f"{self.base_url}/messages/requests"
            if source == "message_requests"
            else f"{self.base_url}/messages"
        )
        if _should_stop(ctx):
            return []
        try:
            if not self._load(page, url, ctx, f"threads:{source}"):
                return []
            if self.messenger_gate(page, ctx) != "clear":
                return []
            self._scroll_and_collect(page, ctx, rounds=1, wait_ms=800)
            seen: dict[str, int] = {}
            out: list[dict] = []
            try:
                anchors = page.query_selector_all("a[href]")
            except Exception:
                anchors = []
            for a in anchors:
                try:
                    href = a.get_attribute("href") or ""
                    text = a.inner_text() or ""
                    aria = a.get_attribute("aria-label") or ""
                except Exception:
                    continue
                m = re.search(r"/messages/(?:e2ee/)?t/(\d+)", href or "")
                if not m:
                    continue
                thread_url = f"{self.base_url}/messages/{'e2ee/' if 'e2ee/' in href else ''}t/{m.group(1)}"
                lines = [ln.strip() for ln in text.split("\n") if ln.strip()]
                name = next(
                    (ln for ln in lines if not re.match(r"^active\b", ln, re.I)), ""
                )
                if not name and aria:
                    name = _clean_text(aria.split(",")[0].replace("unread", ""), 120)
                last_text = _clean_text(
                    " ".join(
                        ln
                        for ln in lines
                        if ln != name and not re.match(r"^active\b", ln, re.I)
                    ),
                    300,
                )
                if name and last_text.lower().startswith(name.lower()):
                    last_text = _clean_text(last_text[len(name) :], 300)
                row = f"{aria} {text}".lower()
                unread = "unread" in row or "mark as read" in text.lower()
                if thread_url in seen:
                    stored = out[seen[thread_url]]
                    if not stored.get("name") and name:
                        stored["name"] = name
                    if not stored.get("last_text") and last_text:
                        stored["last_text"] = last_text
                    stored["unread"] = bool(stored.get("unread") or unread)
                    continue
                seen[thread_url] = len(out)
                out.append(
                    {
                        "thread_url": thread_url,
                        "name": _clean_text(name, 120),
                        "last_text": last_text,
                        "unread": unread,
                        "source": source,
                    }
                )
            if not out:
                _note(ctx, f"0 threads ({source}): {self._page_state(page)}")
            return out
        except Exception as exc:  # noqa: BLE001
            _note(ctx, f"read threads failed ({source}): {exc}")
            return []

    def read_thread_messages(
        self, page: Page, thread_url: str, ctx: dict | None
    ) -> list[dict]:
        """Read one thread -> [{text, side}] oldest first, side "me" /
        "them" / "unknown" (bounding-rect heuristic, see
        _THREAD_MESSAGES_JS). Never raises; [] on failure."""
        if _should_stop(ctx):
            return []
        try:
            if not self._load(page, thread_url, ctx, "read_thread"):
                return []
            try:
                self._wait_composer(page)
                page.wait_for_timeout(1500)
                rows = page.evaluate(_THREAD_MESSAGES_JS) or []
            except Exception:
                rows = []
            out = []
            for row in rows if isinstance(rows, list) else []:
                if not isinstance(row, dict):
                    continue
                text = _clean_text(str(row.get("text") or ""), 2000)
                if not text:
                    continue
                side = row.get("side") or "unknown"
                out.append(
                    {
                        "text": text,
                        "side": side if side in ("me", "them") else "unknown",
                    }
                )
            return out
        except Exception as exc:  # noqa: BLE001
            _note(ctx, f"read thread failed ({thread_url}): {exc}")
            return []

    def send_thread_message(
        self, page: Page, thread_url: str, text: str, ctx: dict | None
    ) -> tuple[bool, str]:
        """Send one message, then RELOAD the thread and confirm it is
        still present before counting it delivered. Returns (ok,
        detail). Types letter by letter; reads the thread's latest
        state first so our message does not pile on top of the other
        person's own message. Ported from client-hunting's
        send_message. Never raises.
        """
        if _should_stop(ctx):
            return False, "stopped"
        try:
            _pace(ctx)
            if not thread_url.startswith("compose:") and not self._goto(
                page, thread_url, ctx, "send_message"
            ):
                return False, "page did not load"
            try:
                page.wait_for_timeout(2500)
            except Exception:
                time.sleep(2.5)
            if self._check_block(page, ctx):
                return False, "blocked"
            if self.messenger_gate(page, ctx) != "clear":
                return False, "needs your help: Messenger PIN"
            # Chat page gone (deleted chat / stale link): find the person again.
            try:
                gone = "this content isn't available" in (
                    page.inner_text("body") or ""
                ).lower().replace("\u2019", "'")
            except Exception:
                gone = False
            if gone:
                import chat_open

                found = chat_open._open_via_search(
                    self, page, (ctx or {}).get("profile_name") or "", ctx
                )
                if not found:
                    return (
                        False,
                        "chat page not available and person not found in Messenger search",
                    )
                thread_url = found
            # Latest state first (discipline: never pile on).
            if not thread_url.startswith("compose:"):
                self.read_thread_messages(page, thread_url, ctx)
            for _ in range(40):
                if self.messenger_gate(page, ctx) != "clear":
                    return False, "needs your help: Messenger PIN"
                try:
                    loc = page.locator('div[contenteditable="true"]')
                    if loc.count() > 0 and loc.last.is_visible():
                        break
                    if (
                        "before this chat was secured"
                        in (page.inner_text("body") or "").lower()
                    ):
                        cont = page.locator(
                            'div[role="button"]:has-text("Continue"), button:has-text("Continue")'
                        ).last
                        if cont.count() > 0 and cont.is_visible():
                            cont.click(timeout=3000)
                    page.wait_for_timeout(500)
                except Exception:
                    time.sleep(0.5)
            if _should_stop(ctx):
                return False, "stopped"
            box = None
            for selector in (
                'div[contenteditable="true"][aria-label*="Message" i]',
                'div[contenteditable="true"][data-testid*="message" i]',
                'div[contenteditable="true"]',
                'textarea[aria-label*="Message" i]',
            ):
                try:
                    loc = page.locator(selector).last
                    if loc.count() > 0 and loc.is_visible():
                        box = loc
                        break
                except Exception:
                    continue
            if box is None:
                try:
                    cont = page.locator(
                        'div[role="button"]:has-text("Continue"), button:has-text("Continue")'
                    ).last
                    if cont.count() > 0 and cont.is_visible():
                        cont.click(timeout=3000)
                        page.wait_for_timeout(2500)
                    loc = page.locator('div[contenteditable="true"]').last
                    if loc.count() > 0 and loc.is_visible():
                        box = loc
                except Exception:
                    pass
                if box is None:
                    return False, (
                        self.report_stuck(page, ctx, "message box nahi mila")
                        or "message box not found"
                    )
            box.click()
            # Letter by letter (keyboard.type with a per-key delay).
            if thread_url.startswith("compose:"):
                import chat_open

                if not chat_open.mark_popup(
                    page, (ctx or {}).get("profile_name") or ""
                ):
                    return (
                        False,
                        "chat popup is not the right person's - nothing was sent",
                    )
                box = page.locator(
                    'div[contenteditable="true"][data-lh-target="1"]'
                ).first
                box.click()
            try:
                self._human_type(page, text)
            except Exception:
                try:
                    page.keyboard.type(text, delay=60)
                except Exception:
                    return False, "could not type the message"
            try:
                page.wait_for_timeout(800)
            except Exception:
                time.sleep(0.8)
            page.keyboard.press("Enter")
            try:
                page.wait_for_timeout(2500)
            except Exception:
                time.sleep(2.5)
            if thread_url.startswith("compose:"):
                import chat_open

                real = None
                for _ in range(40):
                    real = chat_open._canon(page.url or "")
                    if not real:
                        try:
                            hrefs = page.evaluate(
                                "(n) => { const out = []; for (const a of document.querySelectorAll('a[href*=\"/messages/\"]')) { const h = a.getAttribute('href') || ''; if (!/\\/messages\\/(e2ee\\/)?t\\/\\d+/.test(h)) continue; const t = (a.innerText || '').toLowerCase(); if (a.getAttribute('aria-current') === 'page' || (n && t.indexOf(n.toLowerCase()) !== -1)) out.push(h); } return out; }",
                                (ctx or {}).get("profile_name") or "",
                            )
                            for h in hrefs or []:
                                real = chat_open._canon(h)
                                if real:
                                    break
                        except Exception:
                            pass
                    if real:
                        break
                    try:
                        page.wait_for_timeout(500)
                    except Exception:
                        time.sleep(0.5)
                if not real:
                    pass
                if not real:
                    real = self._find_sent_thread(page, ctx, text)
                    if real:
                        self._goto(page, real, ctx, "after_send")
                if not real:
                    return (
                        False,
                        "message sent but its chat link was not found in the inbox",
                    )
                thread_url = real
                if ctx is not None:
                    ctx["new_thread_url"] = real
            # Verify after reload: the message counts ONLY if still present.
            _stage(ctx, "verifying sent")
            tail = _clean_text(text, 120)
            try:
                page.reload(wait_until="domcontentloaded")
                page.wait_for_timeout(2500)
            except Exception:
                try:
                    page.goto(thread_url, wait_until="domcontentloaded")
                    page.wait_for_timeout(2500)
                except Exception:
                    pass
            try:
                body = page.inner_text("body") or ""
                body = self._body_after_send(page, text)
                # Match on a distinctive tail chunk (last ~60 chars).
                probe = re.sub(
                    r"\s+",
                    " ",
                    text.replace("\u2019", "'")
                    .replace("\u2018", "'")
                    .replace("\u201c", '"')
                    .replace("\u201d", '"'),
                ).strip()[-40:]
                if probe and probe in re.sub(r"\s+", " ", body):
                    return True, "sent and confirmed after reload"
                return False, "sent but NOT found after reload"
            except Exception:
                return False, "could not verify after reload"
        except Exception as exc:  # noqa: BLE001
            _note(ctx, f"send message failed ({thread_url}): {exc}")
            return False, str(exc)

    def _find_sent_thread(self, page, ctx, text):
        """The chat we just wrote in: the inbox row whose last line is 'You: <our text>'."""
        probe = re.sub(r"\s+", " ", (text or "")).strip()[:25].lower()
        parts = ((ctx or {}).get("profile_name") or "").split()
        first = parts[0].lower() if parts else ""
        if not probe:
            return None
        for _ in range(4):
            try:
                rows = self.read_messenger_threads(page, ctx, "inbox")
            except Exception:
                rows = []
            for r in rows:
                last = re.sub(r"\s+", " ", (r.get("last_text") or "")).lower()
                if (
                    last.startswith("you:")
                    and probe in last
                    and r.get("thread_url")
                    and (not first or first in (r.get("name") or "").lower())
                ):
                    return r["thread_url"]
            try:
                page.wait_for_timeout(3000)
            except Exception:
                time.sleep(3)
        return None

    def _human_type(self, page, text):
        """Type like a person: key by key, uneven rhythm, small pauses."""
        for ch in text:
            page.keyboard.type(ch)
            d = random.uniform(0.03, 0.09)
            if ch in ".,!?":
                d += random.uniform(0.1, 0.35)
            elif ch == " " and random.random() < 0.08:
                d += random.uniform(0.2, 0.6)
            page.wait_for_timeout(int(d * 1000))

    def _wait_composer(self, page):
        """Wait for the message box; press Continue if a secured-chat screen blocks it."""
        for _ in range(25):
            try:
                if page.locator('div[contenteditable="true"]').count() > 0:
                    break
                cont = page.locator(
                    'div[role="button"]:has-text("Continue"), button:has-text("Continue")'
                ).last
                if cont.count() > 0 and cont.is_visible():
                    cont.click(timeout=3000)
            except Exception:
                pass
            try:
                page.wait_for_timeout(1000)
            except Exception:
                time.sleep(1)

    def _body_after_send(self, page, text):
        """Page text after reload; waits (and presses Continue) until the sent message shows."""

        def norm(s):
            s = (s or "").replace("\u2019", "'").replace("\u2018", "'")
            s = s.replace("\u201c", '"').replace("\u201d", '"')
            return re.sub(r"\s+", " ", s)

        probe = norm(text).strip()[-40:]
        body = ""
        for _ in range(20):
            try:
                body = norm(page.inner_text("body") or "")
            except Exception:
                body = ""
            if probe and probe in body:
                return body
            try:
                cont = page.locator(
                    'div[role="button"]:has-text("Continue"), button:has-text("Continue")'
                ).last
                if cont.count() > 0 and cont.is_visible():
                    cont.click(timeout=3000)
            except Exception:
                pass
            try:
                page.wait_for_timeout(1000)
            except Exception:
                time.sleep(1)
        return body

    def detect_block(self, page: Page) -> str | None:
        """Return the matched block marker, or None when no block is seen."""
        try:
            url = (page.url or "").lower()
            if "/checkpoint" in url or "checkpoint" in url:
                return "checkpoint"
            try:
                body = page.inner_text("body")[:6000].lower()
            except Exception:
                body = ""
            for marker in BLOCK_MARKERS:
                if marker in body:
                    return marker
            return None
        except Exception:
            return None

    def _page_state(self, page: Page) -> str:
        """One-line page state for logs: url/title/body_len/body snippet
        plus login_form / checkpoint / link count, so an empty page can
        be told apart from a login wall or a page that never rendered."""
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
        try:
            links = len(page.query_selector_all("a[href]"))
        except Exception:
            links = 0
        checkpoint = "checkpoint" in (url + " " + body).lower()
        return (
            f"url={url} title={_clean_text(title, 120)} "
            f"body_len={len(body)} body='{_clean_text(body, 200)}' "
            f"login_form={int(login_form)} checkpoint={int(checkpoint)} "
            f"links={links}"
        )

    def _check_block(self, page: Page, ctx: dict | None) -> str | None:
        """Detect a block, report it via ctx, and return the marker."""
        marker = self.detect_block(page)
        if marker:
            _blocked(
                ctx, f"Facebook block/warning: {marker} | {self._page_state(page)}"
            )
            _activity(ctx, "blocked", f"Facebook block: {marker}")
        return marker

    def _click_first_visible(self, page: Page, selectors) -> bool:
        """Click the first visible locator among the selectors.

        Normal click first (the element is scrolled into view).
        If every normal click fails — e.g. an invisible overlay
        swallows the event, which Facebook's React can do while
        Playwright still reports the click as done — retry with
        force=True, which bypasses the actionability checks.
        Returns True when a click happened. Never raises.
        """
        for force in (False, True):
            for selector in selectors:
                try:
                    loc = page.locator(selector).first
                    if loc.count() > 0 and loc.is_visible():
                        if not force:
                            try:
                                loc.scroll_into_view_if_needed(timeout=3000)
                            except Exception:
                                pass
                        loc.click(timeout=5000, force=force)
                        return True
                except Exception:
                    continue
        return False

    def _wait_for_visible(self, page: Page, selectors, timeout_ms: int = 5000) -> bool:
        """Poll until any of the selectors is visible (or the bound
        expires). Waiting for the TEXT to exist is not enough —
        Facebook's React can leave the text in the DOM while the
        menu is still half-rendered and not clickable yet. Never
        raises."""
        polls = max(1, int(timeout_ms / 500))
        for _ in range(polls):
            for selector in selectors:
                try:
                    loc = page.locator(selector).first
                    if loc.count() > 0 and loc.is_visible():
                        return True
                except Exception:
                    continue
            try:
                page.wait_for_timeout(500)
            except Exception:
                time.sleep(0.5)
        return False

    def _wait_for_text(self, page: Page, text: str, timeout_ms: int = 5000) -> bool:
        """Poll until the body contains the text (or the bound expires)."""
        polls = max(1, int(timeout_ms / 500))
        for _ in range(polls):
            try:
                body = page.inner_text("body") or ""
                if text.lower() in body.lower():
                    return True
            except Exception:
                pass
            try:
                page.wait_for_timeout(500)
            except Exception:
                time.sleep(0.5)
        return False

    def _profile_url(self, href: str | None) -> str | None:
        """Normalise an href to a canonical profile URL, or None.

        ``profile.php?id=...`` is handled BEFORE stripping the query
        string. Dotted usernames (john.smith) are allowed; file-like
        slugs (.jpg/.html/.php) and nav paths are rejected.
        """
        if not href:
            return None
        href = href.strip()
        if not href or href.startswith(("javascript:", "#", "mailto:")):
            return None
        try:
            parsed = urlparse(href)
        except Exception:
            return None
        if parsed.netloc and "facebook.com" not in parsed.netloc.lower():
            return None
        path = (parsed.path or "").rstrip("/")
        if not path or path == "/":
            return None
        segments = [s for s in path.split("/") if s]
        if not segments:
            return None
        first = segments[0].lower()
        # profile.php?id=... — extract the id before dropping the query.
        if first == "profile.php":
            ids = parse_qs(parsed.query).get("id")
            if ids and ids[0].isdigit():
                return f"{self.base_url}/profile.php?id={ids[0]}"
            return None
        if first in _NAV_PATHS:
            return None
        if len(segments) > 2:
            return None
        # File-like slugs are not profiles (e.g. /photo.jpg, /page.html).
        if _FILE_EXT_RE.search(path):
            return None
        # Username: letters/digits/dots/underscores, must contain a letter.
        username = segments[0]
        if not re.fullmatch(r"[A-Za-z0-9._-]+", username):
            return None
        if not re.search(r"[A-Za-z]", username):
            return None
        return f"{self.base_url}/{username}"

    def _group_url(self, href: str | None) -> str | None:
        """Normalise an href to a group URL, or None."""
        if not href:
            return None
        try:
            parsed = urlparse(href.strip())
        except Exception:
            return None
        if parsed.netloc and "facebook.com" not in parsed.netloc.lower():
            return None
        path = (parsed.path or "").rstrip("/")
        m = re.fullmatch(r"/groups/([A-Za-z0-9._-]+)", path)
        if not m:
            return None
        return f"{self.base_url}/groups/{m.group(1)}"

    def _post_url(self, href: str | None) -> str | None:
        """Normalise an href to a post/permalink URL, or None."""
        if not href:
            return None
        href = href.strip()
        try:
            parsed = urlparse(href)
        except Exception:
            return None
        if parsed.netloc and "facebook.com" not in parsed.netloc.lower():
            return None
        path = parsed.path or ""
        if "/posts/" in path or "/permalink/" in path or "story_fbid" in parsed.query:
            return href if href.startswith("http") else f"{self.base_url}{href}"
        return None

    def _anchors(self, page: Page) -> list:
        """All <a href> elements currently on the page (never raises)."""
        try:
            return list(page.query_selector_all("a[href]"))
        except Exception:
            return []

    def _links(self, page: Page) -> list[tuple[str, str]]:
        """All (href, link text) pairs currently on the page."""
        out: list[tuple[str, str]] = []
        for a in self._anchors(page):
            try:
                href = a.get_attribute("href") or ""
                text = _clean_text(a.inner_text() or "", 120)
            except Exception:
                continue
            if href:
                out.append((href, text))
        return out

    def _member_count_for(self, page: Page, anchor, name: str) -> int | None:
        """Best-effort member/follower count for a group/page result.

        (1) text near the result (anchor ancestor, via _nearby_text_for);
        (2) fall back to searching the page body for "<name> ... N
        members/followers" in a short window after the name. Never
        raises; returns None when no count is exposed.
        """
        try:
            nearby = _nearby_text_for(page, anchor)
            if nearby:
                count = _parse_member_count(nearby)
                if count is not None:
                    return count
        except Exception:
            pass
        try:
            body = page.inner_text("body") or ""
            if name and body:
                idx = body.lower().find(name.lower())
                if idx >= 0:
                    window = body[idx : idx + len(name) + 120]
                    return _parse_member_count(window)
        except Exception:
            pass
        return None

    def _scroll_and_collect(
        self, page: Page, ctx: dict | None, rounds: int = 8, wait_ms: int = 2000
    ) -> None:
        """Scroll the page in steps so lazy-loaded content renders."""
        for _ in range(rounds):
            if _should_stop(ctx):
                return
            try:
                page.evaluate("window.scrollBy(0, window.innerHeight)")
            except Exception:
                try:
                    page.mouse.wheel(0, 800)
                except Exception:
                    pass
            try:
                page.wait_for_timeout(wait_ms)
            except Exception:
                time.sleep(wait_ms / 1000.0)

    def _collect_from_links(
        self, page: Page, kind: str, label: str, source_url: str
    ) -> list[dict]:
        """Build candidate dicts from the links currently on the page.

        When a profile URL is already seen, a later anchor with a
        non-empty name UPDATES the stored (blank) name — the first
        anchor for a profile is often its picture link, whose text is
        empty, so keeping the first anchor kept every name blank.

        Profile candidates also carry ``comment_text`` (the comment
        that surfaced the person, "" otherwise) and ``found_via``
        ("comment" for group/page comment sources, "search" otherwise;
        group_members sets "member" itself). Group/page results carry
        ``member_count`` (int or None — None when the page does not
        expose a count; never blocks the run).
        """
        seen: dict[str, int] = {}
        out: list[dict] = []
        for anchor in self._anchors(page):
            try:
                href = anchor.get_attribute("href") or ""
                text = _clean_text(anchor.inner_text() or "", 120)
            except Exception:
                continue
            if not href:
                continue
            if kind == "profiles":
                url = self._profile_url(href)
                if not url:
                    continue
                found_via = _found_via_for_label(label)
                comment_text = ""
                if found_via == "comment":
                    comment_text = _comment_text_for(page, anchor)
                if url in seen:
                    stored = out[seen[url]]
                    if not stored.get("name") and text:
                        stored["name"] = text
                    if not stored.get("comment_text") and comment_text:
                        stored["comment_text"] = comment_text
                    continue
                seen[url] = len(out)
                out.append(
                    {
                        "profile_url": url,
                        "name": text or "",
                        "source": label,
                        "source_url": source_url,
                        "source_detail": label,
                        "comment_text": comment_text,
                        "found_via": found_via,
                    }
                )
            elif kind == "groups":
                url = self._group_url(href)
                if not url:
                    continue
                if url in seen:
                    stored = out[seen[url]]
                    if not stored.get("name") and text:
                        stored["name"] = text
                    if stored.get("member_count") is None:
                        count = self._member_count_for(
                            page, anchor, text or stored.get("name") or ""
                        )
                        if count is not None:
                            stored["member_count"] = count
                    continue
                seen[url] = len(out)
                out.append(
                    {
                        "url": url,
                        "name": text or "",
                        "member_count": self._member_count_for(page, anchor, text),
                    }
                )
            elif kind == "pages":
                url = self._profile_url(href)
                if not url:
                    continue
                if url in seen:
                    stored = out[seen[url]]
                    if not stored.get("name") and text:
                        stored["name"] = text
                    if stored.get("member_count") is None:
                        count = self._member_count_for(
                            page, anchor, text or stored.get("name") or ""
                        )
                        if count is not None:
                            stored["member_count"] = count
                    continue
                seen[url] = len(out)
                out.append(
                    {
                        "url": url,
                        "name": text or "",
                        "member_count": self._member_count_for(page, anchor, text),
                    }
                )
            elif kind == "posts":
                url = self._post_url(href)
                if not url:
                    continue
                if url in seen:
                    continue
                seen[url] = len(out)
                out.append({"url": url})
        return out

    def _search_via_ui(
        self,
        page: Page,
        keyword: str,
        tab: str,
        ctx: dict | None,
        kind: str = "profiles",
    ) -> list[dict]:
        """Search using Facebook's own search box, then collect results.

        Search page -> search box -> type keyword -> Enter -> click
        the tab (People/Posts/Pages/Groups) -> collect from the
        results page. Used when a direct search URL yields 0 links.
        """
        if _should_stop(ctx):
            return []
        label = f"ui_search:{tab}:{keyword}"
        try:
            # Never load the home page here: home hangs in this
            # Chromium (see verify_session), so a home load can
            # stall the whole fallback. The search results page
            # itself carries the same search box — load it and
            # type the keyword there instead. (Only groups/pages
            # call this fallback; anything else loads the groups
            # search — the box + tab click still do the real work.)
            kind_url = kind if kind in ("groups", "pages") else "groups"
            if not self._load(
                page, self.search_url(keyword, kind_url), ctx, "ui_search"
            ):
                return []
            box = None
            for selector in (
                'input[placeholder*="Search Facebook"]',
                'input[aria-label="Search Facebook"]',
                'input[type="search"]',
                'input[placeholder*="Search"]',
            ):
                try:
                    loc = page.locator(selector).first
                    if loc.count() > 0 and loc.is_visible():
                        box = loc
                        break
                except Exception:
                    continue
            if box is None:
                _note(
                    ctx,
                    f"search box not found for '{keyword}': "
                    f"{self._page_state(page)}",
                )
                return []
            box.click()
            box.type(keyword, delay=60)
            box.press("Enter")
            try:
                page.wait_for_timeout(3000)
            except Exception:
                time.sleep(3)
            # Click the results tab (People / Posts / Pages / Groups).
            clicked = False
            for selector in (
                f'a[role="link"]:has-text("{tab}")',
                f'[role="tab"]:has-text("{tab}")',
                f'text="{tab}"',
            ):
                try:
                    loc = page.locator(selector).first
                    if loc.count() > 0:
                        loc.click(timeout=5000)
                        clicked = True
                        break
                except Exception:
                    continue
            if not clicked:
                _note(
                    ctx,
                    f"search tab '{tab}' not clickable for "
                    f"'{keyword}': {self._page_state(page)}",
                )
            try:
                page.wait_for_timeout(3000)
            except Exception:
                time.sleep(3)
            # Results render after the tab click — wait for real content
            # instead of assuming the fixed sleep was enough.
            self._wait_ready(page, ctx)
            if self.check_session(page, ctx) != "ok":
                _note(ctx, f"session not ok on {label}: " f"{self._page_state(page)}")
                return []
            self._scroll_and_collect(page, ctx)
            if kind == "profiles":
                candidates = self._collect_from_links(page, "profiles", label, page.url)
            elif kind == "groups":
                candidates = self._collect_from_links(page, "groups", label, page.url)
            elif kind == "pages":
                candidates = self._collect_from_links(page, "pages", label, page.url)
            else:
                candidates = self._collect_from_links(page, "posts", label, page.url)
            if not candidates:
                state = self._page_state(page)
                _note(ctx, f"0 results via search box ({label}): {state}")
                _activity(
                    ctx,
                    "browse",
                    f"Search-box fallback empty for '{keyword}' — {state}",
                )
                self._check_block(page, ctx)
            return candidates
        except Exception as exc:  # noqa: BLE001 - never raise on one bad page
            _note(ctx, f"search-box fallback failed ('{keyword}'): {exc}")
            return []

    # ------------------------------------------------------------------
    # Search
    # ------------------------------------------------------------------
    def search_groups(self, page: Page, keyword: str, ctx: dict | None) -> list[dict]:
        """Search groups -> [{url, name, member_count}]."""
        if _should_stop(ctx):
            return []
        url = self.search_url(keyword, "groups")
        try:
            if not self._load(page, url, ctx, "group_search"):
                return []
            self._scroll_and_collect(page, ctx)
            results = self._collect_from_links(page, "groups", "group_search", url)
            if not results:
                _note(ctx, f"0 groups for '{keyword}': {self._page_state(page)}")
                results = self._search_via_ui(
                    page, keyword, "Groups", ctx, kind="groups"
                )
            return results
        except Exception as exc:  # noqa: BLE001
            _note(ctx, f"group search failed ('{keyword}'): {exc}")
            return []

    def search_pages(self, page: Page, keyword: str, ctx: dict | None) -> list[dict]:
        """Search pages -> [{url, name, member_count}]."""
        if _should_stop(ctx):
            return []
        url = self.search_url(keyword, "pages")
        try:
            if not self._load(page, url, ctx, "page_search"):
                return []
            self._scroll_and_collect(page, ctx)
            results = self._collect_from_links(page, "pages", "page_search", url)
            if not results:
                _note(ctx, f"0 pages for '{keyword}': {self._page_state(page)}")
                results = self._search_via_ui(page, keyword, "Pages", ctx, kind="pages")
            return results
        except Exception as exc:  # noqa: BLE001
            _note(ctx, f"page search failed ('{keyword}'): {exc}")
            return []

    # ------------------------------------------------------------------
    # Groups
    # ------------------------------------------------------------------
    def join_group(self, page: Page, group_url: str, ctx: dict | None) -> bool:
        """Join a group. Returns True only when membership is confirmed."""
        if _should_stop(ctx):
            return False
        try:
            if not self._load(page, group_url, ctx, "join_group"):
                return False
            if self._check_block(page, ctx):
                return False
            clicked = False
            for selector in (
                'button:has-text("Join group")',
                'div[role="button"]:has-text("Join group")',
                'a:has-text("Join group")',
            ):
                try:
                    loc = page.locator(selector).first
                    if loc.count() > 0 and loc.is_visible():
                        loc.click(timeout=5000)
                        clicked = True
                        break
                except Exception:
                    continue
            if not clicked:
                # Already a member, or no join button on this page.
                try:
                    body = page.inner_text("body")[:4000]
                    if re.search(r"\b(Joined|Member|Leave group)\b", body):
                        return True
                except Exception:
                    pass
                _note(ctx, f"no Join button on {group_url}: {self._page_state(page)}")
                return False
            try:
                page.wait_for_timeout(3000)
            except Exception:
                time.sleep(3)
            try:
                body = page.inner_text("body")[:4000]
                if re.search(r"\b(Joined|Member|Request sent|Pending)\b", body):
                    return True
            except Exception:
                pass
            return clicked
        except Exception as exc:  # noqa: BLE001
            _note(ctx, f"join group failed ({group_url}): {exc}")
            return False

    def leave_group(self, page: Page, group_url: str, ctx: dict | None) -> bool:
        """Leave a group. Returns True ONLY when the page proves the
        user is no longer a member (a "Join group" button is shown).

        Steps: click "Joined" to open the menu → click "Leave group"
        in the menu → click "Leave group" in the confirmation dialog.
        Uses broad text selectors (Facebook's menu roles vary), waits
        for each step to appear, and verifies at the end. Returns
        False when the leave did not happen — the caller must NOT
        treat that as "already left". Never raises.
        """
        if _should_stop(ctx):
            return False
        try:
            if not self._load(page, group_url, ctx, "leave_group"):
                _note(ctx, f"leave group: page did not load ({group_url})")
                return False
            if self._check_block(page, ctx):
                return False
            # Already not a member?
            if self._shows_join_button(page):
                return True
            # Open the Joined menu.
            opened = self._click_first_visible(
                page,
                (
                    'button:has-text("Joined")',
                    'div[role="button"]:has-text("Joined")',
                    'text="Joined"',
                ),
            )
            if not opened:
                _note(ctx, f"leave group: no Joined button ({group_url})")
                return False
            # Wait for the menu's "Leave group" item to be VISIBLE
            # (up to 5s). The text alone is not proof — React can
            # leave it in the DOM while the menu is half-rendered
            # and not clickable yet.
            if not self._wait_for_visible(
                page,
                (
                    'div[role="menuitem"]:has-text("Leave group")',
                    '[role="menuitem"]:has-text("Leave group")',
                    'span:has-text("Leave group")',
                    'text="Leave group"',
                ),
                5000,
            ):
                _note(ctx, f"leave group: menu did not open ({group_url})")
                return False
            clicked = self._click_first_visible(
                page,
                (
                    'div[role="menuitem"]:has-text("Leave group")',
                    '[role="menuitem"]:has-text("Leave group")',
                    'text="Leave group"',
                    'span:has-text("Leave group")',
                ),
            )
            if not clicked:
                _note(ctx, f"leave group: no Leave item ({group_url})")
                return False
            # Confirm the dialog: poll up to 5s for the confirm button.
            # Facebook's dialog confirm is often a div[role="button"],
            # not a real <button> — button:has-text alone misses it
            # (cross-check: div[aria-label='Leave group'][role='button']).
            # The click result is checked: a missed confirm must report
            # "no confirm button", never silently become "still Joined".
            confirmed = False
            for _ in range(10):
                if self._click_first_visible(
                    page,
                    (
                        'button:has-text("Leave group")',
                        'div[role="button"]:has-text("Leave group")',
                        'div[aria-label="Leave group"][role="button"]',
                        'button:has-text("Leave")',
                    ),
                ):
                    confirmed = True
                    break
                try:
                    page.wait_for_timeout(500)
                except Exception:
                    time.sleep(0.5)
            if not confirmed:
                _note(ctx, f"leave group: no confirm button ({group_url})")
                return False
            try:
                page.wait_for_timeout(3000)
            except Exception:
                time.sleep(3)
            # Verify by RELOADING the page: after leaving, Facebook
            # does not always repaint the header at once, so reading
            # the same (stale) DOM can wrongly report "still Joined"
            # even when the leave actually happened. Facebook can
            # also take a few seconds to process the leave, so retry
            # the verify a few times — a single too-early check
            # wrongly reported "Could not leave" for a leave that
            # completed moments later.
            for _attempt in range(3):
                loaded = self._load(page, group_url, ctx, "leave_group_verify")
                if loaded and self._shows_join_button(page):
                    return True
                if not loaded:
                    _note(
                        ctx,
                        f"leave group: verify reload failed, "
                        f"retrying ({group_url})",
                    )
                try:
                    page.wait_for_timeout(5000)
                except Exception:
                    time.sleep(5)
            try:
                _snippet = _clean_text(page.inner_text("body") or "", 200)
            except Exception:
                _snippet = ""
            _note(
                ctx,
                f"leave group: still Joined after confirm "
                f"({group_url}) :: body='{_snippet}'",
            )
            return False
        except Exception as exc:  # noqa: BLE001
            _note(ctx, f"leave group failed ({group_url}): {exc}")
            return False

    def _shows_join_button(self, page: Page) -> bool:
        """True when the page shows a "Join group" button (not a member).

        Case-insensitive: Facebook's casing varies, and a missed
        match here wrongly reports a successful leave as failed.
        """
        try:
            body = page.inner_text("body") or ""
            return bool(re.search(r"\bJoin group\b", body, re.I))
        except Exception:
            return False

    def follow_page(self, page: Page, page_url: str, ctx: dict | None) -> bool:
        """Follow a page. True when following afterwards. Never raises."""
        if _should_stop(ctx):
            return False
        try:
            if not self._load(page, page_url, ctx, "follow_page"):
                return False
            if self._check_block(page, ctx):
                return False
            try:
                body = page.inner_text("body")[:4000]
                if re.search(r"\bFollowing\b", body):
                    return True
            except Exception:
                pass
            clicked = self._click_first_visible(
                page,
                (
                    'div[role="button"][aria-label="Follow"]',
                    'button:has-text("Follow")',
                    'div[role="button"]:has-text("Follow")',
                ),
            )
            if not clicked:
                return False
            try:
                page.wait_for_timeout(2000)
            except Exception:
                time.sleep(2)
            try:
                body = page.inner_text("body")[:4000]
                return bool(re.search(r"\bFollowing\b", body))
            except Exception:
                return False
        except Exception as exc:  # noqa: BLE001
            _note(ctx, f"follow page failed ({page_url}): {exc}")
            return False

    def unfollow_page(self, page: Page, page_url: str, ctx: dict | None) -> bool:
        """Unfollow a page. Returns True when no longer following.

        Clicks "Following" (opens the menu) then "Unfollow". Returns
        True also when the page already shows "Follow" (not
        following). Never raises.
        """
        if _should_stop(ctx):
            return False
        try:
            if not self._load(page, page_url, ctx, "unfollow_page"):
                return False
            if self._check_block(page, ctx):
                return False
            try:
                body = page.inner_text("body")[:4000]
                if re.search(r"\bFollow\b", body) and not re.search(
                    r"\bFollowing\b", body
                ):
                    return True  # already not following
            except Exception:
                pass
            opened = self._click_first_visible(
                page,
                (
                    'button:has-text("Following")',
                    'div[role="button"]:has-text("Following")',
                ),
            )
            if opened:
                try:
                    page.wait_for_timeout(1500)
                except Exception:
                    time.sleep(1.5)
                clicked = self._click_first_visible(
                    page,
                    (
                        'div[role="menuitem"]:has-text("Unfollow")',
                        'span:has-text("Unfollow")',
                        'button:has-text("Unfollow")',
                    ),
                )
                if clicked:
                    try:
                        page.wait_for_timeout(2000)
                    except Exception:
                        time.sleep(2)
                    return True
            try:
                body = page.inner_text("body")[:4000]
                if re.search(r"\bFollow\b", body) and not re.search(
                    r"\bFollowing\b", body
                ):
                    return True
            except Exception:
                pass
            return False
        except Exception as exc:  # noqa: BLE001
            _note(ctx, f"unfollow page failed ({page_url}): {exc}")
            return False

    def read_source_member_count(
        self, page: Page, url: str, name: str, ctx: dict | None
    ) -> int | None:
        """Best-effort member/follower count for one recorded source.

        Loads the source's own page (group or page) and parses the
        count from the body text — first a window right after the
        source name, then a scan of the whole body for the first
        "N members/followers" pattern. Facebook loads the count
        lazily, so the body is re-read for up to ~10s until a
        "member"/"follower" word appears. When no count is found,
        a short diagnostic snippet of the body is noted (so the real
        format can be seen and the parser fixed with real data).
        Returns None when the page does not load, the session is
        dead, or no count is exposed. Never raises; never returns 0
        for a missing count.
        """
        try:
            if not self._load(page, url, ctx, "source"):
                _note(ctx, f"count: page did not load ({url})")
                return None
            body = ""
            for _attempt in range(10):
                body = page.inner_text("body") or ""
                if body and ("member" in body.lower() or "follower" in body.lower()):
                    break
                try:
                    page.wait_for_timeout(1000)
                except Exception:
                    time.sleep(1)
            if not body:
                _note(ctx, f"count: empty body ({url})")
                return None
            if name:
                idx = body.lower().find(name.lower())
                if idx >= 0:
                    count = _parse_member_count(body[idx : idx + len(name) + 200])
                    if count is not None:
                        return count
            count = _parse_member_count(body)
            if count is None:
                # Diagnostic only: show what the page actually has
                # around the group name, so the parser can be fixed
                # with the real format instead of a guess.
                snippet = ""
                if name:
                    idx = body.lower().find(name.lower())
                    if idx >= 0:
                        snippet = body[idx : idx + 300]
                if not snippet:
                    snippet = body[:300]
                snippet = re.sub(r"\s+", " ", snippet).strip()
                _note(ctx, f"count: no count found ({url}) :: {snippet}")
            return count
        except Exception:
            return None

    def _feed_loading(self, page: Page) -> bool:
        """True while "Loading..." placeholders remain in the feed.
        Never raises — unknown means not loading."""
        try:
            got = page.evaluate(_FEED_LOADING_JS) or {}
        except Exception:
            return False
        return bool(isinstance(got, dict) and got.get("loading"))

    def check_comments_activity(
        self, page: Page, url: str, ctx: dict | None, min_comments: int | None = None
    ) -> dict:
        """Quick activity check for a group/page BEFORE joining it.

        The finder's job is to bring back sources our data can come
        from — and our data comes purely from comments. A group with
        6,000 members but no comments on any post is useless to us,
        so this samples the recent feed and counts posts + comments.
        Loads the feed, waits for posts to render, then scrolls
        PATIENTLY before deciding: the feed loads only ~1 post on
        arrival and the 2nd after one scroll, with "Loading..."
        placeholders — a count from the first screen undercounts
        and good groups get skipped. So it scrolls one screen per
        round (~1.5 s), re-counts after each, and stops when the
        gate is already passed (when min_comments is known), when
        5 straight rounds add no new posts or comments and no
        placeholders remain, or at the 8-round cap. Returns
        {"posts": n, "comments": n}. Never raises — returns zeros
        when the feed never loads.
        """
        result: dict = {"posts": 0, "comments": 0, "active": None}
        state = {"active": None}
        if _should_stop(ctx):
            return result
        try:
            if not self._load(page, url, ctx, "activity_check"):
                return result
        except Exception:
            return result
        articles = self._wait_for_articles(page, ctx, timeout_s=20.0)
        if articles == 0:
            _note(
                ctx,
                f"feed never rendered articles for {url} — "
                f"gate skipped (0 comments)",
            )
            return result

        def _count_once() -> tuple[int, int, dict]:
            # Count straight from the Comment buttons' aria-labels
            # ("Comment on X's post, 223 comments"). In the group
            # feed the posts are NOT div[role="article"] (those are
            # the comments themselves), so article iteration finds no
            # posts at all — the button count IS the post count.
            try:
                got = page.evaluate(_GATE_COUNT_JS) or {}
            except Exception:
                got = {}
            if not isinstance(got, dict):
                got = {}
            try:
                n_posts = int(got.get("posts") or 0)
            except (TypeError, ValueError):
                n_posts = 0
            try:
                n_comments = int(got.get("comments") or 0)
            except (TypeError, ValueError):
                n_comments = 0
            state["active"] = got.get("active")
            const_via = {"button aria-label": n_posts} if n_posts else {}
            return n_posts, n_comments, const_via

        n_posts, n_comments, all_via = _count_once()
        # Patient scroll — see the docstring. A single scroll is
        # not enough: the first post does not even fully reveal
        # before the feed loads the next one.
        no_new = 0
        for _ in range(8):
            if _should_stop(ctx):
                break
            if min_comments is not None and n_comments >= min_comments and n_posts >= 5:
                break
            if no_new >= 5 and not self._feed_loading(page):
                break
            try:
                self._scroll_and_collect(page, ctx, rounds=1, wait_ms=1500)
            except Exception:
                break
            prev_posts, prev_comments = n_posts, n_comments
            n_posts, n_comments, all_via = _count_once()
            if n_posts > prev_posts or n_comments > prev_comments:
                no_new = 0
            else:
                no_new += 1
        result["posts"] = n_posts
        result["comments"] = n_comments
        result["active"] = state["active"]
        # Diagnostic: did the count parsing even see aria-labels?
        # (The accessible name may be computed, not an attribute.)
        try:
            diag = page.evaluate(_DIAG_ARIA_JS) or {}
        except Exception:
            diag = {}
        if not isinstance(diag, dict):
            diag = {}
        result["diag"] = {
            "aria_labels": int(diag.get("total") or 0),
            "comment_labels": int(diag.get("matched") or 0),
            "comment_btns": int(diag.get("btns") or 0),
            "btn_with_number": int(diag.get("btnNums") or 0),
            "via": dict(all_via),
            "samples": list(diag.get("samples") or [])[:3],
            "parent_btns": list(diag.get("parentBtns") or [])[:8],
        }
        return result
