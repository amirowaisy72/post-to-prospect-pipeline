/**
 * Data Sourcing client: talks to the local agent (run-agent.bat) for
 * sources, scraped posts and the collect / scrape / sync / stop jobs.
 * Never throws: every call returns { ok, value } or { ok:false, error }.
 */
export type SrcResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface AgentSource {
  id: string;
  name: string;
  type: "group" | "page";
  url: string;
  memberCount: number | null;
  status: "joined" | "not-joined";
  accountId: string;
  lastScrapedAt: string | null;
  postCount: number;
}

export interface PostSummary {
  id: string;
  postUrl: string;
  author: { name: string; url: string };
  text: string;
  commentCount: number;
  replyCount: number;
  collectedAt: string | null;
  lastSyncedAt: string | null;
}

export interface FullReply {
  author: { name: string; url: string };
  text: string;
  postedAt: string | null;
  postedAtLabel: string;
}
export interface FullComment extends FullReply {
  replies: FullReply[];
}
export interface FullPost {
  id: string;
  sourceId: string | null;
  accountId: string;
  postUrl: string;
  author: { name: string; url: string };
  text: string;
  comments: FullComment[];
  collectedAt: string | null;
  lastSyncedAt: string | null;
}

export interface RejectedSource {
  name: string;
  url: string;
  type: "group" | "page";
  memberCount: number | null;
  why: string;
}

export interface AgentJob {
  result?: { rejected?: RejectedSource[] } | null;
  id: string;
  kind: "scrape" | "sync" | "collect";
  sourceId: string | null;
  postId: string | null;
  status: string;
  postsProcessed: number;
  newPosts: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  message: string | null;
}

export const isJobLive = (j: { status: string } | null | undefined) =>
  !!j && (j.status === "running" || j.status === "stop-requested");

const DOWN = "The agent is not running — start run-agent.bat.";

async function call<T>(
  agentUrl: string,
  path: string,
  init?: RequestInit,
  timeoutMs = 15000,
): Promise<SrcResult<T>> {
  const base = agentUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, { ...init, signal: controller.signal });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const detail =
        data && typeof data["detail"] === "string" ? data["detail"] : `Agent error ${res.status}`;
      return { ok: false, error: detail };
    }
    return { ok: true, value: data as T };
  } catch {
    return { ok: false, error: DOWN };
  } finally {
    window.clearTimeout(timer);
  }
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const listAgentSources = (url: string, accountId: string) =>
  call<{ sources: AgentSource[] }>(url, `/sources?accountId=${encodeURIComponent(accountId)}`);

export const listSourcePosts = (url: string, sourceId: string, offset: number, limit: number) =>
  call<{ total: number; posts: PostSummary[] }>(
    url,
    `/sources/${encodeURIComponent(sourceId)}/posts?offset=${offset}&limit=${limit}`,
  );

export const getAgentPost = (url: string, postId: string) =>
  call<{ post: FullPost }>(url, `/posts/${encodeURIComponent(postId)}`);

export const addManualSource = (
  url: string,
  b: {
    accountId: string;
    name: string;
    url: string;
    memberCount: number | null;
    status?: "joined" | "not-joined";
  },
) => call<{ id: string }>(url, "/sources/manual", post(b));

export const removeSource = (url: string, sourceId: string, force = false) =>
  call<{ ok: boolean; left: boolean; detail: string }>(
    url,
    `/sources/${encodeURIComponent(sourceId)}/remove${force ? "?force=true" : ""}`,
    post({}),
    120000,
  );

export const startCollect = (
  url: string,
  b: {
    accountId: string;
    keyword: string;
    country: string;
    recheck: boolean;
    type: "group" | "page" | "both";
    maxNew: number;
    join: boolean;
    minComments: number;
    minMembers: number;
  },
) => call<{ jobId: string }>(url, "/collect-sources", post(b));

export const startScrape = (
  url: string,
  b: { accountId: string; source: AgentSource; limit: number },
) =>
  call<{ jobId: string }>(
    url,
    "/scrape",
    post({
      accountId: b.accountId,
      sourceId: b.source.id,
      sourceUrl: b.source.url,
      sourceName: b.source.name,
      sourceType: b.source.type,
      limit: b.limit,
    }),
  );

export const startSync = (
  url: string,
  b: { accountId: string; postId: string; postUrl: string },
) => call<{ jobId: string }>(url, "/sync", post(b));

export const stopJob = (url: string, jobId: string) =>
  call<{ jobId: string; status: string }>(url, "/stop", post({ jobId }));

export const listJobs = (url: string) => call<{ jobs: AgentJob[] }>(url, "/jobs", undefined, 8000);
