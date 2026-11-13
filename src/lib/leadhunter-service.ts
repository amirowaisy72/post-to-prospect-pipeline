/**
 * LeadHunter data service — every business rule lives here as a pure function
 * over AppState. The React store (src/lib/store.tsx) only calls these.
 * When the backend arrives, swap these for REST calls with the same signatures.
 */
import type {
  Account,
  AccountStatus,
  Activity,
  ActivityType,
  AppState,
  ChatDelivery,
  ChatMessage,
  ChatMessageRole,
  ChatScript,
  ChatThread,
  ChatThreadStatus,
  Comment,
  InboxSourceType,
  Lead,
  LeadPriority,
  LeadStatus,
  Person,
  PostData,
  Settings,
  Source,
} from "./types";

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** Compare Facebook URLs regardless of protocol, www./m. prefix, case or trailing slash. */
export function normalizeUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^(www\.|m\.|web\.)/, "")
    .replace(/\/+$/, "");
}

export const sameUrl = (a: string, b: string) => normalizeUrl(a) === normalizeUrl(b);

function activity(
  type: ActivityType,
  accountId: string,
  message: string,
  id: string,
  at: string,
): Activity {
  return { id, type, accountId, message, at };
}

function withActivity(state: AppState, entry: Activity): AppState {
  return { ...state, activity: [entry, ...state.activity].slice(0, 100) };
}

/** Append one activity entry (newest first, capped at 100). */
export function logActivity(
  state: AppState,
  type: ActivityType,
  accountId: string,
  message: string,
  id: string,
  at: string,
): AppState {
  return withActivity(state, activity(type, accountId, message, id, at));
}

export const accountName = (state: AppState, id: string | null | undefined) =>
  state.accounts.find((a) => a.id === id)?.name ?? "Unknown account";

/* ---------------- Accounts ---------------- */

export function createAccount(
  state: AppState,
  input: { name: string; facebookName: string; facebookCreatedAt?: string | null },
  id: string,
  now: string,
): Result<AppState> {
  const name = input.name.trim();
  const facebookName = input.facebookName.trim();
  if (!name || !facebookName) return { ok: false, error: "Name and Facebook name are required." };
  const facebookCreatedAt = (input.facebookCreatedAt ?? "").trim() || null;
  if (facebookCreatedAt && !/^\d{4}-\d{2}-\d{2}$/.test(facebookCreatedAt)) {
    return { ok: false, error: "Facebook created date must be YYYY-MM-DD." };
  }
  if (state.accounts.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: `An account named "${name}" already exists.` };
  }
  const account: Account = { id, name, facebookName, status: "active", createdAt: now, facebookCreatedAt };
  // The first account becomes the active and default account, so the
  // app never sits on a blank selection after the user starts.
  const isFirst = state.accounts.length === 0;
  const next = {
    ...state,
    accounts: [...state.accounts, account],
    activeAccountId: isFirst ? id : state.activeAccountId,
    defaultAccountId: isFirst ? id : state.defaultAccountId,
  };
  return {
    ok: true,
    value: withActivity(
      next,
      activity("account-created", id, `Created account ${name}`, `act-${id}`, now),
    ),
  };
}

export function setAccountStatus(state: AppState, id: string, status: AccountStatus): AppState {
  return {
    ...state,
    accounts: state.accounts.map((a) => (a.id === id ? { ...a, status } : a)),
  };
}

/**
 * Set (or clear) the Facebook account's own created date for one
 * existing account. The daily chat cap reads this date at once
 * (dailyChatLimit), so saving an old date lifts a 0/day cap
 * immediately. Empty clears it back to the date the account was
 * added here in LeadHunter.
 */
export function setFacebookCreatedAt(
  state: AppState,
  id: string,
  facebookCreatedAt: string | null,
): Result<AppState> {
  const account = state.accounts.find((a) => a.id === id);
  if (!account) return { ok: false, error: "Account not found." };
  const clean = (facebookCreatedAt ?? "").trim() || null;
  if (clean && !/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    return { ok: false, error: "Facebook created date must be YYYY-MM-DD." };
  }
  if (account.facebookCreatedAt === clean) return { ok: true, value: state };
  return {
    ok: true,
    value: {
      ...state,
      accounts: state.accounts.map((a) =>
        a.id === id ? { ...a, facebookCreatedAt: clean } : a,
      ),
    },
  };
}

/* ---------------- Sources ---------------- */

export interface AddSourceInput {
  id: string;
  name: string;
  /** Pasted Facebook link — with or without the https:// prefix. */
  url: string;
  memberCount: number;
}

/**
 * Add one source by hand (name, Facebook link, member count). The
 * type is derived from the link: a /groups/ path is a Group,
 * anything else is a Page. A URL already joined by ANY account is
 * rejected with "Already joined by <account>" (the no-duplication
 * rule) — the add is blocked, nothing is overwritten.
 */
