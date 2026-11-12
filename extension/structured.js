// Structured Facebook extractor (shared logic for the Raw Data Collector).
// Returns an array of post objects, each with nested comments/replies:
//
//   [{ author: {name, url}, text, postUrl, comments: [
//        { author: {name, url}, text, postedAt, postedAtLabel, replies: [
//            { author: {name, url}, text, postedAt, postedAtLabel, replies: [...] } ] } ] }]
// postedAtLabel is the visible relative label ("5d"); postedAt is
// the exact time when the timestamp element's title/description
// carries one ("Friday 6 November 2026 at 09:10"), otherwise the
// label computed against the collection time (approximate).
// postUrl is the post's OWN permalink (/permalink/<id>/ or
// /posts/<id>/ inside its container). The LeadHunter app
// de-duplicates collected posts by postUrl, so two posts on one page
// must never share a URL — the page URL is used only as a fallback
// for the post the page itself opened.
//
// REAL Facebook structure (verified by a live browser diagnostic on the
// MemesCasm post, 2026-11-11):
// - A single post opens as a MODAL DIALOG (div[role="dialog"], heading
//   "X's post"). The post itself is NOT an article: author link +
//   timestamp + post text are plain text nodes in the dialog, before
//   the first article. It has Comment/Share/React buttons, NO Reply.
// - Comments ARE div[role="article"], all TOP-LEVEL flat siblings
//   directly under the dialog, none nested inside each other or inside
//   a post article. Only ~10 load at first; more load on scroll.
// - Replies are ALSO articles, flat siblings inserted immediately
//   after their parent comment. They are distinguished from top-level
//   comments ONLY by their accessible name: "Reply by X to Y's
//   comment" vs "Comment by X". (In the DOM this is the article's
//   aria-label.) The "View N replies" button sits AFTER its comment
//   article, not inside it.
// - Only the FIRST profile link in an article is its author;
//   @mentions inside the text are text, not new commenters.
//
// So the extractor: (1) finds the post dialog and reads the post from
// it; (2) classifies each article by aria-label ("Comment by" /
// "Reply by"); (3) attaches a reply to the most recent preceding
// article whose author matches the "to Y's comment" in its aria-label
// (DOM order + parent name). If there is no dialog (main feed), it
// falls back to treating top-level articles as posts. If the page has
// no articles (not Facebook, or the feed did not render), returns []
// and the caller falls back to flat text capture.

// --- Timestamps (module scope, so node tests can import them). ---
// Facebook shows only a RELATIVE label in the visible text ("5d",
// "19h", "Yesterday"), but the EXACT time is in the timestamp
// element's description/tooltip — its title attribute or the element
// referenced by aria-describedby (live diagnostic 2026-11-12:
// visible "5d" -> "Friday 6 November 2026 at 09:10"). So the order
// is: (1) exact time from the title/description, parsed to ISO;
// (2) ONLY if that is missing, compute from the label against the
// collection time ("5d" -> now minus 5 days). The fallback is
// approximate by nature (a "5d" label covers that whole day) — the
// computed value is still used for latest-activity filtering.
// postedAtLabel always keeps the original visible label.
var MONTHS = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };

function isTimestampLabel(text) {
  var t = (text || '').trim();
  if (/^\d+[smhdw]$/.test(t)) return true;
  if (/^\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i.test(t)) return true;
  if (/^(Yesterday|Just now)$/i.test(t)) return true;
  if (/^Yesterday at \d{1,2}:\d{2}$/i.test(t)) return true;
  if (/^Today at \d{1,2}:\d{2}$/i.test(t)) return true;
  if (/^(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}(, \d{4})?$/i.test(t)) return true;
  if (/^\d{1,2} (January|February|March|April|May|June|July|August|September|October|November|December)( \d{4})?$/i.test(t)) return true;
  if (/^\d{1,2} (January|February|March|April|May|June|July|August|September|October|November|December) at \d{1,2}:\d{2}$/i.test(t)) return true;
  return false;
}

