import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { getAnalysis, isRunLive, listAnalyses, type AnalysisMatch, type AnalysisSummary } from "@/lib/analysis-client";
import { useStore } from "@/lib/store";
import type { Lead } from "@/lib/types";

export const CRIT_KEY = "leadhunter:analysis-criteria";
const SAVED_KEY = "leadhunter:analysis-saved";

export const readLS = (k: string, d: string) => {
  try {
    return window.localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
export const writeLS = (k: string, v: string) => {
  try {
    window.localStorage.setItem(k, v);
  } catch {
    /* storage can be blocked; the page works without it */
  }
};

export function toLead(m: AnalysisMatch, accountId: string): Lead {
  return {
    id: `lead-${crypto.randomUUID()}`,
    name: m.name,
    profileUrl: m.profileUrl,
    priority: "other",
    ...(m.category ? { category: m.category } : {}),
    reason: `Match ${m.score}% — ${m.reason}`,
    quotedComment: m.quote,
    sourcePostId: `agent:${m.postId}`,
    sourcePostUrl: m.postUrl,
    sourcePostTitle: m.postTitle,
    accountId,
    status: "new",
  };
}

export function RunStatusBadge({ run }: { run: Pick<AnalysisSummary, "status" | "progress"> }) {
  switch (run.status) {
    case "running":
      return <Badge variant="info">Running</Badge>;
    case "stop-requested":
      return <Badge variant="warning">Stopping…</Badge>;
    case "stopped":
      return <Badge variant="warning">Stopped · You can resume</Badge>;
    case "failed":
      return <Badge variant="danger">Failed · You can resume</Badge>;
    default:
      return run.progress.partial ? (
        <Badge variant="neutral">Target reached · rest not checked</Badge>
      ) : (
        <Badge variant="success">Complete</Badge>
      );
  }
}

/** True when the record has unfinished work the user can continue. */
export const canResume = (run: Pick<AnalysisSummary, "status" | "progress">) =>
  run.status === "stopped" || run.status === "failed" || (run.status === "done" && !!run.progress.partial);

/**
 * Mounted once by the Analysis layout (so it keeps working on every
 * analysis page): when an analysis that ran in this session ends, its
 * best N people are added to Leads once (people already there are skipped).
 */
export function useAutoSaveFinished() {
  const { state, saveLeads } = useStore();
  const accountId = state.activeAccountId;
  const agentUrl = state.settings.agentUrl;
  const liveSeen = useRef<Set<string>>(new Set());
  const saved = useRef<Set<string>>(new Set(JSON.parse(readLS(SAVED_KEY, "[]")) as string[]));

  useEffect(() => {
    if (!accountId) return;
    let off = false;
    const tick = async () => {
      const r = await listAnalyses(agentUrl, accountId);
      if (off || !r.ok) return;
      for (const run of r.value.runs) {
        if (isRunLive(run)) {
          liveSeen.current.add(run.id);
          continue;
        }
        if (!liveSeen.current.has(run.id) || saved.current.has(run.id)) continue;
        saved.current.add(run.id);
        writeLS(SAVED_KEY, JSON.stringify([...saved.current].slice(-80)));
        const g = await getAnalysis(agentUrl, run.id);
        if (off || !g.ok) continue;
        const top = [...g.value.run.matches].sort((a, b) => b.combined - a.combined).slice(0, g.value.run.quantity);
        if (top.length === 0) continue;
        saveLeads(top.map((m) => toLead(m, g.value.run.accountId)), g.value.run.progress.posts ?? 0);
        toast.success(`${top.length} people saved to the Leads page`);
      }
    };
    void tick();
    const t = window.setInterval(() => void tick(), 4000);
    return () => {
      off = true;
      window.clearInterval(t);
    };
  }, [agentUrl, accountId, saveLeads]);
}

/** Same wording (ignoring case, spaces, trailing punctuation) = the same query. */
export const critKeyOf = (s: string) =>
  s.toLowerCase().replace(/\s+/g, " ").replace(/[\s.!?,;:]+$/g, "").trim();

export interface QueryGroup {
  key: string;
  criteria: string;
  /** newest first */
  runs: AnalysisSummary[];
  /** id of the newest run: used in the page address */
  id: string;
  live: boolean;
  best: number;
  sourceIds: string[];
}

export function groupRuns(runs: AnalysisSummary[]): QueryGroup[] {
  const map = new Map<string, AnalysisSummary[]>();
  for (const r of runs) {
    const k = critKeyOf(r.criteria);
    map.set(k, [...(map.get(k) ?? []), r]);
  }
  const out: QueryGroup[] = [];
  for (const [key, list] of map) {
    const sorted = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const first = sorted[0];
    if (!first) continue;
    out.push({
      key,
      criteria: first.criteria,
      runs: sorted,
      id: first.id,
      live: sorted.some((r) => r.status === "running" || r.status === "stop-requested"),
      best: Math.max(...sorted.map((r) => r.matchCount)),
      sourceIds: [...new Set(sorted.flatMap((r) => r.sourceIds))],
    });
  }
  return out.sort((a, b) => (b.runs[0]?.createdAt ?? "").localeCompare(a.runs[0]?.createdAt ?? ""));
}
