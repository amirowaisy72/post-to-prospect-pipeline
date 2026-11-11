/**
 * Client for the local scraping agent (Python + Playwright, runs on the
 * user's PC at settings.agentUrl). The agent uses the user's own Chrome
 * profile — the frontend never sees a Facebook password.
 */
import type { CollectedSource, PostVerification, SourceType } from "./types";

export const AGENT_NOT_RUNNING_MESSAGE = "Agent not running — run run-agent.bat on your PC";

export class AgentUnreachableError extends Error {
  constructor() {
    super(AGENT_NOT_RUNNING_MESSAGE);
    this.name = "AgentUnreachableError";
  }
}

export type AgentJobStatus =
  | "running"
  | "stop-requested"
  | "done"
  | "stopped"
  | "failed"
  | "incomplete";

export interface AgentJob {
  id: string;
  kind: "scrape" | "sync" | "collect";
  sourceId: string | null;
  postId: string | null;
  accountId: string;
  status: AgentJobStatus;
  postsProcessed: number;
  newPosts: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  /** Plain-language flag when the job is incomplete, e.g. "collected 8 of 10 — 2 missing". */
  message?: string | null;
  verification: PostVerification[];
  /** Collect jobs only: the sources the agent joined/recorded. */
  result?: { sources: CollectedSource[] } | null;
}

export interface AgentHealth {
  ok: boolean;
  service: string;
  facebook: string;
}

const base = (agentUrl: string) => agentUrl.replace(/\/+$/, "");

async function agentFetch(
  agentUrl: string,
  path: string,
  init?: RequestInit,
  timeoutMs = 8000,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${base(agentUrl)}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new AgentUnreachableError();
  }
  if (!res.ok) {
    const detail = await safeDetail(res);
    const err = new Error(detail || `Agent request failed (${res.status})`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return res.json() as Promise<unknown>;
}

async function safeDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    return typeof body.detail === "string" ? body.detail : "";
  } catch {
    return "";
  }
}

export async function getAgentHealth(agentUrl: string): Promise<AgentHealth> {
  return (await agentFetch(agentUrl, "/health", undefined, 5000)) as AgentHealth;
}

export async function startAgentScrape(
  agentUrl: string,
  input: { sourceId: string; sourceUrl: string; sourceName?: string; accountId: string; limit?: number },
): Promise<{ jobId: string }> {
  return (await agentFetch(agentUrl, "/scrape", {
    method: "POST",
    body: JSON.stringify(input),
  })) as { jobId: string };
}

export async function startAgentSync(
  agentUrl: string,
  input: {
    sourceId?: string | null;
    sourceUrl?: string | null;
    postId?: string | null;
    postUrl?: string | null;
    accountId: string;
  },
): Promise<{ jobId: string }> {
  return (await agentFetch(agentUrl, "/sync", {
    method: "POST",
    body: JSON.stringify(input),
  })) as { jobId: string };
}

export async function startAgentCollect(
  agentUrl: string,
  input: {
    keyword: string;
    type: SourceType | "both";
    maxNew: number;
    accountId: string;
    minComments: number;
    minMembers: number;
  },
): Promise<{ jobId: string }> {
  return (await agentFetch(agentUrl, "/collect-sources", {
    method: "POST",
    body: JSON.stringify(input),
  })) as { jobId: string };
}

/**
 * Leave the group / unfollow the page on Facebook, then remove the
 * source from the agent DB. Long timeout: a leave takes ~15–20 s on
 * Facebook. Throws on failure — the caller must NOT remove the row.
 */
export async function deleteAgentSource(
  agentUrl: string,
  sourceId: string,
): Promise<{ ok: boolean; left: boolean; detail: string }> {
  return (await agentFetch(
    agentUrl,
    `/sources/${encodeURIComponent(sourceId)}/delete`,
    { method: "POST" },
    180_000,
  )) as { ok: boolean; left: boolean; detail: string };
}

export async function stopAgentJob(
  agentUrl: string,
  jobId: string,
): Promise<{ jobId: string; status: string }> {
  return (await agentFetch(agentUrl, "/stop", {
    method: "POST",
    body: JSON.stringify({ jobId }),
  })) as { jobId: string; status: string };
}

export async function getAgentJob(
  agentUrl: string,
  jobId: string,
): Promise<{ job: AgentJob; posts: unknown }> {
  return (await agentFetch(agentUrl, `/jobs/${encodeURIComponent(jobId)}`)) as {
    job: AgentJob;
    posts: unknown;
  };
}