export function addSource(
  state: AppState,
  input: AddSourceInput,
  accountId: string,
  now: string,
): Result<AppState> {
  if (!state.accounts.some((a) => a.id === accountId)) {
    return { ok: false, error: "Account not found." };
  }
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Enter the page or group name." };
  const raw = input.url.trim();
  if (!raw) return { ok: false, error: "Enter the Facebook link." };
  let parsed: URL;
  try {
    parsed = new URL(/:\/\//.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { ok: false, error: "Enter a valid Facebook link." };
  }
  if (!parsed.hostname.toLowerCase().endsWith("facebook.com")) {
    return { ok: false, error: "The link must be a facebook.com URL." };
  }
  if (!Number.isInteger(input.memberCount) || input.memberCount < 0) {
    return { ok: false, error: "Members must be a whole number, 0 or more." };
  }
  const url = parsed.toString();
  const twin = state.sources.find((s) => !!s.url && sameUrl(s.url, url));
  if (twin) {
    return { ok: false, error: `Already joined by ${accountName(state, twin.joinedByAccountId)}.` };
  }
  const source: Source = {
    id: input.id,
    name,
    type: parsed.pathname.includes("/groups/") ? "group" : "page",
    url,
    quantity: null,
    memberCount: input.memberCount,
    status: "joined",
    joinedByAccountId: accountId,
    lastScrapedAt: null,
  };
  return {
    ok: true,
    value: withActivity(
      { ...state, sources: [...state.sources, source] },
      activity("source-added", accountId, `Added source ${name}`, `act-add-${input.id}`, now),
    ),
  };
}

/**
 * Remove a source from EVERYWHERE in LeadHunter: the Sources list,
 * its collected posts, and any leads derived from those posts. This
 * is local-only — it does NOT leave the group or unfollow the page
 * on Facebook; the user does that by hand on Facebook if needed.
 */
export function deleteSource(state: AppState, sourceId: string, now: string): Result<AppState> {
  const source = state.sources.find((s) => s.id === sourceId);
  if (!source) return { ok: false, error: "Source not found." };
  const postIds = new Set(state.posts.filter((p) => p.sourceId === sourceId).map((p) => p.id));
  const next: AppState = {
    ...state,
    sources: state.sources.filter((s) => s.id !== sourceId),
    posts: state.posts.filter((p) => p.sourceId !== sourceId),
    leads: state.leads.filter((l) => !postIds.has(l.sourcePostId)),
  };
  return {
    ok: true,
    value: withActivity(
      next,
      activity(
        "source-deleted",
        source.joinedByAccountId ?? "",
        `Deleted ${source.name} — removed it from LeadHunter and its posts`,
        `act-del-${sourceId}-${now}`,
        now,
      ),
    ),
  };
}

/* ---------------- Post data ---------------- */

export const countReplies = (post: Pick<PostData, "comments">) =>
  post.comments.reduce((n, c) => n + c.replies.length, 0);

export function findCollectedPost(state: AppState, postUrl: string) {
  return state.posts.find((p) => sameUrl(p.postUrl, postUrl));
}

export interface PostDraft {
  postUrl: string;
  author: Person;
  text: string;
  comments: Comment[];
  sourceId: string | null;
}

/** Unvalidated JSON shape: every field optional and unknown until checked. */
interface Loose {
  name?: unknown;
  url?: unknown;
  postUrl?: unknown;
  text?: unknown;
  author?: unknown;
  comments?: unknown;
  replies?: unknown;
  sourceId?: unknown;
  posts?: unknown;
  postedAt?: unknown;
  postedAtLabel?: unknown;
}

export interface PostImportResult {
  /** Drafts that parsed cleanly and are ready to save. */
  drafts: PostDraft[];
  /** One entry per post that failed to parse: which post, and why. */
  errors: { label: string; reason: string }[];
  /** Posts whose URL was already collected (by any account). */
  alreadyCollected: { postUrl: string; accountName: string }[];
}

function readPerson(value: unknown, path: string, errors: string[]): Person | null {
  if (!value || typeof value !== "object") {
    errors.push(`${path} must be an object with "name" and "url".`);
    return null;
  }
  const v = value as Loose;
  if (typeof v.name !== "string" || !v.name.trim()) errors.push(`${path}.name is required.`);
  // Anonymous participants have no profile link: a null / missing url is
  // accepted as "" (they can never become leads — see analysePosts).
  if (v.url !== null && v.url !== undefined && typeof v.url !== "string") {
    errors.push(`${path}.url must be a string or null.`);
  }
  if (typeof v.name !== "string") return null;
  return { name: v.name.trim(), url: typeof v.url === "string" ? v.url.trim() : "" };
}

/** Timestamps: postedAt is an ISO string when present, else null;
 * postedAtLabel is the visible relative label ("5d"), else "".
 * Older files without them parse fine — both default. */
function readPostedAt(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function readPostedAtLabel(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Validate one PostData object. `label` identifies the post in errors. */
function parseOnePost(
  value: unknown,
  label: string,
  state: AppState,
): {
  draft: PostDraft | null;
  errors: string[];
  alreadyCollected: { postUrl: string; accountName: string } | null;
} {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      draft: null,
      errors: [`${label}: expected a PostData object.`],
      alreadyCollected: null,
    };
  }
  const o = value as Loose;
  if (typeof o.postUrl !== "string" || !o.postUrl.trim()) errors.push("postUrl is required.");
  if (typeof o.text !== "string") errors.push("text is required.");
  const author = readPerson(o.author, "author", errors);

  const comments: Comment[] = [];
  if (!Array.isArray(o.comments)) {
    errors.push("comments must be an array (use [] for none).");
  } else {
    o.comments.forEach((c, i) => {
      if (!c || typeof c !== "object") {
        errors.push(`comments[${i}] must be an object.`);
        return;
      }
      const cc = c as Loose;
      const cAuthor = readPerson(cc.author, `comments[${i}].author`, errors);
      if (typeof cc.text !== "string") errors.push(`comments[${i}].text is required.`);
      const replies: Comment["replies"] = [];
      if (cc.replies !== undefined && !Array.isArray(cc.replies)) {
        errors.push(`comments[${i}].replies must be an array.`);
      } else if (Array.isArray(cc.replies)) {
        cc.replies.forEach((r, j) => {
          const rr = (r ?? {}) as Loose;
          const rAuthor = readPerson(rr.author, `comments[${i}].replies[${j}].author`, errors);
          if (typeof rr.text !== "string")
            errors.push(`comments[${i}].replies[${j}].text is required.`);
          if (rAuthor && typeof rr.text === "string")
            replies.push({
              author: rAuthor,
              text: rr.text,
              postedAt: readPostedAt(rr.postedAt),
              postedAtLabel: readPostedAtLabel(rr.postedAtLabel),
            });
        });
      }
      if (cAuthor && typeof cc.text === "string")
        comments.push({
          author: cAuthor,
          text: cc.text,
          postedAt: readPostedAt(cc.postedAt),
          postedAtLabel: readPostedAtLabel(cc.postedAtLabel),
          replies,
        });
    });
  }

  const sourceId =
    typeof o.sourceId === "string" && state.sources.some((s) => s.id === o.sourceId)
      ? o.sourceId
      : null;

  const postUrl = typeof o.postUrl === "string" ? o.postUrl.trim() : "";
  const existing = postUrl ? findCollectedPost(state, postUrl) : undefined;
  const alreadyCollected = existing
    ? { postUrl: existing.postUrl, accountName: accountName(state, existing.accountId) }
    : null;

  const draft =
    errors.length === 0 && author
      ? { postUrl, author, text: String(o.text), comments, sourceId }
      : null;

  return { draft, errors, alreadyCollected };
}

/**
 * Validate pasted / uploaded PostData JSON. Nothing is saved here.
 * Accepts all three shapes the collector produces:
 * (a) a single PostData object, (b) {"posts": [...]}, (c) a bare array.
 * With options.allowExisting, already-collected URLs are returned as
 * drafts instead of being reported (Sync re-imports known posts to
 * merge new activity into them).
 */
export function parsePostDataJson(
  raw: string,
  state: AppState,
  options?: { allowExisting?: boolean },
): PostImportResult {
  const result: PostImportResult = { drafts: [], errors: [], alreadyCollected: [] };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    result.errors.push({ label: "File", reason: `Invalid JSON: ${(e as Error).message}` });
    return result;
  }
  let items: unknown[];
  let labelFor: (i: number, item: unknown) => string;
  if (Array.isArray(json)) {
    items = json;
    labelFor = (i, item) => postLabel(item, i);
  } else if (json && typeof json === "object" && Array.isArray((json as Loose).posts)) {
    items = (json as Loose).posts as unknown[];
    labelFor = (i, item) => postLabel(item, i);
  } else if (json && typeof json === "object") {
    items = [json];
    labelFor = (_i, item) => postLabel(item, 0);
  } else {
    result.errors.push({
      label: "File",
      reason: 'Expected a PostData object, a {"posts": [...]} wrapper, or an array of posts.',
    });
    return result;
  }
  items.forEach((item, i) => {
    const label = labelFor(i, item);
    const parsed = parseOnePost(item, label, state);
    if (parsed.draft && (!parsed.alreadyCollected || options?.allowExisting))
      result.drafts.push(parsed.draft);
    if (parsed.alreadyCollected && !options?.allowExisting)
      result.alreadyCollected.push(parsed.alreadyCollected);
    for (const e of parsed.errors) result.errors.push({ label, reason: e });
  });
  return result;
}

