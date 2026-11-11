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
}

export interface Comment {
  author: Person;
  text: string;
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
}

export type ActivityType =
  | "account-created"
  | "source-added"
  | "source-joined"
  | "post-collected"
  | "analysis-finished"
  | "lead-shortlisted"
  | "lead-rejected";

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
  activeAccountId: string;
  defaultAccountId: string;
}