function postedAtFromLabel(label, nowMs) {
  var now = typeof nowMs === 'number' ? nowMs : Date.now();
  var t = (label || '').trim();
  var m = t.match(/^(\d+)([smhdw])$/);
  if (m) {
    var unit = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[m[2]];
    return new Date(now - parseInt(m[1], 10) * unit).toISOString();
  }
  m = t.match(/^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i);
  if (m) {
    var per = { second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 604800000, month: 2592000000, year: 31536000000 }[m[2].toLowerCase()];
    return new Date(now - parseInt(m[1], 10) * per).toISOString();
  }
  if (/^Just now$/i.test(t)) return new Date(now).toISOString();
  if (/^Yesterday/i.test(t)) return new Date(now - 86400000).toISOString();
  return null;
}

function parseExactTimestamp(text, nowMs) {
  var now = typeof nowMs === 'number' ? nowMs : Date.now();
  var t = (text || '').trim();
  if (!t) return null;
  // "Yesterday at 21:02" / "Today at 09:10" — tooltips for recent labels.
  var m = /^(Yesterday|Today) at (\d{1,2}):(\d{2})$/i.exec(t);
  if (m) {
    var base = new Date(now);
    if (/^Yesterday/i.test(m[1])) base = new Date(now - 86400000);
    base.setHours(parseInt(m[2], 10), parseInt(m[3], 10), 0, 0);
    return base.toISOString();
  }
  // "[Weekday] DD Month YYYY at HH:MM" — weekday and comma optional.
  m = /^(?:[A-Za-z]+,?\s+)?(\d{1,2}) (January|February|March|April|May|June|July|August|September|October|November|December) (\d{4}) at (\d{1,2}):(\d{2})$/i.exec(t);
  if (m) {
    var d = new Date(parseInt(m[3], 10), MONTHS[m[2].toLowerCase()], parseInt(m[1], 10), parseInt(m[4], 10), parseInt(m[5], 10), 0, 0);
    return d.toISOString();
  }
  // "DD Month at HH:MM" (no year — the post header shows this form):
  // assume the current year; if that lands in the future, last year.
  m = /^(?:[A-Za-z]+,?\s+)?(\d{1,2}) (January|February|March|April|May|June|July|August|September|October|November|December) at (\d{1,2}):(\d{2})$/i.exec(t);
  if (m) {
    var y = new Date(now).getFullYear();
    var d2 = new Date(y, MONTHS[m[2].toLowerCase()], parseInt(m[1], 10), parseInt(m[3], 10), parseInt(m[4], 10), 0, 0);
    if (d2.getTime() > now) d2 = new Date(y - 1, MONTHS[m[2].toLowerCase()], parseInt(m[1], 10), parseInt(m[3], 10), parseInt(m[4], 10), 0, 0);
    return d2.toISOString();
  }
  return null;
}

// Exact time for one comment/reply article, from the timestamp
// element's title / aria-describedby / aria-label. Scans leaf
// elements whose text is a timestamp label, then checks the leaf and
// up to 3 ancestors (the title usually sits on the timestamp link
// itself or a wrapper). Returns an ISO string or null.
function exactTimestampFromArticle(art) {
  if (typeof document === 'undefined' || !art || !art.querySelectorAll) return null;
  try {
    var els = art.querySelectorAll('a, span, time, abbr');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.children && el.children.length > 0) continue;
      var txt = (el.textContent || '').trim();
      if (!isTimestampLabel(txt)) continue;
      var node = el;
      for (var depth = 0; depth < 4 && node; depth++) {
        var title = '';
        try { title = node.getAttribute ? (node.getAttribute('title') || '') : ''; } catch (e) {}
        var exact = parseExactTimestamp(title);
        if (exact) return exact;
        var descId = '';
        try { descId = node.getAttribute ? (node.getAttribute('aria-describedby') || '') : ''; } catch (e) {}
        if (descId) {
          var descEl = null;
          try { descEl = document.getElementById(descId.split(/\s+/)[0]); } catch (e) {}
          if (descEl) {
            exact = parseExactTimestamp(descEl.textContent || '');
            if (exact) return exact;
          }
        }
        var al = '';
        try { al = node.getAttribute ? (node.getAttribute('aria-label') || '') : ''; } catch (e) {}
        exact = parseExactTimestamp(al);
        if (exact) return exact;
        node = node.parentElement;
      }
    }
  } catch (e) {}
  return null;
}