/** Human label for one post in the import preview: its URL, else "Post N". */
function postLabel(item: unknown, index: number): string {
  const url = (item as Loose)?.postUrl;
  return typeof url === "string" && url.trim() ? url.trim() : `Post ${index + 1}`;
}

export function addPost(
  state: AppState,
  draft: PostDraft,
  sourceId: string,
  accountId: string,
  id: string,
  now: string,
): Result<AppState> {
  if (findCollectedPost(state, draft.postUrl)) return { ok: false, error: "Already collected" };
  const source = state.sources.find((s) => s.id === sourceId);
  if (!source) return { ok: false, error: "Pick a source for this post." };
  if (source.joinedByAccountId !== accountId) {
    return { ok: false, error: "This account must join the source before collecting from it." };
  }
  const post: PostData = {
    id,
    sourceId,
    accountId,
    postUrl: draft.postUrl,
    author: draft.author,
    text: draft.text,
    comments: draft.comments,
    collectedAt: now,
    lastSyncedAt: null,
  };
  const next: AppState = {
    ...state,
    posts: [post, ...state.posts],
    sources: state.sources.map((s) => (s.id === sourceId ? { ...s, lastScrapedAt: now } : s)),
  };
  return {
    ok: true,
    value: withActivity(
      next,
      activity(
        "post-collected",
        accountId,
        `Collected a post from ${source.name}`,
        `act-${id}`,
        now,
      ),
    ),
  };
}

export interface AddPostsResult {
  added: number;
  skipped: number;
  alreadyCollected: { postUrl: string; accountName: string }[];
}

/**
 * Import several parsed drafts for one source in a single call.
 * Posts already collected (by any account, or twice in this batch) are
 * skipped and reported instead of saved.
 */
export function addPosts(
  state: AppState,
  drafts: PostDraft[],
  sourceId: string,
  accountId: string,
  makeId: () => string,
  now: string,
): { state: AppState } & AddPostsResult {
  let next = state;
  let added = 0;
  let skipped = 0;
  const alreadyCollected: AddPostsResult["alreadyCollected"] = [];
  for (const draft of drafts) {
    const existing = findCollectedPost(next, draft.postUrl);
    if (existing) {
      skipped++;
      alreadyCollected.push({
        postUrl: existing.postUrl,
        accountName: accountName(next, existing.accountId),
      });
      continue;
    }
    const r = addPost(next, draft, sourceId, accountId, makeId(), now);
    if (!r.ok) {
      skipped++;
      continue;
    }
    next = r.value;
    added++;
  }
  return { state: next, added, skipped, alreadyCollected };
}

/* ---------------- Data Sourcing v2: titles, counts, sync merge, jobs ---------------- */

/** Display title for a scraped post: first ~60 chars of its text, one line. */
export function postTitle(post: { text: string }): string {
  const single = post.text.replace(/\s+/g, " ").trim();
  return single.length > 60 ? `${single.slice(0, 60)}…` : single;
}

export function postsForSource(state: AppState, sourceId: string): PostData[] {
  return state.posts.filter((p) => p.sourceId === sourceId);
}

/** Number of collected posts for one source (the "Scraped" column). */
export function scrapedCount(state: AppState, sourceId: string): number {
  return postsForSource(state, sourceId).length;
}

const activityKey = (authorName: string, text: string) =>
  `${authorName.trim().toLowerCase()}\n${text.trim()}`;

/**
 * Merge a freshly re-scraped post into the stored one (Sync).
 * New comments/replies (dedupe by author + text) are appended;
 * already-known ones are never duplicated. The post text is updated
 * when the author edited it. lastSyncedAt is always set to now — a
 * sync re-visited the post even when nothing new was found.
 */
