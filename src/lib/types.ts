// LeadHunter domain types. These mirror the future REST API payloads.

export type AccountStatus = "active" | "paused" | "blocked";

export interface Account {
  id: string;
  name: string;
  facebookName: string;
  status: AccountStatus;
  createdAt: string;
}

export type SourceType = "group" | "page";
export type SourceStatus = "joined" | "not-joined";

export interface Source {
  id: string;
  name: string;
  type: SourceType;
  /** Empty for sources added by number (the API will fill in real links later). */
  url: string;
  /** How many groups/pages this entry stands for; null for single linked sources. */
  quantity?: number | null;
  memberCount: number;
  status: SourceStatus;
  joinedByAccountId: string | null;
  lastScrapedAt: string | null;
}

export interface Person {
  name: string;
  url: string;
}

export interface Reply {
  author: Person;
  text: string;
  postedAt: string | null;
  postedAtLabel: string;
}

export interface Comment {
  author: Person;
  text: string;
  /** Exact time when Facebook exposes it (timestamp tooltip), else the relative label computed against collection time (approximate). */
  postedAt: string | null;
  /** The visible relative label as shown, e.g. "5d". Always kept, even when postedAt is exact. */
  postedAtLabel: string;
  replies: Reply[];
}

export interface PostData {
  id: string;
  sourceId: string;
  accountId: string;
  postUrl: string;
  author: Person;
  text: string;
  comments: Comment[];
  collectedAt: string;
  /** Last time a Sync re-visited this post and merged new activity (null = never synced). */
  lastSyncedAt: string | null;
}

export type LeadPriority = "rich-beginner" | "rich-experienced" | "other";
export type LeadStatus = "new" | "shortlisted" | "rejected";

export interface Lead {
  id: string;
  name: string;
  profileUrl: string;
  priority: LeadPriority;
  reason: string;
  quotedComment: string;
  sourcePostId: string;
  accountId: string;
  status: LeadStatus;
}

export type AiProvider = "ollama" | "gemini";

export interface LeadCriteria {
  richBeginner: string;
  richExperienced: string;
  reject: string;
}

export interface LeadRules {
  /** How many leads to aim for in one analysis run. */
  defaultLeadsCount: number;
  /** People this age or older are a full match. */
  preferredMinAge: number;
  /** From this age up to preferredMinAge - 1 is a gentle match; younger is rejected. */
  gentleMinAge: number;
}

export interface SourcingRules {
  /** Minimum comments a group/page should show before joining it. */
  minComments: number;
  /** Minimum members a group/page should have before joining it. */
  minMembers: number;
}

export type DatabaseKind = "supabase" | "connection-string";

export interface DatabaseConfig {
  kind: DatabaseKind;
  supabaseUrl: string;
  supabaseKey: string;
  connectionString: string;
}

export interface Settings {
  provider: AiProvider;
  model: string;
  ollamaUrl: string;
  geminiApiKey: string;
  criteria: LeadCriteria;
  leadRules: LeadRules;
  sourcing: SourcingRules;
  database: DatabaseConfig;
  /** Local scraping agent on the user's PC (Python + Playwright). */
  agentUrl: string;
}

export type ActivityType =
  | "account-created"
  | "source-added"
  | "source-joined"
  | "post-collected"
  | "analysis-finished"
  | "lead-shortlisted"
  | "lead-rejected"
  | "source-scraped"
  | "source-synced";

export interface Activity {
  id: string;
  type: ActivityType;
  accountId: string;
  message: string;
  at: string;
}

export interface AppState {
  accounts: Account[];
  sources: Source[];
  posts: PostData[];
  leads: Lead[];
  activity: Activity[];
  settings: Settings;
  /** One entry per account that has run (or is running) a task; missing accounts are free. */
  agents: AgentState[];
  /** Scrap/Sync jobs run against the local agent (newest first). */
  jobs: SourceJob[];
  activeAccountId: string;
  defaultAccountId: string;
}

/* ---------------- Source scrap/sync jobs ---------------- */

/** Kind of job the local scraping agent runs. */
export type SourceJobKind = "scrape" | "sync";

/**
 * Job status. "stop-requested" is the graceful-stop flag: the agent
 * finishes the current post fully, saves it, then terminates — the
 * flag is only ever checked BETWEEN posts, never mid-post.
 * "incomplete" means the run finished but at least one post's
 * collected comment count did not match its stated total (see
 * verification on the job).
 */
export type SourceJobStatus = "running" | "stop-requested" | "done" | "stopped" | "failed" | "incomplete";

/** Per-post completeness check: collected comments+replies vs the post's stated total. */
export interface PostVerification {
  postUrl: string;
  /** Stated total from the post (null when Facebook never showed one). */
  expectedComments: number | null;
  collectedComments: number;
  /** expectedComments - collectedComments (null when expected is unknown). */
  missing: number | null;
  complete: boolean;
}

export interface SourceJob {
  id: string;
  kind: SourceJobKind;
  sourceId: string | null;
  postId: string | null;
  accountId: string;
  status: SourceJobStatus;
  postsProcessed: number;
  newPosts: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  /** Count verification, one entry per post the job touched. */
  verification: PostVerification[];
}

/* ---------------- Account agents ---------------- */

/** Each account has exactly one agent that does its work (scraping, joining, analysis). */
export type AgentTaskKind = "scraping" | "joining" | "analysing";

export interface AgentTask {
  kind: AgentTaskKind;
  label: string;
  startedAt: string;
  /** Simulated duration so demo tasks finish on their own; the real agent API will report progress instead. */
  expectedMs: number | null;
}

export interface AgentState {
  accountId: string;
  task: AgentTask | null;
  lastTaskLabel: string | null;
  lastFinishedAt: string | null;
}

/** busy = working on a task, free = ready, offline = the account is paused or blocked. */
export type AgentStatus = "busy" | "free" | "offline";
