// Raw Data Collector — content script (runs in every page).
// You browse manually; a MutationObserver captures every newly revealed
// piece of visible text (posts, comments, replies) inside the rectangle
// you drew, and saves it (URL + time). Nothing is sent anywhere — the
// data stays in chrome.storage.local until you download it.
//
// Flow: popup Start -> this script shows a rectangle overlay on the page
// -> you drag a rectangle (Esc = whole page) -> observer starts.
// Stop -> observer stops and a .txt file downloads automatically.

(() => {
  if (window.__rdcLoaded) return;
  window.__rdcLoaded = true;

  const DATA_KEY = 'rdc_data';     // [{url, time, text, link}]
  const STATE_KEY = 'rdc_state';   // {running, rect}
  const STRUCT_KEY = 'rdc_structured'; // [{author, text, comments:[...]}]
  const OVERLAY_ID = 'rdc-overlay';

  let running = false;
  let rect = null; // {x1,y1,x2,y2} in viewport coords, or null = whole page
  let captured = [];
  let seen = new Set();
  let observer = null;
  let dirty = false;
  let scheduled = false;
  // Structured posts (Facebook articles), accumulated across pages.
  // Keyed by author url + post text so a re-scan never duplicates.
  let structuredPosts = [];
  let structuredSeen = new Set();
  let structuredDirty = false;

  function dedupeKey(t) {
    return t.split(/\s+/).join(' ').toLowerCase();
  }

  function nowStamp() {
    return new Date().toISOString().slice(0, 19);
  }

  function inRect(el) {
    if (!rect) return true;
    try {
      const r = el.getBoundingClientRect();
      return r.bottom > rect.y1 && r.top < rect.y2 &&
             r.right > rect.x1 && r.left < rect.x2;
    } catch (e) { return false; }
  }

  function isVisible(el) {
    try {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (e) { return false; }
  }

  function insideOverlay(el) {
    let n = el;
    while (n) {
      if (n.id === OVERLAY_ID) return true;
      n = n.parentElement;
    }
    return false;
  }

  function linkOf(el) {
    // Nearest ancestor <a> with a real href (the profile link behind a
    // name, the post link behind a title, ...). el.href resolves relative
    // hrefs to absolute URLs. Returns null when there is none.
    let n = el;
    while (n) {
      if (n.tagName === 'A') {
        const raw = n.getAttribute('href');
        if (raw && raw !== '#' && !raw.toLowerCase().startsWith('javascript:')) {
          return n.href;
        }
      }
      n = n.parentElement;
    }
    return null;
  }

  function collect() {
    scheduled = false;
    try {
      if (!document.body) return;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const t = (node.textContent || '').trim();
        if (!t || t.length < 2) continue;
        const el = node.parentElement;
        if (!el || insideOverlay(el)) continue;
        if (!isVisible(el) || !inRect(el)) continue;
        const link = linkOf(el);
        const key = dedupeKey(t) + '|' + (link || '');
        if (seen.has(key)) continue;
        seen.add(key);
        captured.push({ url: location.href, time: nowStamp(), text: t, link: link });
        dirty = true;
      }
    } catch (e) { /* page mid-navigation; ignore */ }
  }

  function scheduleCollect() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(collect, 300);
  }

  function startObserver() {
    stopObserver();
    collect();
    observer = new MutationObserver(scheduleCollect);
    observer.observe(document.body, {
      childList: true, subtree: true, characterData: true
    });
  }

  function stopObserver() {
    if (observer) { try { observer.disconnect(); } catch (e) {} observer = null; }
  }

  function persist() {
    try {
      chrome.storage.local.set({
        [DATA_KEY]: captured,
        [STATE_KEY]: { running: running, rect: rect },
        [STRUCT_KEY]: structuredPosts
      });
    } catch (e) {}
  }

  // -- structured posts (Facebook articles) --------------------------
  // Runs every few seconds while collecting; merges new posts into the
  // accumulated list (dedupe by author + post text). On a non-Facebook
  // page, or when the feed did not render, extractStructuredPosts
  // returns [] and nothing changes — the flat capture still works.
  function extractStructured() {
    if (typeof extractStructuredPosts !== 'function') return;
    try {
      const posts = extractStructuredPosts() || [];
      for (const p of posts) {
        const key = (p.author && p.author.url ? p.author.url : '') + '|' +
          (p.text || '').slice(0, 80);
        if (structuredSeen.has(key)) continue;
        structuredSeen.add(key);
        structuredPosts.push(p);
        structuredDirty = true;
      }
      if (structuredDirty) persist();
    } catch (e) {}
  }

  function downloadFile(name, content, mime) {
    const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function stamp14() {
    return new Date().toISOString().slice(0, 19)
      .replace(/[-:T]/g, '').slice(0, 14);
  }

  function downloadStructured() {
    if (!structuredPosts.length) return false;
    const stamp = stamp14();
    if (typeof renderStructuredText === 'function') {
      downloadFile('raw_data_' + stamp + '_structured.txt',
        renderStructuredText(structuredPosts));
    }
    downloadFile('raw_data_' + stamp + '_structured.json',
      JSON.stringify({ posts: structuredPosts }, null, 2),
      'application/json;charset=utf-8');
    return true;
  }

  function downloadTxt() {
    if (!captured.length) return;
    const stamp = stamp14();
    // A text with a link (e.g. a profile link behind a name) is written
    // as "Name — https://..." on one line; plain text stays as-is.
    const body = captured.map(c => c.link ? (c.text + ' — ' + c.link) : c.text)
      .join('\n\n') + '\n';
    downloadFile('raw_data_' + stamp + '.txt', body);
  }

  // -- rectangle overlay ---------------------------------------------
  function showRectOverlay(onDone) {
    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,0.35);' +
      'z-index:2147483647;cursor:crosshair;';
    const hint = document.createElement('div');
    hint.textContent = 'Drag a rectangle around the area to capture  (Esc = whole page)';
    hint.style.cssText =
      'position:fixed;top:20px;left:50%;transform:translateX(-50%);' +
      'background:#111;color:#fff;padding:8px 16px;border-radius:6px;' +
      'font:600 14px sans-serif;z-index:2147483647;';
    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;border:3px solid red;background:rgba(255,0,0,0.08);' +
      'display:none;z-index:2147483647;pointer-events:none;';
    overlay.appendChild(hint);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    let start = null;
    function finish(r) {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      onDone(r);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
    }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', (e) => {
      start = { x: e.clientX, y: e.clientY };
      box.style.display = 'block';
      box.style.left = start.x + 'px';
      box.style.top = start.y + 'px';
      box.style.width = '0px';
      box.style.height = '0px';
    });
    overlay.addEventListener('mousemove', (e) => {
      if (!start) return;
      const x = Math.min(start.x, e.clientX);
      const y = Math.min(start.y, e.clientY);
      const w = Math.abs(e.clientX - start.x);
      const h = Math.abs(e.clientY - start.y);
      box.style.left = x + 'px';
      box.style.top = y + 'px';
      box.style.width = w + 'px';
      box.style.height = h + 'px';
    });
    overlay.addEventListener('mouseup', (e) => {
      if (!start) return;
      const x1 = Math.min(start.x, e.clientX);
      const y1 = Math.min(start.y, e.clientY);
      const x2 = Math.max(start.x, e.clientX);
      const y2 = Math.max(start.y, e.clientY);
      // A tiny click (no real drag) = whole page.
      const r = (x2 - x1 < 5 || y2 - y1 < 5)
        ? null : { x1: x1, y1: y1, x2: x2, y2: y2 };
      finish(r);
    });
  }

  // -- start / stop ---------------------------------------------------
  function start() {
    if (running) return;
    showRectOverlay((r) => {
      rect = r;
      running = true;
      persist();
      startObserver();
    });
  }

  // Click "View N replies" / "View more comments" / "View more answers"
  // toggles so replies (and further comments) enter the DOM before the
  // structured scan. Replies are collapsed behind these buttons and are
  // not articles until clicked — without this every reply is missed.
  // Capped per pass so one pass cannot click hundreds of toggles; the
  // caller loops passes until a pass clicks nothing.
  function expandReplies() {
    let clicked = 0;
    try {
      const els = document.querySelectorAll('[role="button"], button');
      for (const el of els) {
        if (clicked >= 20) break;
        const t = (el.innerText || '').trim();
        if (/^View \d+ repl(?:y|ies)$/i.test(t) || /^View more comments$/i.test(t) || /^View more answers$/i.test(t)) {
          try { el.click(); clicked++; } catch (e) {}
        }
      }
    } catch (e) {}
    return clicked;
  }

  function stop() {
    stopObserver();
    running = false;
    dirty = false;
    // Completeness (hard rule): expanding replies can reveal further
    // nested "View N replies" buttons, so keep expanding until a full
    // pass clicks nothing (bounded — at most 10 passes), then take the
    // final structured pass after they have had a moment to render.
    let passes = 0;
    function expandPass() {
      passes++;
      const clicked = expandReplies();
      if (clicked > 0 && passes < 10) {
        setTimeout(expandPass, 1200);
        return;
      }
      setTimeout(() => {
        extractStructured();
        persist();
        // Structured files first (the AI-ready format); the flat .txt too
        // when there is flat data but no structured posts (other sites).
        const hadStructured = downloadStructured();
        if (!hadStructured) downloadTxt();
        else if (captured.length) downloadTxt();
      }, 1500);
    }
    expandPass();
  }

  // -- messages from the popup ---------------------------------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'start') { start(); sendResponse({ ok: true }); }
    else if (msg.action === 'stop') {
      stop(); sendResponse({ ok: true, count: captured.length });
    }
    else if (msg.action === 'getStatus') {
      sendResponse({ running: running, count: captured.length });
    }
    else if (msg.action === 'download') {
      const hadStructured = downloadStructured();
      if (!hadStructured) downloadTxt();
      sendResponse({ ok: true, count: captured.length });
    }
    else if (msg.action === 'clear') {
      captured = []; seen = new Set(); dirty = false;
      structuredPosts = []; structuredSeen = new Set(); structuredDirty = false;
      persist();
      sendResponse({ ok: true });
    }
    return true;
  });

  // -- restore state (keeps collecting across page navigation) -------
  try {
    chrome.storage.local.get([DATA_KEY, STATE_KEY, STRUCT_KEY], (res) => {
      if (res && res[DATA_KEY]) {
        captured = res[DATA_KEY];
        captured.forEach(c => { if (c.text) seen.add(dedupeKey(c.text) + '|' + (c.link || '')); });
      }
      if (res && res[STRUCT_KEY]) {
        structuredPosts = res[STRUCT_KEY];
        structuredPosts.forEach(p => {
          structuredSeen.add((p.author && p.author.url ? p.author.url : '') + '|' + (p.text || '').slice(0, 80));
        });
      }
      if (res && res[STATE_KEY] && res[STATE_KEY].running) {
        running = true;
        rect = res[STATE_KEY].rect || null;
        startObserver();
      }
    });
  } catch (e) {}

  // Flush new captures to storage every 2 s; re-scan structured posts
  // every 10 s so newly loaded posts/comments join the collection.
  // Expand collapsed replies on each pass so they enter the DOM too.
  setInterval(() => { if (dirty) { dirty = false; persist(); } }, 2000);
  setInterval(() => { if (running) { expandReplies(); extractStructured(); } }, 10000);
})();