export function mergePostActivity(
  state: AppState,
  postId: string,
  incoming: PostDraft,
  now: string,
): { state: AppState; addedComments: number; addedReplies: number; changed: boolean } {
  const idx = state.posts.findIndex((p) => p.id === postId);
  if (idx === -1) return { state, addedComments: 0, addedReplies: 0, changed: false };
  const post = state.posts[idx]!;
  let addedComments = 0;
  let addedReplies = 0;
  const comments = post.comments.map((c) => ({ ...c, replies: [...c.replies] }));
  for (const inc of incoming.comments) {
    const key = activityKey(inc.author.name, inc.text);
    const existing = comments.find((c) => activityKey(c.author.name, c.text) === key);
    if (!existing) {
      comments.push({ ...inc, replies: inc.replies.map((r) => ({ ...r })) });
      addedComments += 1;
      addedReplies += inc.replies.length;
      continue;
    }
    for (const r of inc.replies) {
      const rkey = activityKey(r.author.name, r.text);
      if (!existing.replies.some((er) => activityKey(er.author.name, er.text) === rkey)) {
        existing.replies.push({ ...r });
        addedReplies += 1;
      }
    }
  }
  const textChanged = incoming.text.trim() !== "" && incoming.text !== post.text;
  const changed = addedComments > 0 || addedReplies > 0 || textChanged;
  const next: PostData = {
    ...post,
    text: textChanged ? incoming.text : post.text,
    comments,
    lastSyncedAt: now,
  };
  const posts = [...state.posts];
  posts[idx] = next;
  return { state: { ...state, posts }, addedComments, addedReplies, changed };
}

/* ---------------- Source last-scraped stamp ---------------- */

/**
 * Mark a source as scraped just now. A completed run
 * re-visited the source even when it found nothing new, so the
 * "Last scraped" column must advance — otherwise the row keeps
 * showing an old failure after a run that actually finished.
 */
export function markSourceScraped(
  state: AppState,
  sourceId: string,
  now: string,
): { state: AppState } {
  return {
    state: {
      ...state,
      sources: state.sources.map((s) => (s.id === sourceId ? { ...s, lastScrapedAt: now } : s)),
    },
  };
}

/* ---------------- Analysis (simulated AI) ---------------- */

const REJECT_PATTERNS = [
  "telegram",
  "t.me/",
  "whatsapp",
  "signals",
  "dm me for",
  "inbox me",
  "course",
  "% off",
  "join now",
  "join my",
  "guaranteed",
  "tips",
];
const WEALTH_PATTERNS = [
  "crore",
  "lakh",
  "million",
  "aed",
  "sold a plot",
  "sold my",
  "business",
  "villa",
  "apartments",
  "rental income",
  "cash reserve",
  "extra cash",
  "savings",
  "export",
  "pharmacies",
  "chain of",
  "salons",
  "factory",
  "units",
];
const BEGINNER_PATTERNS = [
  "new to",
  "never invested",
  "beginner",
  "first time",
  "where do i",
  "where to start",
  "how do i start",
  "no idea",
  "want to learn",
  "just starting",
];
const EXPERIENCED_PATTERNS = [
  "been investing",
  "portfolio",
  "already invest",
  "already flipped",
  "mutual funds",
  "dividend",
  "held ",
  "holding",
  "since 20",
];

const matches = (text: string, patterns: string[]) => {
  const t = text.toLowerCase();
  return patterns.filter((p) => t.includes(p));
};

export type Classification =
  | { kind: "lead"; priority: LeadPriority; reason: string }
  | { kind: "reject"; reason: string }
  | { kind: "none" };

/** Simulated AI judgement of one comment, following the lead criteria. */
export function classifyComment(text: string): Classification {
  const reject = matches(text, REJECT_PATTERNS);
  if (reject.length) {
    return {
      kind: "reject",
      reason: `Matches reject criteria (“${reject.slice(0, 2).join("”, “")}”).`,
    };
  }
  const wealth = matches(text, WEALTH_PATTERNS);
  const beginner = matches(text, BEGINNER_PATTERNS);
  const experienced = matches(text, EXPERIENCED_PATTERNS);
  const years = text.match(/\b\d+\s+years\b/i);
  if (years) experienced.push(years[0].toLowerCase());
  const q = (list: string[]) =>
    `“${list
      .slice(0, 3)
      .map((s) => s.trim())
      .join("”, “")}”`;

  if (wealth.length && experienced.length) {
    return {
      kind: "lead",
      priority: "rich-experienced",
      reason: `Already investing (${q(experienced)}) and shows wealth (${q(wealth)}).`,
    };
  }
  if (wealth.length && beginner.length) {
    return {
      kind: "lead",
      priority: "rich-beginner",
      reason: `New to investing (${q(beginner)}) and shows wealth (${q(wealth)}).`,
    };
  }
  if (beginner.length || experienced.length) {
    return {
      kind: "lead",
      priority: "other",
      reason: `Shows interest in investing (${q([...beginner, ...experienced])}) but no clear sign of wealth.`,
    };
  }
  return { kind: "none" };
}

export interface AnalysisResult {
  found: Lead[];
  duplicates: { name: string; profileUrl: string; existing: Lead }[];
  rejected: { name: string; profileUrl: string; reason: string; text: string }[];
}

/** Run the simulated analysis over posts. Leads are de-duplicated by profile URL. */
export function analysePosts(
  state: AppState,
  postIds: string[],
  accountId: string,
  makeId: () => string,
): AnalysisResult {
  const result: AnalysisResult = { found: [], duplicates: [], rejected: [] };
  const seen = new Set<string>();
  const posts = state.posts.filter((p) => postIds.includes(p.id) && p.accountId === accountId);

  for (const post of posts) {
    const voices = post.comments.flatMap((c) => [
      { author: c.author, text: c.text },
      ...c.replies.map((r) => ({ author: r.author, text: r.text })),
    ]);
    for (const v of voices) {
      // Anonymous commenters have no profile link and can never become leads.
      if (!v.author.url.trim()) continue;
      // Post authors are discussion starters, not leads.
      if (sameUrl(v.author.url, post.author.url)) continue;
      const key = normalizeUrl(v.author.url);
      if (seen.has(key)) continue;
      const verdict = classifyComment(v.text);
      if (verdict.kind === "none") continue;
      seen.add(key);
      if (verdict.kind === "reject") {
        result.rejected.push({
          name: v.author.name,
          profileUrl: v.author.url,
          reason: verdict.reason,
          text: v.text,
        });
        continue;
      }
      const existing = state.leads.find((l) => sameUrl(l.profileUrl, v.author.url));
      if (existing) {
        result.duplicates.push({ name: v.author.name, profileUrl: v.author.url, existing });
        continue;
      }
      result.found.push({
        id: makeId(),
        name: v.author.name,
        profileUrl: v.author.url,
        priority: verdict.priority,
        reason: verdict.reason,
        quotedComment: v.text,
        sourcePostId: post.id,
        accountId,
        status: "new",
      });
    }
  }
  return result;
}

