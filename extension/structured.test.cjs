// Tests for the 6 defects found live on the Stock Market Traders
// group (2026-11-13): duplicate postUrl, cut author name, junk post
// text, leading date in comment text, missing post-author URL, and
// the extension opening other posts while scraping one.
//
// structured.js is a classic browser script (not a module), so this
// test copies it to a temp .cjs file and requires that — byte-identical
// code, just a different extension so Node treats it as CommonJS.
// A minimal mock DOM stands in for the browser; the fixtures replicate
// the user's real collected JSON (Barbara Hendry "Sell all AI?" and
// Grania Thomas "$7K off $287...") line for line.
// Run: node --test extension/structured.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmpFile = path.join(os.tmpdir(), `structured-under-test-${process.pid}.cjs`);
fs.copyFileSync(path.join(__dirname, "structured.js"), tmpFile);
const { extractStructuredPosts } = require(tmpFile);

// --- minimal mock DOM -------------------------------------------------
function queryAll(root, selector) {
  const out = [];
  const parts = selector.split(",").map((s) => s.trim()).filter(Boolean);
  function matches(el, simple) {
    const m = /^([A-Za-z0-9]*)?(?:\[([^\]=]+)(?:="([^"]*)")?\])?$/.exec(simple);
    if (!m) return false;
    if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
    if (m[2]) {
      const v = el.getAttribute ? el.getAttribute(m[2]) : null;
      if (v === null || v === undefined) return false;
      if (m[3] !== undefined && v !== m[3]) return false;
    }
    return true;
  }
  function walk(el) {
    for (const ch of el.children || []) {
      for (const p of parts) {
        if (matches(ch, p)) { out.push(ch); break; }
      }
      walk(ch);
    }
  }
  walk(root);
  return out;
}

function makeEl(tag, opts) {
  opts = opts || {};
  const el = {
    tagName: (tag || "div").toUpperCase(),
    children: [],
    parentElement: null,
    attributes: {},
    innerText: opts.text || "",
    textContent: opts.text || "",
    getAttribute(name) {
      return this.attributes[name] !== undefined ? this.attributes[name] : null;
    },
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    querySelectorAll(sel) { return queryAll(this, sel); },
  };
  if (opts.attrs) {
    for (const k of Object.keys(opts.attrs)) el.attributes[k] = opts.attrs[k];
  }
  if (opts.href) el.attributes.href = opts.href;
  return el;
}

function link(href, text) {
  const a = makeEl("a", { href, text });
  return a;
}

// Obfuscated timestamp run, as Facebook renders it: every character
// followed by a combining mark (U+034F).
const GARBLE = [..."sptdoSroen30u65a"].map((c) => c + "\u034F").join(" ");

const BARBARA_URL = "https://www.facebook.com/groups/833569380896239/permalink/2028585034727995/";
const GRANIA_URL = "https://www.facebook.com/groups/833569380896239/permalink/2028585034727996/";
const FEED_URL = "https://www.facebook.com/groups/833569380896239/";

const BARBARA_COMMENT_TEXT =
  "I would sell a covered call of AXTI, just for the love of the game ( and the extra profit) " +
  "If the strike Isn't reach . repeat next week . I hope it isn't a bad decision";
const GRANIA_POST_TEXT =
  "$7K off $287 on $650 call on QQQ Made 7k on Friday. Should have been more but got scared " +
  "and had to take the profit lol. Win is a win! Was literally my first week of trading options " +
  "and I got lucky and caught the momentum. Man I needed that!";

function commentArticle(authorName, authorHref, dateLine, label, body, extraChildren) {
  const art = makeEl("div", {
    attrs: { role: "article", "aria-label": `Comment by ${authorName}` },
    text: `${authorName}\n${dateLine}\n${label}\n${body}\nLike\nReply`,
  });
  art.appendChild(link(authorHref, authorName));
  const leaf = makeEl("a", { text: label });
  leaf.attributes.title = dateLine;
  art.appendChild(leaf);
  (extraChildren || []).forEach((c) => art.appendChild(c));
  return art;
}

function replyArticle(authorName, authorHref, dateLine, label, body, parentName) {
  const art = makeEl("div", {
    attrs: { role: "article", "aria-label": `Reply by ${authorName} to ${parentName}'s comment` },
    text: `${authorName}\n${dateLine}\n${label}\n${body}\nLike\nReply`,
  });
  art.appendChild(link(authorHref, authorName));
  const leaf = makeEl("a", { text: label });
  leaf.attributes.title = dateLine;
  art.appendChild(leaf);
  return art;
}

