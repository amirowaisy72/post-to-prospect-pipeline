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
  Comment,
  Lead,
  LeadPriority,
  LeadStatus,
  Person,
  PostData,
  Settings,
  Source,
  SourceType,
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
  const next = { ...state, accounts: [...state.accounts, account] };
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

/* ---------------- Sources ---------------- */

/**
 * Add a source by name, type and number of groups/pages. Only joined sources
 * are listed, so a new source is joined by the account that adds it.
 */
export function addSource(
  state: AppState,
  input: { name: string; type: SourceType; quantity: number },
  accountId: string,
  id: string,
  now: string,
): Result<AppState> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Name is required." };
  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    return { ok: false, error: "Number must be a whole number of 1 or more." };
  }
  const existing = state.sources.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    return { ok: false, error: `A source named "${existing.name}" already exists.` };
  }
  const source: Source = {
    id,
    name,
    type: input.type,
    url: "",
    quantity: input.quantity,
    memberCount: 0,
    status: "joined",
    joinedByAccountId: accountId,
    lastScrapedAt: null,
  };
  return {
    ok: true,
    value: withActivity(
      { ...state, sources: [...state.sources, source] },
      activity("source-added", accountId, `Added source ${name}`, `act-${id}`, now),
    ),
  };
}

/** Why a source can't be joined by this account, or null when it can. */
export function joinBlockReason(state: AppState, source: Source, accountId: string): string | null {
  if (source.status === "joined" && source.joinedByAccountId) {
    if (source.joinedByAccountId === accountId) return "Joined";
    return `Already joined by ${accountName(state, source.joinedByAccountId)}`;
  }
  // Another source row with the same URL that is already joined also blocks.
  const twin = state.sources.find(
    (s) => s.id !== source.id && !!s.url && sameUrl(s.url, source.url) && s.joinedByAccountId,
  );
  if (twin) return `Already joined by ${accountName(state, twin.joinedByAccountId)}`;
  return null;
}

export function joinSource(
  state: AppState,
  sourceId: string,
  accountId: string,
  now: string,
): Result<AppState> {
  const source = state.sources.find((s) => s.id === sourceId);
  if (!source) return { ok: false, error: "Source not found." };
  const blocked = joinBlockReason(state, source, accountId);
  if (blocked) return { ok: false, error: blocked };
  const next: AppState = {
    ...state,
    sources: state.sources.map((s) =>
      s.id === sourceId
        ? { ...s, status: "joined", joinedByAccountId: accountId, lastScrapedAt: s.lastScrapedAt }
        : s,
    ),
  };
  return {
    ok: true,
    value: withActivity(
      next,
      activity("source-joined", accountId, `Joined ${source.name}`, `act-${sourceId}-${now}`, now),
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

export interface PostParseResult {
  ok: boolean;
  errors: string[];
  draft: PostDraft | null;
  /** Set when the same post URL was already collected (by any account). */
  alreadyCollected: { accountName: string } | null;
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
}

function readPerson(value: unknown, path: string, errors: string[]): Person | null {
  if (!value || typeof value !== "object") {
    errors.push(`${path} must be an object with "name" and "url".`);
    return null;
  }
  const v = value as Loose;
  if (typeof v.name !== "string" || !v.name.trim()) errors.push(`${path}.name is required.`);
  if (typeof v.url !== "string" || !v.url.trim()) errors.push(`${path}.url is required.`);
  if (typeof v.name !== "string" || typeof v.url !== "string") return null;
  return { name: v.name.trim(), url: v.url.trim() };
}

/** Validate pasted / uploaded PostData JSON. Nothing is saved here. */
export function parsePostDataJson(raw: string, state: AppState): PostParseResult {
  const errors: string[] = [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      errors: [`Invalid JSON: ${(e as Error).message}`],
      draft: null,
      alreadyCollected: null,
    };
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return {
      ok: false,
      errors: ["Expected one PostData object ({ ... }), not an array or value."],
      draft: null,
      alreadyCollected: null,
    };
  }
  const o = json as Loose;
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
          if (rAuthor && typeof rr.text === "string") replies.push({ author: rAuthor, text: rr.text });
        });
      }
      if (cAuthor && typeof cc.text === "string") comments.push({ author: cAuthor, text: cc.text, replies });
    });
  }

  const sourceId =
    typeof o.sourceId === "string" && state.sources.some((s) => s.id === o.sourceId)
      ? o.sourceId
      : null;

  const postUrl = typeof o.postUrl === "string" ? o.postUrl.trim() : "";
  const existing = postUrl ? findCollectedPost(state, postUrl) : undefined;
  const alreadyCollected = existing ? { accountName: accountName(state, existing.accountId) } : null;

  const draft =
    errors.length === 0 && author
      ? { postUrl, author, text: String(o.text), comments, sourceId }
      : null;

  return { ok: errors.length === 0 && !alreadyCollected, errors, draft, alreadyCollected };
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

export const SAMPLE_POST_JSON = JSON.stringify(
  {
    sourceId: "src-1",
    postUrl: "https://facebook.com/groups/psxinvestorspk/posts/7790045512",
    author: { name: "Kashif Mehmood", url: "https://facebook.com/kashif.mehmood.pk" },
    text: "Got my bonus this month. Should I go for gold, PSX or a savings certificate?",
    comments: [
      {
        author: { name: "Farah Jamil", url: "https://facebook.com/farah.jamil.khi" },
        text: "We sold my father's factory last month and I'm completely new to this. Where do I start with PSX?",
        replies: [
          {
            author: { name: "Imran Butt", url: "https://facebook.com/imran.butt.isb" },
            text: "Been investing for 8 years, my portfolio is 60% banks. Also own two rental apartments in Bahria.",
          },
        ],
      },
      {
        author: { name: "Quick Profit Club", url: "https://facebook.com/quickprofitclub" },
        text: "Join my WhatsApp for guaranteed 5% weekly profit!!",
        replies: [],
      },
    ],
  },
  null,
  2,
);

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
    database: {
      ...input.database,
      supabaseUrl: input.database.supabaseUrl.trim().replace(/\/+$/, ""),
      supabaseKey: input.database.supabaseKey.trim(),
      connectionString: input.database.connectionString.trim(),
    },
  };
  if (!s.model) return { ok: false, error: "Enter a model name." };
  if (!isHttpUrl(s.ollamaUrl)) return { ok: false, error: "Ollama server URL must start with http:// or https://." };
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