/** Save leads, skipping anyone whose profile URL is already in Leads. */
export function addLeads(
  state: AppState,
  leads: Lead[],
  accountId: string,
  postCount: number,
  now: string,
): { state: AppState; added: number; skipped: number } {
  const accepted: Lead[] = [];
  for (const lead of leads) {
    const dup =
      state.leads.some((l) => sameUrl(l.profileUrl, lead.profileUrl)) ||
      accepted.some((l) => sameUrl(l.profileUrl, lead.profileUrl));
    if (!dup) accepted.push(lead);
  }
  const next = withActivity(
    { ...state, leads: [...accepted, ...state.leads] },
    activity(
      "analysis-finished",
      accountId,
      `Analysis finished on ${postCount} post${postCount === 1 ? "" : "s"} — ${accepted.length} lead${accepted.length === 1 ? "" : "s"} found`,
      `act-analysis-${now}`,
      now,
    ),
  );
  return { state: next, added: accepted.length, skipped: leads.length - accepted.length };
}

export function setLeadStatus(
  state: AppState,
  leadId: string,
  status: LeadStatus,
  now: string,
): AppState {
  const lead = state.leads.find((l) => l.id === leadId);
  if (!lead) return state;
  const next = {
    ...state,
    leads: state.leads.map((l) => (l.id === leadId ? { ...l, status } : l)),
  };
  if (status === "shortlisted")
    return withActivity(
      next,
      activity(
        "lead-shortlisted",
        lead.accountId,
        `Shortlisted ${lead.name}`,
        `act-${leadId}-${now}`,
        now,
      ),
    );
  if (status === "rejected")
    return withActivity(
      next,
      activity(
        "lead-rejected",
        lead.accountId,
        `Rejected ${lead.name}`,
        `act-${leadId}-${now}`,
        now,
      ),
    );
  return next;
}

/* ---------------- Read helpers ---------------- */

export function accountStats(state: AppState, accountId: string) {
  const leads = state.leads.filter((l) => l.accountId === accountId);
  return {
    sources: state.sources.filter((s) => s.joinedByAccountId === accountId).length,
    posts: state.posts.filter((p) => p.accountId === accountId).length,
    leads: leads.length,
    shortlisted: leads.filter((l) => l.status === "shortlisted").length,
  };
}

export function totals(state: AppState) {
  return {
    accounts: state.accounts.length,
    sources: state.sources.length,
    posts: state.posts.length,
    leads: state.leads.length,
    shortlisted: state.leads.filter((l) => l.status === "shortlisted").length,
  };
}

// ---------------------------------------------------------------------------
// Configurations
// ---------------------------------------------------------------------------

type Partial2<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };

/** Fill any missing fields (e.g. from data saved by an older version) with defaults. */
export function mergeSettings(
  defaults: Settings,
  saved: Partial2<Settings> | null | undefined,
): Settings {
  if (!saved || typeof saved !== "object") return defaults;
  return {
    ...defaults,
    ...saved,
    criteria: { ...defaults.criteria, ...saved.criteria },
    leadRules: { ...defaults.leadRules, ...saved.leadRules },
    sourcing: { ...defaults.sourcing, ...saved.sourcing },
    database: { ...defaults.database, ...saved.database },
  } as Settings;
}

