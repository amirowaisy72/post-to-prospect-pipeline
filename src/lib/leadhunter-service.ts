/**
 * LeadHunter data service — every business rule lives here as a pure function
 * over AppState. The React store (src/lib/store.tsx) only calls these.
 * When the backend arrives, swap these for REST calls with the same signatures.
 */
import type {
  Account,
  AgentState,
  AgentStatus,
  AgentTask,
  AccountStatus,
  Activity,
  ActivityType,
  AppState,
  Comment,
  CollectedSource,
  Lead,
  LeadPriority,
  LeadStatus,
  Person,
  PostData,
  Settings,
  Source,
  SourceJob,
  SourceJobKind,
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
  input: { name: string; facebookName: string },
  id: string,
  now: string,
): Result<AppState> {
  const name = input.name.trim();
  const facebookName = input.facebookName.trim();
  if (!name || !facebookName) return { ok: false, error: "Name and Facebook name are required." };
  if (state.accounts.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: `An account named "${name}" already exists.` };
  }
  const account: Account = { id, name, facebookName, status: "active", createdAt: now };
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
  const next = {
    ...state,
    accounts: state.accounts.map((a) => (a.id === id ? { ...a, status } : a)),
  };
  // A paused or blocked account's agent goes offline, so whatever it was doing stops.
  return status === "active" ? next : finishAgentTask(next, id, new Date().toISOString());
}

/* ---------------- Sources ---------------- */

export interface AddCollectedSourcesResult {
  added: number;
  skipped: number;
}

/**
 * Add sources the agent's collect job joined (groups) or recorded
 * (pages). Sources enter ONLY through the agent — there is no manual
 * add-by-URL path. A source whose URL is already joined by ANY
 * account is skipped (the no-duplication rule); duplicates inside
 * one batch are skipped too. One summary activity entry per batch.
 */
export function addCollectedSources(
  state: AppState,
  sources: CollectedSource[],
  accountId: string,
  now: string,
): { state: AppState } & AddCollectedSourcesResult {
  let next = state;
  let added = 0;
  let skipped = 0;
  const names: string[] = [];
  for (const c of sources) {
    if (!c.url || !c.name) {
      skipped++;
      continue;
    }
    const twin = next.sources.find((s) => !!s.url && sameUrl(s.url, c.url));
    if (twin) {
      skipped++;
      continue;
    }
    const source: Source = {
      id: c.id,
      name: c.name,
      type: c.type,
      url: c.url,
      quantity: null,
      memberCount: c.memberCount ?? 0,
      status: "joined",
      joinedByAccountId: accountId,
      lastScrapedAt: null,
    };
    next = { ...next, sources: [...next.sources, source] };
    added++;
    names.push(c.name);
  }
  if (added > 0) {
    next = withActivity(
      next,
      activity(
        "source-collected",
        accountId,
        `Collected ${added} new source${added === 1 ? "" : "s"} — ${names.slice(0, 3).join(", ")}${names.length > 3 ? "…" : ""}`,
        `act-collect-${now}`,
        now,
      ),
    );
  }
  return { state: next, added, skipped };
}

/**
 * Remove a source from EVERYWHERE: the Sources list, its collected
 * posts, and any leads derived from those posts. Call only after the
 * agent confirmed the group was left (or the page unfollowed) on
 * Facebook — a failed leave must keep the row (see the agent's
 * delete endpoint).
 */