function extractStructuredPosts() {
  var NAV = new Set(['search','groups','pages','events','marketplace','watch','login','settings','notifications','messages','friends','photos','videos','reels','reel','video','photo','story','gaming','fundraisers','saved','bookmarks','home','privacy','help','about','ads','business','developers','policies','dialog','plugins','sharer','tr','campaign','boost','live','stories','groups_feed','profile.php','professional_dashboard','creator_studio','monetization','creator','insights','publishing_tools','ads_manager']);
  function profileFromHref(href) {
    if (!href) return null;
    href = href.replace(/^https?:\/\/(www\.)?facebook\.com/i, '');
    var m = href.match(/^\/profile\.php\?id=(\d+)/);
    if (m) return 'https://www.facebook.com/profile.php?id=' + m[1];
    // Group-scoped profile links (/groups/<gid>/user/<uid>/) — the
    // commenter on a group post. The first segment is "groups" (in
    // NAV), so without this the link is rejected and the URL is null.
    m = href.match(/^\/groups\/\d+\/user\/(\d+)/);
    if (m) return 'https://www.facebook.com/profile.php?id=' + m[1];
    m = href.match(/^\/([A-Za-z0-9._-]+)(\?|#|$)/);
    if (!m) return null;
    if (NAV.has(m[1].toLowerCase())) return null;
    if (!/[A-Za-z]/.test(m[1])) return null;
    return 'https://www.facebook.com/' + m[1];
  }
  // Facebook uses the curly apostrophe (U+2019) in "'s post" labels
  // ("Barbara Hendry’s post") as often as the ASCII one — normalize
  // it before any 's-pattern match, or the name is missed entirely.
  function normApos(s) {
    return (s || '').replace(/[’‘ʼ]/g, "'");
  }
  // An element's own text: its innerText minus the text of any nested
  // comment articles inside it. Newlines are kept so the comment
  // cleaner can split the text into lines.
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
    // Drop leading header chrome, in order: the author name, "·"
    // separators, a timestamp ("5d", "5 days ago", "Yesterday",
    // "Just now"), the "Follow" word, and a bare like count. Loop
    // because the header is name · time · Follow on separate lines.
    // Never drop the last remaining line — a number on its own IS the
    // comment (e.g. someone just wrote "600000").
    while (lines.length > 1) {
      var first = lines[0];
      if (name && first === name) { lines.shift(); continue; }
      if (/^·$/.test(first)) { lines.shift(); continue; }
      if (/^\d+[smhdw]$/.test(first)) { lines.shift(); continue; }
      if (/^\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i.test(first)) { lines.shift(); continue; }
      if (/^(Yesterday|Just now)$/i.test(first)) { lines.shift(); continue; }
      // A full weekday date ("Monday 18 May 2026 at 01:14",
      // "Yesterday at 21:02") — the exact timestamp line the visible
      // label points to. parseExactTimestamp matches only a whole
      // line that IS a timestamp, so real comment text is never
      // dropped. The relative label after it ("25w") is handled above.
      if (parseExactTimestamp(first)) { lines.shift(); continue; }
      if (/^Follow$/i.test(first)) { lines.shift(); continue; }
      if (/^\d+(\.\d+)?[KM]?$/.test(first)) { lines.shift(); continue; }
      break;
    }
    // Drop trailing UI chrome: Reply / Like / a bare number (like count),
    // and a trailing copy of the author name. Never drop the last
    // remaining line — a number on its own IS the comment.
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
  // First profile-like link in an element. Only the first link is ever
  // the author; @mentions inside the text are text, not commenters.
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
  // The post author's profile link in an element, reconciled against
  // a name hint (from the Comment button or the dialog heading). The
  // hint alone can be first-name-only and the first profile link alone
  // can be a compact/participant link — so an exact name match wins,
  // otherwise the longest link text sharing the hint as a prefix wins
  // (the full display name). Links inside nested comment articles are
  // never the post author and are skipped. Returns null when no link
  // matches the hint — the caller falls back to the hint name with a
  // null URL rather than misattributing a commenter.
  function authorLinkIn(el, nameHint) {
    var hint = (nameHint || '').trim();
    if (!hint) return null;
    var lowerHint = hint.toLowerCase();
    var best = null;
    var links = el.querySelectorAll('a[href]');
    for (var li = 0; li < links.length; li++) {
      var a = links[li];
      var n = a.parentElement;
      var inArticle = false;
      while (n && n !== el) {
        if (n.getAttribute && n.getAttribute('role') === 'article') { inArticle = true; break; }
        n = n.parentElement;
      }
      if (inArticle) continue;
      var url = profileFromHref(a.getAttribute('href') || '');
      if (!url) continue;
      var nm = (a.innerText || '').trim();
      if (!nm) continue;
      if (nm === hint) return { name: nm, url: url };
      var lowerNm = nm.toLowerCase();
      if (lowerNm.indexOf(lowerHint) === 0 || lowerHint.indexOf(lowerNm) === 0) {
        if (!best || nm.length > best.name.length) best = { name: nm, url: url };
      }
    }
    return best;
  }
  // The post's own permalink: the first /permalink/<id>/ or
  // /posts/<id>/ link in the element that is not a comment link
  // (no comment_id) and not inside a nested comment article.
  function postPermalink(el) {
    var links = el.querySelectorAll('a[href]');
    for (var pi = 0; pi < links.length; pi++) {
      var a = links[pi];
      var n = a.parentElement;
      var inArticle = false;
      while (n && n !== el) {
        if (n.getAttribute && n.getAttribute('role') === 'article') { inArticle = true; break; }
        n = n.parentElement;
      }
      if (inArticle) continue;
      var href = a.getAttribute('href') || '';
      if (/comment_id/i.test(href)) continue;
      if (!/(?:\/permalink\/|\/posts\/)\d+/.test(href)) continue;
      var abs = href.charAt(0) === '/' ? 'https://www.facebook.com' + href : href;
      if (!/^https?:\/\//i.test(abs)) continue;
      return abs.split('?')[0].split('#')[0];
    }
    return null;
  }
  // Is the current page a single post (permalink / posts URL)? Its
  // normalized URL, or null.
  function pagePostUrl() {
    var href = (typeof window !== 'undefined' && window.location && window.location.href) || '';
    if (!/\/(permalink|posts)\/\d+/.test(href)) return null;
    return href.split('?')[0].split('#')[0].replace(/\/+$/, '');
  }
  // On a single-post page, keep only the post the page opened (the
  // user opened ONE post to scrape it). Everywhere else (group/page
  // feed) keep all posts.
  function onlyPagePost(posts) {
    var page = pagePostUrl();
    if (!page) return posts;
    var kept = posts.filter(function (p) {
      return p.postUrl && p.postUrl.replace(/\/+$/, '') === page;
    });
    if (kept.length) return kept;
    return posts.length ? [posts[0]] : posts;
  }
  // The article's accessible name (aria-label). Facebook names comment
  // articles "Comment by X ..." and reply articles
  // "Reply by X to Y's comment ...". That is the ONLY reliable signal
  // separating a reply from a top-level comment, because both share
  // the same article role and the same Like/React/Downvote/Reply
  // buttons, and replies are flat siblings, not nested.
  // Returns { kind: 'comment'|'reply'|'unknown', author: string|null,
  // parent: string|null }.
  // The accessible name can carry a trailing timestamp
  // ("Comment by Sharpeiq 5 days ago") — strip it so the name is
  // just the name.
  function stripTimestamp(name) {
    return (name || '')
      .replace(/\s+\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago\s*$/i, '')
      .replace(/\s+\d+[smhdw]\s*$/i, '')
      .replace(/\s+(Yesterday|Just now)\s*$/i, '').trim();
  }
  function articleKind(art) {
    var label = '';
    try { label = art.getAttribute('aria-label') || ''; } catch (e) {}
    label = normApos(label);
    var m = label.match(/^\s*Reply by (.+?) to (.+?)'s comment/i);
    if (m) return { kind: 'reply', author: stripTimestamp(m[1]), parent: stripTimestamp(m[2]) };
    m = label.match(/^\s*Comment by (.+?)(?:\s+·|\s*$)/i);
    if (m) return { kind: 'comment', author: stripTimestamp(m[1]), parent: null };
    return { kind: 'unknown', author: null, parent: null };
  }
  // Timestamp for one comment/reply article. postedAtLabel is the
  // visible relative label ("5d"); postedAt prefers the exact time
  // from the timestamp element's title/description, and falls back
  // to computing from the label against the collection time.
  function timestampForArticle(art, artText, nowMs) {
    var label = '';
    var lines = (artText || '').split('\n').map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
    for (var i = 0; i < Math.min(lines.length, 8); i++) {
      if (isTimestampLabel(lines[i])) { label = lines[i]; break; }
    }
    if (!label) {
      // Fallback: the article's aria-label can carry a trailing
      // timestamp ("Comment by Sharpeiq 5 days ago").
      var al = '';
      try { al = art.getAttribute('aria-label') || ''; } catch (e) {}
      var m = /\s(\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago|\d+[smhdw]|Yesterday|Just now)\s*$/i.exec(al);
      if (m) label = m[1];
    }
    var exact = exactTimestampFromArticle(art);
    var postedAt = exact || (label ? postedAtFromLabel(label, nowMs) : null);
    return { postedAt: postedAt, postedAtLabel: label };
  }
  // Build the comment/reply tree from a list of article elements in
  // DOM order. A reply attaches to the most recent preceding node
  // (comment or reply) whose author matches the "to Y's comment" in
  // its aria-label; if no match, to the most recent top-level comment.
  // Articles with no usable aria-label are treated as top-level
  // comments (safe fallback — they are still captured, just not nested).
  function buildCommentTree(articles) {
    var roots = [];
    var flat = []; // all nodes in DOM order, for parent lookup
    var nowMs = Date.now(); // one collection instant for the label fallback
    for (var i = 0; i < articles.length; i++) {
      var art = articles[i];
      var author = firstProfileLink(art);
      if (!author) {
        var kind0 = articleKind(art);
        if (kind0.author) author = { name: kind0.author, url: null };
      }
      if (!author) continue;
      var artText = ownText(art);
      var ctext = cleanCommentText(artText, author.name);
      if (!ctext) continue;
      var kind = articleKind(art);
      var ts = timestampForArticle(art, artText, nowMs);
      var node = { author: author, text: ctext, postedAt: ts.postedAt, postedAtLabel: ts.postedAtLabel, replies: [] };
      if (kind.kind === 'reply') {
        var parent = null;
        for (var j = flat.length - 1; j >= 0; j--) {
          if (flat[j].author.name === kind.parent) { parent = flat[j]; break; }
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
  // Clean the post text taken from a dialog's own text: drop the author
  // name, the header "Follow" word, a leading timestamp, and the
  // action-bar chrome (Comment/Share/React labels and bare counts).
  // Hashtags are part of the post and are kept.
  //
  // The header is line-based in innerText: a group-name line, then the
  // author + timestamp line, then the real text. So this works on
  // LINES: everything up to and including the line that held the
  // author name is header and goes; a following leading line that is
  // header chrome (group name + timestamp) goes too. Facebook
  // obfuscates timestamps by putting a combining mark (U+034F) after
  // every character — any token carrying a combining mark is timestamp
  // junk, never real post text, and is dropped.
  function cleanPostText(raw, authorName) {
    var rawLines = (raw || '').split('\n').map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
    // Index of the first line holding the author name (the header line).
    var anchor = -1;
    if (authorName) {
      for (var ai = 0; ai < rawLines.length; ai++) {
        if (rawLines[ai].indexOf(authorName) !== -1) { anchor = ai; break; }
      }
    }
    var lines = rawLines.map(function (s) {
      var t = normApos(s);
      if (authorName && t.indexOf(authorName) !== -1) t = t.split(authorName).join(' ');
      t = t.replace(/'s post\b/g, ' ');
      t = t.replace(/\bFollow\b/g, ' ');
      // Drop combining-mark tokens (obfuscated timestamp runs).
      t = t.split(/\s+/).filter(function (tok) { return !/[\u0300-\u036f]/.test(tok); }).join(' ');
      return t.replace(/\s+/g, ' ').trim();
    });
    var out = lines.slice();
    if (anchor >= 0) {
      // Keep real text that follows the timestamp on the header line
      // itself (after its last "·"), if any — the post text sometimes
      // shares the header line.
      var tail = '';
      var parts = (out[anchor] || '').split('·');
      if (parts.length > 1) {
        var lastPart = parts[parts.length - 1].trim();
        if (lastPart && !isTimestampLike(lastPart)) tail = lastPart;
      }
      out = out.slice(anchor + 1);
      if (tail) out.unshift(tail);
    }
    // Drop leading header-chrome lines (e.g. "Stock Market Traders ·
    // 5d"): a line carrying "·" plus a timestamp token.
    while (out.length > 1) {
      var first = out[0];
      if (first.indexOf('·') !== -1 && hasTimestampToken(first)) { out.shift(); continue; }
      break;
    }
    // Drop chrome lines anywhere in the text: a bare timestamp line,
    // the repeated Facebook wordmark, "View N replies" toggles, the
    // "Most relevant" sort label, and the comment composer line.
    // Also collapse runs of 2+ consecutive "Facebook" words.
    var joined = out.join('\n');
    joined = joined.replace(/(?:Facebook\s+){2,}/gi, ' ');
    var kept = joined.split('\n').map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; })
      .filter(function (s) {
        if (isTimestampLike(s)) return false;
        if (/^Facebook$/i.test(s)) return false;
        if (/^View \d+ repl(?:y|ies)$/i.test(s)) return false;
        if (/^Most relevant$/i.test(s)) return false;
        if (/^Comment as /i.test(s)) return false;
        return true;
      });
    // Drop trailing action-bar chrome lines.
    while (kept.length > 1) {
      var last = kept[kept.length - 1];
      if (/^(Comment|Share|React|Like|Most relevant|See who reacted.*|View .* replies?)$/i.test(last) ||
          /^\d+(\.\d+)?[KM]?$/.test(last)) {
        kept.pop();
      } else break;
    }
    return kept.join(' ').replace(/\s+/g, ' ').trim();
  }
  // Is this whole string a timestamp ("5d", "Monday 18 May 2026 at
  // 01:14", "Yesterday at 21:02")? parseExactTimestamp only matches a
  // line that IS a timestamp, so real text is never mistaken for one.
  function isTimestampLike(s) {
    var t = (s || '').trim();
    if (!t) return true;
    if (isTimestampLabel(t)) return true;
    if (parseExactTimestamp(t)) return true;
    if (/^\d{1,2}:\d{2}$/.test(t)) return true;
    return false;
  }
  // Does this line carry a timestamp token ("5d", "25w", a full date)?
  function hasTimestampToken(line) {
    var toks = (line || '').split(/\s+/);
    for (var ti = 0; ti < toks.length; ti++) {
      var tok = toks[ti].replace(/[·,]/g, '').trim();
      if (!tok) continue;
      if (isTimestampLabel(tok) || parseExactTimestamp(tok)) return true;
    }
    var flat = (line || '').replace(/·/g, ' ').replace(/\s+/g, ' ').trim();
    if (parseExactTimestamp(flat)) return true;
    if (/\b(Yesterday|Today) at \d{1,2}:\d{2}\b/i.test(line)) return true;
    return false;
  }

  var posts = [];

  // --- 1. Single-post modal: the post is a dialog, not an article. ---
  var dialogs = document.querySelectorAll('div[role="dialog"]');
  for (var di = 0; di < dialogs.length; di++) {
    var dlg = dialogs[di];
    var dlgText = (dlg.innerText || '');
    // The post dialog's heading is "<Author>'s post".
    if (!/'s post/i.test(dlgText)) continue;
    // The post author comes from the "<Name>'s post" heading, NOT
    // from the first profile link in the dialog — that link may belong
    // to a commenter (an Anonymous participant post has no author
    // link at all, so firstProfileLink would return a commenter's
    // link and misattribute the whole post).
    var author = null;
    var hm = normApos(dlg.innerText || '').match(/^\s*(.+?)'s post\b/im);
    var headingName = hm ? hm[1].trim() : null;
    if (headingName) {
      // Reconcile the heading name with the author link: the link
      // text is the full display name even when the heading is
      // first-name-only (and vice versa).
      author = authorLinkIn(dlg, headingName);
      if (!author) author = { name: headingName, url: null };
      else if (author.name.length < headingName.length &&
               headingName.toLowerCase().indexOf(author.name.toLowerCase()) === 0) {
        author = { name: headingName, url: author.url };
      }
    }
    if (!author) author = firstProfileLink(dlg);
    if (!author) continue;
    var postText = cleanPostText(ownText(dlg), author.name);
    var articles = dlg.querySelectorAll('div[role="article"]');
    posts.push({
      author: author,
      text: postText,
      postUrl: postPermalink(dlg) || window.location.href,
      comments: buildCommentTree(articles)
    });
    return posts;
  }

  // --- 2. Feed: posts found by their Comment button. ---
  // In the group feed the posts are NOT div[role="article"] (those
  // are the comments), so the article fallback finds nothing and the
  // extension downloads only the flat .txt. Each post has exactly one
  // Comment button whose aria-label is "Comment on <Author>'s post,
  // N comments" — the author name comes from that label, and the post
  // container is the ancestor holding the post text + its comments.
  var btns = document.querySelectorAll('[aria-label]');
  var seenBtns = new Set();
  var seenPosts = new Set();
  var seenUrls = new Set();
  for (var bi = 0; bi < btns.length; bi++) {
    var lab = normApos(btns[bi].getAttribute('aria-label') || '');
    var cm = lab.match(/Comment on (.+?)'s post(?:,|\s|$)/i);
    if (!cm) continue;
    var btn = btns[bi];
    if (seenBtns.has(btn)) continue;
    seenBtns.add(btn);
    var authorName = cm[1].trim();
    var container = null;
    var anc = btn.parentElement;
    for (var d = 0; d < 6 && anc; d++) {
      var t = ownText(anc);
      if (t && t.length > 40 && t.indexOf(authorName) !== -1) { container = anc; break; }
      anc = anc.parentElement;
    }
    if (!container) container = btn.parentElement;
    if (!container) continue;
    // Reconcile the button name with the author link: the link text
    // is the full display name even when the button label is
    // first-name-only (and vice versa).
    var author = authorLinkIn(container, authorName);
    if (!author) author = { name: authorName, url: null };
    else if (author.name.length < authorName.length &&
             authorName.toLowerCase().indexOf(author.name.toLowerCase()) === 0) {
      author = { name: authorName, url: author.url };
    }
    var postText = cleanPostText(ownText(container), author.name);
    var key = author.name + '|' + (postText || '').slice(0, 80);
    if (seenPosts.has(key)) continue;
    seenPosts.add(key);
    var arts = container.querySelectorAll('div[role="article"]');
    var postUrl = postPermalink(container) || pagePostUrl() || null;
    // Two containers for the same permalink are the same post.
    if (postUrl && seenUrls.has(postUrl)) continue;
    if (postUrl) seenUrls.add(postUrl);
    posts.push({ author: author, text: postText, postUrl: postUrl, comments: buildCommentTree(arts) });
  }
  if (posts.length) return onlyPagePost(posts);

  // --- 3. Fallback: main feed. Posts are top-level articles. ---
  // A top-level article with NO "Reply" line in its own text is a post;
  // one with a Reply line (or nested inside another article) is a
  // comment. Comments attach to the most recent preceding post.
  var allArticles = document.querySelectorAll('div[role="article"]');
  var currentPost = null;
  var currentArticles = [];
  function isCommentArticle(art) {
    var own = ownText(art);
    var lines = own.split('\n');
    for (var i = 0; i < lines.length; i++) {
      if (/^Reply(\s+\d+(\.\d+)?[KM]?)?\s*$/i.test(lines[i].trim())) return true;
    }
    var anc = art.parentElement;
    while (anc) {
      if (anc.getAttribute && anc.getAttribute('role') === 'article') return true;
      anc = anc.parentElement;
    }
    return false;
  }
  for (var ai = 0; ai < allArticles.length; ai++) {
    var art = allArticles[ai];
    var author = firstProfileLink(art);
    if (!author) continue;
    var isComment = currentPost ? isCommentArticle(art) : false;
    if (!isComment) {
      if (currentPost) {
        currentPost.comments = buildCommentTree(currentArticles);
      }
      var postText = ownText(art);
      if (postText.indexOf(author.name) !== -1) {
        postText = postText.split(author.name).join(' ');
      }
      postText = postText.replace(/\bFollow\b/g, ' ');
      postText = postText.replace(/^\s*(\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago|\d+[smhdw]|Yesterday at [^ ]+ [^ ]+|Just now)\s*/i, ' ');
      postText = postText.replace(/\s+/g, ' ').trim();
      currentPost = { author: author, text: postText, postUrl: postPermalink(art) || window.location.href, comments: [] };
      posts.push(currentPost);
      currentArticles = [];
    } else {
      currentArticles.push(art);
    }
  }
  if (currentPost) {
    currentPost.comments = buildCommentTree(currentArticles);
  }
  return onlyPagePost(posts);
}

// Render the structured posts as a readable text file (the format the
// user asked for: Post, then Comments, then Replies, each with name +
// profile link). Returns a string.
function renderStructuredText(posts) {
  var out = [];
  posts.forEach(function (p, pi) {
    out.push('POST ' + (pi + 1));
    out.push('Author: ' + p.author.name + (p.author.url ? ' — ' + p.author.url : ''));
    if (p.text) out.push('Post: ' + p.text);
    out.push('');
    function renderComment(c, depth) {
      var indent = '  '.repeat(depth);
      var label = depth === 0 ? 'Comment' : 'Reply';
      out.push(indent + label + ' by ' + c.author.name + (c.postedAtLabel ? ' · ' + c.postedAtLabel : '') + (c.author.url ? ' — ' + c.author.url : ''));
      out.push(indent + label + ': ' + c.text);
      c.replies.forEach(function (r) { renderComment(r, depth + 1); });
    }
    p.comments.forEach(function (c) {
      renderComment(c, 0);
      out.push('');
    });
    out.push('---');
    out.push('');
  });
  return out.join('\n');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { extractStructuredPosts: extractStructuredPosts, renderStructuredText: renderStructuredText, postedAtFromLabel: postedAtFromLabel, parseExactTimestamp: parseExactTimestamp, isTimestampLabel: isTimestampLabel };
}
