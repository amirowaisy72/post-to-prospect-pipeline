// LeadHunter domain types. These mirror the future REST API payloads.

export type AccountStatus = "active" | "paused" | "blocked";

export interface Account {
  id: string;
  name: string;
  facebookName: string;
  status: AccountStatus;
  createdAt: string;
  /** When the Facebook account itself was created (YYYY-MM-DD).
   * Drives the daily chat cap (see dailyChatLimit). Null = unknown,
   * then the app account's createdAt is used (conservative). */
  facebookCreatedAt: string | null;
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
  /** Local chat agent (run-agent.bat) the Inbox talks to. */
  agentUrl: string;
  criteria: LeadCriteria;
  leadRules: LeadRules;
  sourcing: SourcingRules;
  database: DatabaseConfig;
}

export type ActivityType =
  | "account-created"
  | "source-added"
  | "source-collected"
  | "source-deleted"
  | "source-joined"
  | "post-collected"
  | "analysis-finished"
  | "lead-shortlisted"
  | "lead-rejected"
  | "source-scraped"
  | "source-synced"
  | "chat-started"
  | "chat-reply"
  | "chat-deleted";

export interface Activity {
  id: string;
  type: ActivityType;
  accountId: string;
  message: string;
  at: string;
}

/* ---------------- Inbox (DM chats with shortlisted candidates) ---------------- */

/** Which kind of Facebook activity the person was shortlisted from. */
export type InboxSourceType = "comment" | "post";

export type ChatThreadStatus = "active" | "done";

export interface ChatThread {
  id: string;
  accountId: string;
  /** Facebook profile link of the candidate. */
  profileUrl: string;
  profileName: string;
  sourceType: InboxSourceType;
  /** The comment/post text the person was shortlisted from. */
  sourceText: string;
  /** Link to the comment/post the person was shortlisted from. */
  sourceUrl: string;
  /** Optional note about why this person was shortlisted. */
  shortlistNote: string;
  status: ChatThreadStatus;
  createdAt: string;
}

export type ChatMessageRole = "agent" | "candidate" | "system";

/**
 * How a message relates to Facebook Messenger.
 * "in-app" = a draft stored in LeadHunter only, never sent.
 * "pending-messenger" = handed to the chat agent, delivery unknown yet.
 * "sent" = the agent confirmed it in Messenger after a reload.
 * "failed" = the agent could not send it.
 * "received" = a reply the agent read from Messenger.
 */
export type ChatDelivery =
  | "in-app"
  | "pending-messenger"
  | "sent"
  | "failed"
  | "received";

export interface ChatMessage {
  id: string;
  threadId: string;
  role: ChatMessageRole;
  text: string;
  createdAt: string;
  delivery: ChatDelivery;
  /** Live send stage from the agent (first-message send only):
   * which step the send sits at, when it entered it, and the plain
   * failure reason. Null until the send starts. */
  sendStage?: string | null;
  sendStageSince?: string | null;
  sendStageDetail?: string | null;
}

/** The editable chat script the agent follows in every thread. */
export interface ChatScript {
  /** First-message template. Placeholders: {name}, {sourceKind}, {sourceText}. */
  firstMessageTemplate: string;
  /** Short self-introduction used in the first message. */
  introduction: string;
  /** Tone and style rules for every reply. */
  tone: string;
  /** Hard rules the agent must never break. */
  rules: string;
  /** The end goal of every conversation. */
  goal: string;
}

export interface AppState {
  accounts: Account[];
  sources: Source[];
  posts: PostData[];
  leads: Lead[];
  activity: Activity[];
  settings: Settings;
  activeAccountId: string;
  defaultAccountId: string;
  threads: ChatThread[];
  chatMessages: ChatMessage[];
  chatScript: ChatScript;
}