export function deleteSource(
  state: AppState,
  sourceId: string,
  now: string,
): Result<AppState> {
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
        `Deleted ${source.name} — left it on Facebook and removed its posts`,
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
): { draft: PostDraft | null; errors: string[]; alreadyCollected: { postUrl: string; accountName: string } | null } {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { draft: null, errors: [`${label}: expected a PostData object.`], alreadyCollected: null };
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
          if (typeof rr.text !== "string") errors.push(`comments[${i}].replies[${j}].text is required.`);
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
    result.errors.push({ label: "File", reason: "Expected a PostData object, a {\"posts\": [...]} wrapper, or an array of posts." });
    return result;
  }
  items.forEach((item, i) => {
    const label = labelFor(i, item);
    const parsed = parseOnePost(item, label, state);
    if (parsed.draft && (!parsed.alreadyCollected || options?.allowExisting)) result.drafts.push(parsed.draft);
    if (parsed.alreadyCollected && !options?.allowExisting) result.alreadyCollected.push(parsed.alreadyCollected);
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
      activity("post-collected", accountId, `Collected a post from ${source.name}`, `act-${id}`, now),
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
      alreadyCollected.push({ postUrl: existing.postUrl, accountName: accountName(next, existing.accountId) });
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

/* ---------------- Source scrap/sync jobs ---------------- */

export function startSourceJob(
  state: AppState,
  job: {
    id: string;
    kind: SourceJobKind;
    sourceId: string | null;
    postId: string | null;
    accountId: string;
    startedAt: string;
  },
): { state: AppState } {
  const entry: SourceJob = {
    ...job,
    status: "running",
    postsProcessed: 0,
    newPosts: 0,
    finishedAt: null,
    error: null,
    verification: [],
  };
  return { state: { ...state, jobs: [entry, ...state.jobs] } };
}

export function updateSourceJob(
  state: AppState,
  jobId: string,
  patch: Partial<
    Pick<SourceJob, "status" | "postsProcessed" | "newPosts" | "finishedAt" | "error" | "verification" | "result">
  >,
): { state: AppState } {
  return {
    state: { ...state, jobs: state.jobs.map((j) => (j.id === jobId ? { ...j, ...patch } : j)) },
  };
}

/**
 * Graceful stop: marks the job "stop-requested". The agent only ever
 * checks this flag BETWEEN posts — it finishes the current post
 * fully, saves it, then terminates.
 */
export function requestSourceJobStop(state: AppState, jobId: string): { state: AppState } {
  return updateSourceJob(state, jobId, { status: "stop-requested" });
}

const isJobActive = (j: SourceJob) => j.status === "running" || j.status === "stop-requested";

export function runningJobForSource(state: AppState, sourceId: string): SourceJob | undefined {
  return state.jobs.find((j) => j.sourceId === sourceId && isJobActive(j));
}

export function runningJobForPost(state: AppState, postId: string): SourceJob | undefined {
  return state.jobs.find((j) => j.postId === postId && isJobActive(j));
}

/** The running (or stop-requested) backend job for an account, if any. */
export function runningJobForAccount(state: AppState, accountId: string): SourceJob | undefined {
  return state.jobs.find((j) => j.accountId === accountId && isJobActive(j));
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
    return { kind: "reject", reason: `Matches reject criteria (“${reject.slice(0, 2).join("”, “")}”).` };
  }
  const wealth = matches(text, WEALTH_PATTERNS);
  const beginner = matches(text, BEGINNER_PATTERNS);
  const experienced = matches(text, EXPERIENCED_PATTERNS);
  const years = text.match(/\b\d+\s+years\b/i);
  if (years) experienced.push(years[0].toLowerCase());
  const q = (list: string[]) => `“${list.slice(0, 3).map((s) => s.trim()).join("”, “")}”`;

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
        result.rejected.push({ name: v.author.name, profileUrl: v.author.url, reason: verdict.reason, text: v.text });
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
    return withActivity(next, activity("lead-shortlisted", lead.accountId, `Shortlisted ${lead.name}`, `act-${leadId}-${now}`, now));
  if (status === "rejected")
    return withActivity(next, activity("lead-rejected", lead.accountId, `Rejected ${lead.name}`, `act-${leadId}-${now}`, now));
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
export function mergeSettings(defaults: Settings, saved: Partial2<Settings> | null | undefined): Settings {
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
  if (!isHttpUrl(s.ollamaUrl)) return { ok: false, error: "Ollama server URL must start with http:// or https://." };
  if (!isHttpUrl(s.agentUrl)) return { ok: false, error: "Agent URL must start with http:// or https://." };
  const { defaultLeadsCount, preferredMinAge, gentleMinAge } = s.leadRules;
  if (!isWhole(defaultLeadsCount, 1)) return { ok: false, error: "Default leads count must be a whole number, 1 or more." };
  if (!isWhole(gentleMinAge, 1) || !isWhole(preferredMinAge, 1))
    return { ok: false, error: "Ages must be whole numbers, 1 or more." };
  if (gentleMinAge > preferredMinAge)
    return { ok: false, error: "The gentle age must be lower than or equal to the full-match age." };
  if (!isWhole(s.sourcing.minComments, 0)) return { ok: false, error: "Min comments must be a whole number, 0 or more." };
  if (!isWhole(s.sourcing.minMembers, 0)) return { ok: false, error: "Min members must be a whole number, 0 or more." };
  if (s.database.kind === "supabase" && s.database.supabaseUrl && !s.database.supabaseUrl.startsWith("https://"))
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
export function ageVerdict(age: number, rules: Settings["leadRules"]): "match" | "gentle" | "reject" {
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
// Account agents — one per account; it can work on one task at a time.
// ---------------------------------------------------------------------------

export function agentFor(state: AppState, accountId: string): AgentState {
  return (
    state.agents?.find((a) => a.accountId === accountId) ?? {
      accountId,
      task: null,
      lastTaskLabel: null,
      lastFinishedAt: null,
    }
  );
}

/** Human label for a running job, e.g. "Collecting sources…" / "Scraping Stocks To Watch…". */
export function jobTaskLabel(state: AppState, job: SourceJob): string {
  if (job.kind === "collect") return "Collecting sources…";
  const name = job.sourceId ? state.sources.find((s) => s.id === job.sourceId)?.name : undefined;
  const verb = job.kind === "sync" ? "Syncing" : "Scraping";
  return name ? `${verb} ${name}…` : `${verb}…`;
}

/**
 * What the account's agent is doing right now: its stored task
 * (AI Analysis) first, else the running backend job (collect /
 * scrape / sync) as a derived task. Null when free. A job-derived
 * task has no expectedMs — its progress comes from the job itself,
 * and it is cleared when the job finishes, not by finishAgentTask.
 */
export function agentCurrentTask(state: AppState, accountId: string): AgentTask | null {
  const stored = agentFor(state, accountId).task;
  if (stored) return stored;
  const job = runningJobForAccount(state, accountId);
  if (!job) return null;
  return {
    kind: job.kind === "collect" ? "joining" : "scraping",
    label: jobTaskLabel(state, job),
    startedAt: job.startedAt,
    expectedMs: null,
  };
}

/** Busy while it has a task or a backend job is running, offline while its account is paused/blocked, otherwise free. */
export function agentStatus(state: AppState, accountId: string): AgentStatus {
  const account = state.accounts.find((a) => a.id === accountId);
  if (!account || account.status !== "active") return "offline";
  return agentCurrentTask(state, accountId) ? "busy" : "free";
}

function putAgent(state: AppState, agent: AgentState): AppState {
  const others = (state.agents ?? []).filter((a) => a.accountId !== agent.accountId);
  return { ...state, agents: [...others, agent] };
}

/** Give an account's agent a task. Fails when the agent is offline or already busy. */
export function startAgentTask(
  state: AppState,
  accountId: string,
  task: Omit<AgentTask, "startedAt">,
  now: string,
): Result<AppState> {
  const account = state.accounts.find((a) => a.id === accountId);
  if (!account) return { ok: false, error: "Account not found." };
  const status = agentStatus(state, accountId);
  if (status === "offline")
    return { ok: false, error: `${account.name} is ${account.status}, so its agent is offline.` };
  const agent = agentFor(state, accountId);
  const current = agentCurrentTask(state, accountId);
  if (current)
    return { ok: false, error: `${account.name}'s agent is busy: ${current.label}. Wait for it or stop that task.` };
  return { ok: true, value: putAgent(state, { ...agent, task: { ...task, startedAt: now } }) };
}

/** Mark the agent's current task done (or stopped). No-op when the agent is free. */
export function finishAgentTask(state: AppState, accountId: string, now: string): AppState {
  const agent = agentFor(state, accountId);
  if (!agent.task) return state;
  return putAgent(state, { ...agent, task: null, lastTaskLabel: agent.task.label, lastFinishedAt: now });
}

/** Simulated tasks whose expected time has passed. */
export function dueAgentTasks(state: AppState, nowMs: number): AgentState[] {
  return (state.agents ?? []).filter(
    (a) => a.task?.expectedMs != null && Date.parse(a.task.startedAt) + a.task.expectedMs <= nowMs,
  );
}

/** Finish every simulated task that is due. Returns the same state object when nothing changed. */
export function finishDueAgentTasks(state: AppState, nowMs: number): AppState {
  const due = dueAgentTasks(state, nowMs);
  const now = new Date(nowMs).toISOString();
  return due.reduce((s, a) => finishAgentTask(s, a.accountId, now), state);
}

/** 0–1 progress of a simulated task, or null when the length is unknown. */
export function agentProgress(task: AgentTask, nowMs: number): number | null {
  if (!task.expectedMs) return null;
  return Math.min(1, Math.max(0, (nowMs - Date.parse(task.startedAt)) / task.expectedMs));
}