// One feed post container, as Facebook renders it on the group feed:
// header links, action bar with the Comment button, then the comments.
function postContainer(opts) {
  const container = makeEl("div");
  container.appendChild(link(opts.authorHref, opts.authorName));
  container.appendChild(link(opts.permalink, opts.label));
  const bar = makeEl("div", { text: "Like\nComment\nShare" });
  const btn = makeEl("span", {
    attrs: { role: "button", "aria-label": opts.buttonLabel },
    text: "Comment",
  });
  bar.appendChild(btn);
  container.appendChild(bar);
  let articlesText = "";
  for (const art of opts.articles) {
    container.appendChild(art);
    articlesText += art.innerText + "\n";
  }
  container.innerText =
    `Stock Market Traders.\n${opts.authorName} · ${GARBLE}\n${opts.postText}\nLike\nComment\nShare\n` +
    articlesText;
  return container;
}

function feedDoc(buttonLabelOverride) {
  const body = makeEl("body");
  const barbaraComment = commentArticle(
    "Darrin S Shoup",
    "/profile.php?id=100068240045147",
    "Monday 18 May 2026 at 01:14",
    "25w",
    BARBARA_COMMENT_TEXT,
  );
  const barbara = postContainer({
    authorName: "Barbara Hendry",
    authorHref: "/groups/833569380896239/user/100068240045147/",
    permalink: "/groups/833569380896239/permalink/2028585034727995/",
    label: "25w",
    postText: "Sell all AI?",
    buttonLabel: buttonLabelOverride || "Comment on Barbara Hendry's post, 17 comments",
    articles: [barbaraComment],
  });
  const johnComment = commentArticle(
    "John L Harris",
    "/profile.php?id=100040390746991",
    "Thursday 23 April 2026 at 01:04",
    "29w",
    "Did you open it on the 16th?",
  );
  const graniaReply = replyArticle(
    "Grania Thomas",
    "/profile.php?id=100051599016794",
    "Thursday 23 April 2026 at 01:16",
    "29w",
    "John L Harris Opened on the 13, 7 day contract.",
    "John L Harris",
  );
  const grania = postContainer({
    authorName: "Grania Thomas",
    authorHref: "/groups/833569380896239/user/100051599016794/",
    permalink: "/groups/833569380896239/permalink/2028585034727996/",
    label: "29w",
    postText: GRANIA_POST_TEXT,
    buttonLabel: "Comment on Grania Thomas's post, 8 comments",
    articles: [johnComment, graniaReply],
  });
  body.appendChild(barbara);
  body.appendChild(grania);
  return body;
}

function setDoc(body, href) {
  global.document = {
    body,
    querySelectorAll: (sel) => queryAll(body, sel),
    getElementById: () => null,
  };
  global.window = { location: { href } };
}

test("feed: two posts get DIFFERENT own permalinks (defect 1)", () => {
  setDoc(feedDoc(), FEED_URL);
  const posts = extractStructuredPosts();
  assert.equal(posts.length, 2);
  assert.equal(posts[0].postUrl, BARBARA_URL);
  assert.equal(posts[1].postUrl, GRANIA_URL);
});

test("feed: full author names + URLs, clean post text (defects 2, 3, 5)", () => {
  setDoc(feedDoc(), FEED_URL);
  const posts = extractStructuredPosts();
  assert.equal(posts[0].author.name, "Barbara Hendry");
  assert.equal(posts[0].author.url, "https://www.facebook.com/profile.php?id=100068240045147");
  assert.equal(posts[0].text, "Sell all AI?");
  assert.equal(posts[1].author.name, "Grania Thomas");
  assert.equal(posts[1].author.url, "https://www.facebook.com/profile.php?id=100051599016794");
  assert.equal(posts[1].text, GRANIA_POST_TEXT);
  for (const p of posts) {
    assert.ok(!p.text.includes("Hendry"), "no surname leak");
    assert.ok(!p.text.includes("Thomas"), "no surname leak");
    assert.ok(!p.text.includes("Stock Market Traders"));
    assert.ok(!/[\u0300-\u036f]/.test(p.text), "no combining-mark junk");
  }
});