const isWhole = (n: number, min: number) => Number.isInteger(n) && n >= min;
const isHttpUrl = (v: string) => {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

/** Check configurations before saving. Text fields are trimmed. */
export function validateSettings(input: Settings): Result<Settings> {
  const s: Settings = {
    ...input,
    model: input.model.trim(),
    ollamaUrl: input.ollamaUrl.trim().replace(/\/+$/, ""),
    geminiApiKey: input.geminiApiKey.trim(),
    agentUrl: input.agentUrl.trim().replace(/\/+$/, ""),
    database: {
      ...input.database,
      supabaseUrl: input.database.supabaseUrl.trim().replace(/\/+$/, ""),
      supabaseKey: input.database.supabaseKey.trim(),
      connectionString: input.database.connectionString.trim(),
    },
  };
  if (!s.model) return { ok: false, error: "Enter a model name." };
  if (!isHttpUrl(s.ollamaUrl))
    return { ok: false, error: "Ollama server URL must start with http:// or https://." };
  if (!isHttpUrl(s.agentUrl))
    return { ok: false, error: "Chat agent URL must start with http:// or https://." };
  const { defaultLeadsCount, preferredMinAge, gentleMinAge } = s.leadRules;
  if (!isWhole(defaultLeadsCount, 1))
    return { ok: false, error: "Default leads count must be a whole number, 1 or more." };
  if (!isWhole(gentleMinAge, 1) || !isWhole(preferredMinAge, 1))
    return { ok: false, error: "Ages must be whole numbers, 1 or more." };
  if (gentleMinAge > preferredMinAge)
    return {
      ok: false,
      error: "The gentle age must be lower than or equal to the full-match age.",
    };
  if (!isWhole(s.sourcing.minComments, 0))
    return { ok: false, error: "Min comments must be a whole number, 0 or more." };
  if (!isWhole(s.sourcing.minMembers, 0))
    return { ok: false, error: "Min members must be a whole number, 0 or more." };
  if (
    s.database.kind === "supabase" &&
    s.database.supabaseUrl &&
    !s.database.supabaseUrl.startsWith("https://")
  )
    return { ok: false, error: "Supabase URL must start with https://." };
  if (
    s.database.kind === "connection-string" &&
    s.database.connectionString &&
    !/^postgres(ql)?:\/\//i.test(s.database.connectionString)
  )
    return { ok: false, error: "Connection string must start with postgres:// or postgresql://." };
  return { ok: true, value: s };
}

/** How the age rule treats a person: full match, gentle match, or reject. */
export function ageVerdict(
  age: number,
  rules: Settings["leadRules"],
): "match" | "gentle" | "reject" {
  if (age >= rules.preferredMinAge) return "match";
  if (age >= rules.gentleMinAge) return "gentle";
  return "reject";
}

/** Whether a group/page meets the sourcing rules for joining. */
export function meetsSourcingRules(
  stats: { comments: number; members: number },
  rules: Settings["sourcing"],
): boolean {
  return stats.comments >= rules.minComments && stats.members >= rules.minMembers;
}

// ---------------------------------------------------------------------------
// Inbox — DM chats with shortlisted candidates (v1: in-app only)
// ---------------------------------------------------------------------------

/**
 * Default chat script. The user has not provided the real script text
 * yet — this is a sensible starting point they can edit in the Inbox
 * tab. Goal: convince the client and finally push them.
 */
export const DEFAULT_CHAT_SCRIPT: ChatScript = {
  firstMessageTemplate:
    "Hi {name}! I read your {sourceKind} where you said “{sourceText}”. {introduction}",
  introduction:
    "I'm Amir — I help people take their first steps in investing safely, with a simple plan and no pressure. Would love to hear what you're aiming for.",
  tone: "Friendly and short. Warm, personal, never pushy. One idea per message — no long paragraphs.",
  rules: [
    "Always reference their exact comment or post first — never open cold.",
    "Never promise guaranteed returns or a fixed profit.",
    "Never ask for money, passwords, or account access.",
    "If they say no or stop replying, thank them and stop — do not chase.",
    "Keep every message under 3 short sentences.",
  ].join("\n"),
  goal: "Convince the client that a simple, safe first step in investing is worth taking, and finally push them to book a short introductory call.",
};

/** Fill any missing script fields (e.g. from data saved by an older version) with defaults. */
export function mergeChatScript(saved: Partial<ChatScript> | null | undefined): ChatScript {
  return { ...DEFAULT_CHAT_SCRIPT, ...(saved ?? {}) };
}

/** A Facebook profile link: facebook.com host with a profile path. */
export function isFacebookProfileUrl(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  let parsed: URL;
  try {
    parsed = new URL(/:\/\//.test(value) ? value : `https://${value}`);
  } catch {
    return false;
  }
  if (!parsed.hostname.toLowerCase().endsWith("facebook.com")) return false;
  // A profile link has a path beyond "/": /someone, /profile.php?id=…,
  // /groups/… is a group, not a person — those are not chats.
  const path = parsed.pathname.replace(/\/+$/, "");
  if (!path || path === "/") return false;
  if (path.startsWith("/groups/") || path.startsWith("/events/") || path.startsWith("/pages/"))
    return false;
  return true;
}

export interface CreateThreadInput {
  id: string;
  profileUrl: string;
  profileName: string;
  sourceType: InboxSourceType;
  sourceText: string;
  sourceUrl: string;
  shortlistNote: string;
  /** Delivery of the composed first message. Default "in-app" (a draft
   * only); the store passes "pending-messenger" when it hands the
   * message to the chat agent. */
  firstMessageDelivery?: ChatDelivery;
}

export interface CreateThreadResult {
  state: AppState;
  thread: ChatThread;
  firstMessage: ChatMessage;
}

function fillTemplate(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (out, [key, value]) => out.split(`{${key}}`).join(value),
    template,
  );
}

/**
 * Compose the agent's first message for a thread from the current
 * script: the template references their comment/post, then the
 * introduction. Pure — no sending, no network.
 */
export function composeFirstMessage(script: ChatScript, thread: ChatThread): string {
  const sourceKind = thread.sourceType === "comment" ? "comment" : "post";
  const sourceText =
    thread.sourceText.length > 160 ? `${thread.sourceText.slice(0, 160)}…` : thread.sourceText;
  return fillTemplate(script.firstMessageTemplate, {
    name: thread.profileName,
    sourceKind,
    sourceText,
    introduction: script.introduction,
  }).trim();
}

/**
 * Start a new chat thread. Validates the profile link (must look like
 * a Facebook profile URL) and blocks a second active thread for the
 * same profile — one conversation per person. The agent's first
 * message is composed from the script; its delivery is "in-app" by
 * default (a draft only) and "pending-messenger" when the store
 * hands it to the chat agent — the poll then reports "sent" or
 * "failed" against the same message id.
 */
export function createChatThread(
  state: AppState,
  input: CreateThreadInput,
  accountId: string,
  messageId: string,
  now: string,
): Result<CreateThreadResult> {
  if (!state.accounts.some((a) => a.id === accountId)) {
    return { ok: false, error: "Account not found." };
  }
  const profileUrl = input.profileUrl.trim();
  if (!isFacebookProfileUrl(profileUrl)) {
    return {
      ok: false,
      error: "Enter a Facebook profile link, e.g. https://www.facebook.com/someone",
    };
  }
  const profileName = input.profileName.trim();
  if (!profileName) return { ok: false, error: "Enter the person's name." };
  const sourceText = input.sourceText.trim();
  if (!sourceText) {
    return { ok: false, error: "Paste the comment or post this person was shortlisted from." };
  }
  const sourceUrl = input.sourceUrl.trim();
  if (sourceUrl) {
    let parsed: URL;
    try {
      parsed = new URL(/:\/\//.test(sourceUrl) ? sourceUrl : `https://${sourceUrl}`);
    } catch {
      return { ok: false, error: "The source link must be a valid URL." };
    }
    if (!parsed.hostname.toLowerCase().endsWith("facebook.com")) {
      return { ok: false, error: "The source link must be a facebook.com URL." };
    }
  }
  const existing = state.threads.find(
    (t) => t.accountId === accountId && sameUrl(t.profileUrl, profileUrl) && t.status === "active",
  );
  if (existing) {
    return { ok: false, error: `There is already an active chat with ${existing.profileName}.` };
  }
  const thread: ChatThread = {
    id: input.id,
    accountId,
    profileUrl,
    profileName,
    sourceType: input.sourceType,
    sourceText,
    sourceUrl,
    shortlistNote: input.shortlistNote.trim(),
    status: "active",
    createdAt: now,
  };
  const firstMessage: ChatMessage = {
    id: messageId,
    threadId: thread.id,
    role: "agent",
    text: composeFirstMessage(state.chatScript, thread),
    createdAt: now,
    delivery: input.firstMessageDelivery ?? "in-app",
  };
  const next: AppState = {
    ...state,
    threads: [thread, ...state.threads],
    chatMessages: [firstMessage, ...state.chatMessages],
  };
  return {
    ok: true,
    value: {
      state: withActivity(
        next,
        activity(
          "chat-started",
          accountId,
          `Started a chat with ${profileName}`,
          `act-${thread.id}`,
          now,
        ),
      ),
      thread,
      firstMessage,
    },
  };
}

/**
 * Append one message to a thread. Agent messages are stored with
 * delivery "in-app" unless the caller explicitly passes
 * "pending-messenger" — nothing in v1 may pass that: there is no
 * live Messenger delivery yet, and a message must never be shown as
 * sent to Facebook when it was not.
 */
export function addChatMessage(
  state: AppState,
  input: { threadId: string; role: ChatMessageRole; text: string; id: string; now: string },
): Result<AppState> {
  const thread = state.threads.find((t) => t.id === input.threadId);
  if (!thread) return { ok: false, error: "Chat not found." };
  const text = input.text.trim();
  if (!text) return { ok: false, error: "Message is empty." };
  const message: ChatMessage = {
    id: input.id,
    threadId: input.threadId,
    role: input.role,
    text,
    createdAt: input.now,
    delivery: "in-app",
  };
  const next: AppState = { ...state, chatMessages: [...state.chatMessages, message] };
  return {
    ok: true,
    value:
      input.role === "candidate"
        ? withActivity(
          next,
          activity(
            "chat-reply",
            thread.accountId,
            `${thread.profileName} replied`,
            `act-${input.id}`,
            input.now,
          ),
        )
        : next,
  };
}

export function setThreadStatus(
  state: AppState,
  threadId: string,
  status: ChatThreadStatus,
): AppState {
  const thread = state.threads.find((t) => t.id === threadId);
  if (!thread) return state;
  return {
    ...state,
    threads: state.threads.map((t) => (t.id === threadId ? { ...t, status } : t)),
  };
}

/**
 * Delete a chat thread from LeadHunter: the thread and ALL its
 * messages go. This is local-only — it never touches Facebook; a
 * message already sent on Messenger stays sent. Deleting frees the
 * profile: a New chat with the same person is allowed again (the
 * one-active-chat-per-profile rule only blocks threads that still
 * exist). The agent is told separately (POST /chat/forget) so it
 * drops the thread from its watch list and rows too.
 */
export function deleteChatThread(
  state: AppState,
  threadId: string,
  now: string,
): Result<AppState> {
  const thread = state.threads.find((t) => t.id === threadId);
  if (!thread) return { ok: false, error: "Chat not found." };
  const next: AppState = {
    ...state,
    threads: state.threads.filter((t) => t.id !== threadId),
    chatMessages: state.chatMessages.filter((m) => m.threadId !== threadId),
  };
  return {
    ok: true,
    value: withActivity(
      next,
      activity(
        "chat-deleted",
        thread.accountId,
        `Deleted the chat with ${thread.profileName} — removed it from LeadHunter only`,
        `act-del-${threadId}-${now}`,
        now,
      ),
    ),
  };
}

/** Validate and save the editable chat script. */
export function updateChatScript(state: AppState, script: ChatScript): Result<AppState> {
  const next: ChatScript = {
    firstMessageTemplate: script.firstMessageTemplate.trim(),
    introduction: script.introduction.trim(),
    tone: script.tone.trim(),
    rules: script.rules.trim(),
    goal: script.goal.trim(),
  };
  if (!next.firstMessageTemplate)
    return { ok: false, error: "The first-message template cannot be empty." };
  if (
    !next.firstMessageTemplate.includes("{name}") &&
    !next.firstMessageTemplate.includes("{sourceText}")
  ) {
    return {
      ok: false,
      error:
        "The first-message template should use {name} or {sourceText} so it references what they said.",
    };
  }
  if (!next.goal)
    return {
      ok: false,
      error: "The goal cannot be empty — the agent needs to know what it is pushing for.",
    };
  return { ok: true, value: { ...state, chatScript: next } };
}

/** All messages of one thread, oldest first. */
export function messagesForThread(state: AppState, threadId: string): ChatMessage[] {
  return state.chatMessages
    .filter((m) => m.threadId === threadId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * The thread's first message, when it is still unsent — an in-app
 * draft the agent never received, or a send the agent reported as
 * failed. The retry action re-sends exactly this message: never a
 * later message, and never one already sent or in flight.
 */
export function firstUnsentMessage(state: AppState, threadId: string): ChatMessage | null {
  const first = messagesForThread(state, threadId)[0];
  if (!first || first.role !== "agent") return null;
  return first.delivery === "in-app" || first.delivery === "failed" ? first : null;
}

/** Threads for one account, newest first. */
export function threadsForAccount(state: AppState, accountId: string): ChatThread[] {
  return state.threads
    .filter((t) => t.accountId === accountId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Max outbound chat messages per day for an account, from its age.
 * Age uses the Facebook account's own created date when the user set
 * it, else the date the account was created in LeadHunter (the
 * conservative fallback). Bands match the agent (chat.py):
 * under 3 days 0 (warmup), days 3–7: 12, days 8–14: 25, day 15+: 45.
 */
export function dailyChatLimit(account: Account, now: string): number {
  const base = account.facebookCreatedAt || account.createdAt.slice(0, 10);
  const start = new Date(`${base}T00:00:00.000Z`).getTime();
  const today = new Date(`${now.slice(0, 10)}T00:00:00.000Z`).getTime();
  if (Number.isNaN(start) || Number.isNaN(today)) return 0;
  const ageDays = Math.max(0, Math.floor((today - start) / 86_400_000));
  if (ageDays < 3) return 0;
  if (ageDays <= 7) return 12;
  if (ageDays <= 14) return 25;
  return 45;
}

/** Update one message's delivery (what the agent reported). */
export function markMessageDelivery(
  state: AppState,
  messageId: string,
  delivery: ChatDelivery,
): Result<AppState> {
  const message = state.chatMessages.find((m) => m.id === messageId);
  if (!message) return { ok: false, error: "Message not found." };
  if (message.delivery === delivery) return { ok: true, value: state };
  return {
    ok: true,
    value: {
      ...state,
      chatMessages: state.chatMessages.map((m) =>
        m.id === messageId ? { ...m, delivery } : m,
      ),
    },
  };
}

/** One live thread as the chat agent reports it (GET /chat/threads). */
export interface LiveChatThread {
  threadId: string;
  status: string;
  messengerThreadUrl?: string | null;
  messages: {
    id: string;
    role: ChatMessageRole;
    text: string;
    delivery: ChatDelivery;
    sentAt?: string | null;
    sendStage?: string | null;
    sendStageSince?: string | null;
    sendStageDetail?: string | null;
  }[];
}

/**
 * How long a send has sat at its current stage ("45s", "2m 05s").
 * Null when the stage has no start time.
 */
export function formatStageAge(
  sinceIso: string | null | undefined,
  nowMs: number,
): string | null {
  if (!sinceIso) return null;
  const since = Date.parse(sinceIso);
  if (Number.isNaN(since)) return null;
  const secs = Math.max(0, Math.floor((nowMs - since) / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;
}

const stageDisplay = (stage: string) =>
  stage.charAt(0).toUpperCase() + stage.slice(1);

/**
 * Honest per-message delivery label — never claims a send that did
 * not happen. A send in flight shows the agent's live stage plus
 * how long it has sat there ("Agent: Opening chat… · 45s"); a
 * failed send shows the agent's plain reason. "Sending to
 * Messenger…" is only the initial state before the first stage
 * arrives from the agent.
 */
export function sendStatusCaption(m: ChatMessage, nowMs: number): string {
  if (m.role === "candidate") {
    return m.delivery === "received" ? "Reply from Messenger" : "Reply recorded in-app";
  }
  switch (m.delivery) {
    case "sent":
      return "Sent to Messenger";
    case "failed":
      return m.sendStageDetail
        ? `Failed — ${m.sendStageDetail}`
        : "Failed to send to Messenger";
    case "pending-messenger": {
      if (m.sendStage) {
        const age = formatStageAge(m.sendStageSince, nowMs);
        return age
          ? `Agent: ${stageDisplay(m.sendStage)}… · ${age}`
          : `Agent: ${stageDisplay(m.sendStage)}…`;
      }
      return "Sending to Messenger…";
    }
    default:
      return "Agent draft · In-app only — not sent to Messenger";
  }
}

/**
 * Merge the agent's live thread states into the store. Messages are
 * matched by id: an existing message only ever changes its delivery
 * (pending → sent / failed) and its send-stage trail, and unknown
 * ids are appended — but only for threads that exist in this app (an
 * agent row the user deleted here is ignored). Returns the unchanged
 * state reference when nothing changed, so a quiet poll costs no
 * re-render.
 */
export function mergeLiveThreads(state: AppState, live: LiveChatThread[]): AppState {
  const JUNK = /^(messenger|all chats loaded\.?|notifications|see previous notifications|unread message:.*|messages and calls are secured.*)$/i;
  if (state.chatMessages.some((m) => m.role === "candidate" && JUNK.test(m.text.trim()))) state = { ...state, chatMessages: state.chatMessages.filter((m) => !(m.role === "candidate" && JUNK.test(m.text.trim()))) };
  const byId = new Map(state.chatMessages.map((m) => [m.id, m]));
  let changed = false;
  const next = new Map<string, ChatMessage>();
  for (const m of state.chatMessages) next.set(m.id, m);
  for (const thread of live) {
    if (!state.threads.some((t) => t.id === thread.threadId)) continue;
    for (const lm of thread.messages) {
      const existing = byId.get(lm.id);
      if (existing) {
        // The agent always sends the stage keys (null when a message
        // was never staged, or after an agent restart cleared the
        // in-memory trail) — an explicit null clears a stale stage
        // instead of leaving it on screen with a growing age.
        const stageChanged =
          lm.sendStage !== undefined &&
          (existing.sendStage ?? null) !== (lm.sendStage ?? null);
        const sinceChanged =
          lm.sendStageSince !== undefined &&
          (existing.sendStageSince ?? null) !== (lm.sendStageSince ?? null);
        const detailChanged =
          lm.sendStageDetail !== undefined &&
          (existing.sendStageDetail ?? null) !== (lm.sendStageDetail ?? null);
        if (
          existing.delivery !== lm.delivery ||
          (lm.role === "agent" && !!lm.text && existing.text !== lm.text) ||
          stageChanged ||
          sinceChanged ||
          detailChanged
        ) {
          next.set(lm.id, {
            ...existing,
            text: lm.role === "agent" && lm.text ? lm.text : existing.text,
            delivery: lm.delivery,
            sendStage: lm.sendStage ?? null,
            sendStageSince: lm.sendStageSince ?? null,
            sendStageDetail: lm.sendStageDetail ?? null,
          });
          changed = true;
        }
        continue;
      }
      if (!lm.text.trim() || JUNK.test(lm.text.trim())) continue;
      next.set(lm.id, {
        id: lm.id,
        threadId: thread.threadId,
        role: lm.role,
        text: lm.text,
        createdAt: lm.sentAt || new Date().toISOString(),
        delivery: lm.delivery,
        sendStage: lm.sendStage ?? null,
        sendStageSince: lm.sendStageSince ?? null,
        sendStageDetail: lm.sendStageDetail ?? null,
      });
      changed = true;
    }
  }
  if (!changed) return state;
  return { ...state, chatMessages: [...next.values()] };
}
