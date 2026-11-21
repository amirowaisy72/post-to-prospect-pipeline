/**
 * AI Analysis client: talks to the local agent (analysis_api.py).
 * Never throws: every call returns { ok, value } or { ok:false, error }.
 */
export type AnResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface AnalysisProgress {
  stage?: string;
  message?: string;
  partial?: boolean;
  stopAt?: number;
  posts?: number;
  comments?: number;
  replies?: number;
  people?: number;
  trivial?: number;
  excluded?: number;
  reused?: number;
  toScreen?: number;
  backlog?: number;
  backlogDone?: number;
  screened?: number;
  candidates?: number;
  judged?: number;
  matches?: number;
  failed?: number;
  lastError?: string;
}

export interface AnalysisMatch {
  personKey: string;
  name: string;
  profileUrl: string;
  score: number;
  bonus: number;
  combined: number;
  role: "poster" | "commenter";
  reason: string;
  quote: string;
  where: "post" | "comment" | "reply";
  postId: string;
  postUrl: string;
  postTitle: string;
  lastActiveAt: string | null;
  activityCount: number;
}

export type RunStatus = "running" | "stop-requested" | "done" | "stopped" | "failed";

export interface AnalysisSummary {
  id: string;
  accountId: string;
  status: RunStatus;
  createdAt: string;
  finishedAt: string | null;
  criteria: string;
  quantity: number;
  provider: string;
  model: string;
  sourceIds: string[];
  progress: AnalysisProgress;
  error: string | null;
  matchCount: number;
  live: boolean;
  /** only on overlap results */
  similarity?: number;
  sameData?: boolean;
}

export interface AnalysisRun extends AnalysisSummary {
  matches: AnalysisMatch[];
}

export const isRunLive = (r: { status: string } | null | undefined) =>
  !!r && (r.status === "running" || r.status === "stop-requested");

export interface Overlap {
  posts: number;
  comments: number;
  replies: number;
  people: number;
  noLink: number;
  inLeads: number;
  empty: number;
  neverChecked: number;
  alreadyForQuery: number;
  pendingForQuery: number | null;
  runs: AnalysisSummary[];
}

export interface SourceAnalysis {
  sourceId: string;
  name: string;
  posts: number;
  comments: number;
  replies: number;
  people: number;
  checkable: number;
  unchecked: number;
  checked: number;
  runs: (AnalysisSummary & { matchesHere: number; pendingHere: number; checkedHere: number })[];
}

export interface AnalysisSettings {
  provider: string;
  model: string;
  geminiKey: string;
  ollamaUrl: string;
  excludeUrls: string[];
}

export interface StartAnalysis extends AnalysisSettings {
  accountId: string;
  sourceIds: string[];
  criteria: string;
  quantity: number;
  rescan: boolean;
}

const DOWN = "The agent is not running — start run-agent.bat.";

async function call<T>(agentUrl: string, path: string, init?: RequestInit, timeoutMs = 20000): Promise<AnResult<T>> {
  const base = agentUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, { ...init, signal: controller.signal });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const detail = data && typeof data["detail"] === "string" ? data["detail"] : `Agent error ${res.status}`;
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

export const overlapAnalysis = (
  url: string,
  body: { accountId: string; sourceIds: string[]; criteria: string; excludeUrls: string[] },
) => call<Overlap>(url, "/analysis/overlap", post(body), 90000);

export const startAnalysis = (url: string, body: StartAnalysis) =>
  call<{ id: string }>(url, "/analysis/start", post(body));

export const listAnalyses = (url: string, accountId: string) =>
  call<{ runs: AnalysisSummary[] }>(url, `/analysis/runs?accountId=${encodeURIComponent(accountId)}`);

export const getAnalysis = (url: string, runId: string) =>
  call<{ run: AnalysisRun }>(url, `/analysis/runs/${encodeURIComponent(runId)}`);

export const stopAnalysis = (url: string, runId: string) =>
  call<{ ok: boolean }>(url, `/analysis/runs/${encodeURIComponent(runId)}/stop`, post({}));

export const resumeAnalysis = (url: string, runId: string, body: AnalysisSettings & { stopAt?: number }) =>
  call<{ id: string }>(url, `/analysis/runs/${encodeURIComponent(runId)}/resume`, post(body));

export const shrinkAnalysis = (url: string, runId: string, quantity: number) =>
  call<{ ok: boolean }>(url, `/analysis/runs/${encodeURIComponent(runId)}/quantity`, post({ quantity }));

export const deleteAnalysis = (url: string, runId: string) =>
  call<{ ok: boolean }>(url, `/analysis/runs/${encodeURIComponent(runId)}/delete`, post({}));

export const sourceAnalysis = (url: string, sourceId: string) =>
  call<SourceAnalysis>(url, `/analysis/source/${encodeURIComponent(sourceId)}`, undefined, 60000);

export const uncheckedCounts = (url: string, accountId: string) =>
  call<{ sources: Record<string, { people: number; unchecked: number }> }>(
    url,
    `/analysis/unchecked?accountId=${encodeURIComponent(accountId)}`,
    undefined,
    90000,
  );

export const testModel = (url: string, provider: string, model: string, geminiKey: string, ollamaUrl: string) =>
  call<{ seconds: number; reply: string }>(url, "/ai/test", post({ provider, model, geminiKey, ollamaUrl }), 60000);