test("comments: leading date lines stripped, real comment first (defect 4)", () => {
  setDoc(feedDoc(), FEED_URL);
  const posts = extractStructuredPosts();
  const c = posts[0].comments[0];
  assert.equal(c.author.name, "Darrin S Shoup");
  assert.equal(c.author.url, "https://www.facebook.com/profile.php?id=100068240045147");
  assert.equal(c.text, BARBARA_COMMENT_TEXT);
  assert.ok(!c.text.includes("Monday"), "no date line");
  assert.ok(!c.text.includes("25w"), "no relative label");
  assert.equal(c.postedAtLabel, "25w");
  assert.ok(c.postedAt && /^\d{4}-\d{2}-\d{2}T/.test(c.postedAt), "exact time present");
});

test("replies nest under their parent comment", () => {
  setDoc(feedDoc(), FEED_URL);
  const posts = extractStructuredPosts();
  const john = posts[1].comments.find((c) => c.author.name === "John L Harris");
  assert.ok(john, "John L Harris comment found");
  assert.equal(john.replies.length, 1);
  assert.equal(john.replies[0].author.name, "Grania Thomas");
  assert.equal(john.replies[0].text, "John L Harris Opened on the 13, 7 day contract.");
});

test("first-name-only button label still yields full name + URL (defect 2)", () => {
  setDoc(feedDoc("Comment on Barbara's post, 17 comments"), FEED_URL);
  const posts = extractStructuredPosts();
  const barbara = posts.find((p) => p.postUrl === BARBARA_URL);
  assert.ok(barbara, "Barbara post found");
  assert.equal(barbara.author.name, "Barbara Hendry");
  assert.equal(barbara.author.url, "https://www.facebook.com/profile.php?id=100068240045147");
  assert.equal(barbara.text, "Sell all AI?");
});

test("curly-apostrophe button label still matches (defect 2)", () => {
  setDoc(feedDoc("Comment on Barbara Hendry’s post, 17 comments"), FEED_URL);
  const posts = extractStructuredPosts();
  const barbara = posts.find((p) => p.postUrl === BARBARA_URL);
  assert.ok(barbara, "Barbara post found with curly apostrophe label");
  assert.equal(barbara.author.name, "Barbara Hendry");
});

test("single-post page: only the opened post is collected (defect 6)", () => {
  setDoc(feedDoc(), BARBARA_URL);
  const posts = extractStructuredPosts();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].postUrl, BARBARA_URL);
  assert.equal(posts[0].author.name, "Barbara Hendry");
});

test("dialog: single post, full name + URL + clean text", () => {
  const body = makeEl("body");
  const dlg = makeEl("div", {
    attrs: { role: "dialog" },
    text:
      "Barbara Hendry's post\nBarbara Hendry · 5d\nSell all AI?\nLike\nComment\nShare\n" +
      "Darrin S Shoup\nMonday 18 May 2026 at 01:14\n25w\n" + BARBARA_COMMENT_TEXT + "\nLike\nReply",
  });
  dlg.appendChild(link("/groups/833569380896239/user/100068240045147/", "Barbara Hendry"));
  dlg.appendChild(link("/groups/833569380896239/permalink/2028585034727995/", "5d"));
  const art = commentArticle(
    "Darrin S Shoup",
    "/profile.php?id=100068240045147",
    "Monday 18 May 2026 at 01:14",
    "25w",
    BARBARA_COMMENT_TEXT,
  );
  dlg.appendChild(art);
  body.appendChild(dlg);
  setDoc(body, FEED_URL);
  const posts = extractStructuredPosts();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].author.name, "Barbara Hendry");
  assert.equal(posts[0].author.url, "https://www.facebook.com/profile.php?id=100068240045147");
  assert.equal(posts[0].text, "Sell all AI?");
  assert.equal(posts[0].postUrl, BARBARA_URL);
  assert.equal(posts[0].comments[0].text, BARBARA_COMMENT_TEXT);
});

test("content.js: no auto-clicking anywhere (defect 6, updated rule)", () => {
  const src = fs.readFileSync(path.join(__dirname, "content.js"), "utf8");
  assert.ok(!/expandReplies/.test(src), "expandReplies is gone");
  assert.ok(!/expandPass/.test(src), "no stop-time expand passes");
  // The old code clicked page buttons via el.click(); the only click
  // left is a.click() on a synthetic download anchor in downloadFile.
  assert.ok(!/el\.click\(\)/.test(src), "no page-button clicking");
  assert.ok(!/querySelectorAll\('\[role="button"\], button'/.test(src), "no button scan");
  assert.ok(
    /setInterval\(\(\) => \{ if \(running\) \{ extractStructured\(\); \} \}, 10000\)/.test(src),
    "10s interval only re-scans what is loaded",
  );
});
