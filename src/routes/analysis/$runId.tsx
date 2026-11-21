import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { CheckCircle2, ChevronLeft, ExternalLink, Play, Plus, Sparkles, Square, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { canResume, critKeyOf, RunStatusBadge, toLead } from "@/components/analysis-bits";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  deleteAnalysis,
  getAnalysis,
  isRunLive,
  listAnalyses,
  resumeAnalysis,
  shrinkAnalysis,
  stopAnalysis,
  type AnalysisMatch,
  type AnalysisRun,
  type AnalysisSummary,
} from "@/lib/analysis-client";
import { fmtDate } from "@/lib/format";
import { sameUrl } from "@/lib/leadhunter-service";
import { listAgentSources, type AgentSource } from "@/lib/sourcing-client";
import { useStore } from "@/lib/store";

export const Route = createFileRoute("/analysis/$runId")({
  head: () => ({
    meta: [
      { title: "Analysis — LeadHunter" },
      { name: "description", content: "One AI analysis query: its runs, progress and the people it found." },
      { property: "og:title", content: "Analysis — LeadHunter" },
    ],
  }),
  component: AnalysisQueryPage,
});

const PAGE_SIZE = 20;

function AnalysisQueryPage() {
  const { runId } = Route.useParams();
  const { state, saveLeads } = useStore();
  const navigate = useNavigate();
  const agentUrl = state.settings.agentUrl;
  const accountId = state.activeAccountId;
  const provider = state.settings.provider;
  const model = state.settings.model;
  const geminiKey = state.settings.geminiApiKey;
  const modelOk = !!model.trim() && (provider !== "gemini" || !!geminiKey.trim());

  const [all, setAll] = useState<AnalysisSummary[] | null>(null);
  const [full, setFull] = useState<Record<string, AnalysisRun>>({});
  const [sources, setSources] = useState<AgentSource[]>([]);
  const [sort, setSort] = useState<"best" | "recent">("best");
  const [page, setPage] = useState(0);
  const [shrinkTo, setShrinkTo] = useState("");
  const [stopAt, setStopAt] = useState("");

  useEffect(() => {
    void listAgentSources(agentUrl, accountId).then((r) => r.ok && setSources(r.value.sources));
  }, [agentUrl, accountId]);

  // every run with the same query wording belongs to this page
  const anchor = all?.find((r) => r.id === runId) ?? null;
  const attempts = useMemo(() => {
    if (!all || !anchor) return [] as AnalysisSummary[];
    const k = critKeyOf(anchor.criteria);
    return all.filter((r) => critKeyOf(r.criteria) === k).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [all, anchor]);
  const liveAttempt = attempts.find((r) => isRunLive(r)) ?? null;
  const focus = liveAttempt ?? attempts[0] ?? null;
  const live = !!liveAttempt;

  const attemptKey = attempts.map((r) => `${r.id}:${r.status}:${r.matchCount}`).join("|");
  const load = useCallback(async () => {
    const l = await listAnalyses(agentUrl, accountId);
    if (!l.ok) return;
    setAll(l.value.runs);
    const k = critKeyOf(l.value.runs.find((r) => r.id === runId)?.criteria ?? "");
    const mine = l.value.runs.filter((r) => k && critKeyOf(r.criteria) === k);
    const got = await Promise.all(mine.map((r) => getAnalysis(agentUrl, r.id)));
    const next: Record<string, AnalysisRun> = {};
    got.forEach((g) => {
      if (g.ok) next[g.value.run.id] = g.value.run;
    });
    setFull(next);
  }, [agentUrl, accountId, runId]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), live ? 2500 : 8000);
    return () => window.clearInterval(t);
  }, [load, live]);

  const sourceName = (id: string) => sources.find((s) => s.id === id)?.name ?? "(deleted source)";
  const settings = { provider, model: model.trim(), geminiKey, ollamaUrl: state.settings.ollamaUrl, excludeUrls: state.leads.map((l) => l.profileUrl) };
  const focusRun = focus ? full[focus.id] : undefined;

  // one row per person, best result across all runs of this query
  const ranked = useMemo(() => {
    const best = new Map<string, AnalysisMatch>();
    for (const r of Object.values(full))
      for (const m of r.matches) {
        const cur = best.get(m.personKey);
        if (!cur || m.combined > cur.combined) best.set(m.personKey, m);
      }
    const list = [...best.values()];
    if (sort === "recent") list.sort((a, b) => (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? "") || b.combined - a.combined);
    else list.sort((a, b) => b.combined - a.combined);
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptKey, full, sort]);
  const inLeads = (m: AnalysisMatch) => state.leads.some((l) => sameUrl(l.profileUrl, m.profileUrl));
  const notInLeads = ranked.filter((m) => !inLeads(m));
  const pages = Math.max(1, Math.ceil(ranked.length / PAGE_SIZE));
  const safePage = Math.min(page, pages - 1);
  const pageItems = ranked.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const stop = async (id: string) => {
    const r = await stopAnalysis(agentUrl, id);
    if (!r.ok) toast.error(r.error);
    void load();
  };
  const resume = async (id: string) => {
    const n = Math.floor(Number(stopAt));
    const r = await resumeAnalysis(agentUrl, id, n >= 1 ? { ...settings, stopAt: n } : settings);
    setStopAt("");
    if (!r.ok) toast.error(r.error);
    void load();
  };
  const removeAll = async () => {
    if (!window.confirm("Delete this analysis? (People already in Leads will not be deleted)")) return;
    for (const r of attempts) {
      const x = await deleteAnalysis(agentUrl, r.id);
      if (!x.ok) {
        toast.error(x.error);
        return;
      }
    }
    void navigate({ to: "/analysis" });
  };
  const shrink = async () => {
    if (!liveAttempt) return;
    const q = Math.floor(Number(shrinkTo));
    if (!q || q < 1) {
      toast.error("Enter a number of 1 or more");
      return;
    }
    const r = await shrinkAnalysis(agentUrl, liveAttempt.id, q);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    toast.success(`Once ${q} matches are found, the analysis will stop and complete`);
    setShrinkTo("");
  };
  const addOne = (m: AnalysisMatch) => {
    if (inLeads(m)) return;
    saveLeads([toLead(m, accountId)], focus?.progress.posts ?? 0);
    toast.success(`${m.name} added to Leads`);
  };
  const addAll = () => {
    if (notInLeads.length === 0) return;
    saveLeads(notInLeads.map((m) => toLead(m, accountId)), focus?.progress.posts ?? 0);
    toast.success(`${notInLeads.length} people added to Leads`);
  };

  const back = (
    <Button asChild variant="ghost" size="sm" className="mb-3 -ml-2">
      <Link to="/analysis"><ChevronLeft /> All analyses</Link>
    </Button>
  );

  if (all && !anchor)
    return (
      <>
        {back}
        <EmptyState title="This analysis was not found">It may have been deleted.</EmptyState>
      </>
    );
  if (!anchor || !focus)
    return (
      <>
        {back}
        <p className="text-sm text-muted-foreground">Loading…</p>
      </>
    );

  const p = focus.progress;
  const percent = (() => {
    if (focus.status === "done") return 100;
    const total = (p.toScreen ?? 0) + (p.backlog ?? 0);
    const done = (p.screened ?? 0) + (p.backlogDone ?? 0);
    return Math.min(99, Math.round((done / Math.max(1, total)) * 100));
  })();
  const srcIds = [...new Set(attempts.flatMap((r) => r.sourceIds))];

  return (
    <>
      {back}
      <PageHeader title="Analysis ka record" description={srcIds.map(sourceName).join(", ")}
        actions={
          <>
            <RunStatusBadge run={focus} />
            {live ? (
              <Button size="sm" variant="outline" onClick={() => void stop(focus.id)} disabled={focus.status === "stop-requested"}>
                <Square /> Stop
              </Button>
            ) : (
              <>
                {canResume(focus) && (
                  <Button size="sm" onClick={() => void resume(focus.id)} disabled={!modelOk}>
                    <Play /> Resume
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => void removeAll()} aria-label="Delete analysis">
                  <Trash2 />
                </Button>
              </>
            )}
          </>
        } />

      <Card className="overflow-hidden shadow-card">
        {live && (
          <div className="relative h-1 overflow-hidden bg-muted">
            <div className="absolute inset-y-0 w-1/4 animate-scan bg-primary" />
          </div>
        )}
        <CardContent className="space-y-3 p-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Query</p>
            <p className="text-base font-semibold text-foreground">{anchor.criteria}</p>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-foreground">{p.message}</span>
            <span className="text-muted-foreground tabular">{percent}%</span>
          </div>
          <Progress value={percent} />
          <div className="grid gap-2 text-xs text-muted-foreground tabular sm:grid-cols-3 lg:grid-cols-6">
            <span>{p.people ?? 0} people total</span>
            <span>{p.excluded ?? 0} already in Leads (skipped)</span>
            <span>{p.reused ?? 0} already checked</span>
            <span>{p.trivial ?? 0} empty comments</span>
            <span>{p.screened ?? 0} screened</span>
            <span>{p.judged ?? 0} detail-checked</span>
          </div>
          {(p.failed ?? 0) > 0 && <p className="text-xs text-muted-foreground">{p.failed} AI errors{p.lastError ? ` · last: ${p.lastError}` : ""}</p>}
          {focus.status === "failed" && focus.error && <p className="text-sm text-destructive">{focus.error}</p>}
          {!live && canResume(focus) && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-3 text-sm">
              <span>Before resuming: stop after how many matches? (<b className="tabular">{focus.matchCount}</b> found so far)</span>
              <Input type="number" min={1} value={stopAt} onChange={(e) => setStopAt(e.target.value)} placeholder="empty = all data" className="h-8 w-36 tabular" />
              <span className="text-xs text-muted-foreground">Once this many matches are found, the analysis will stop and complete on its own.</span>
            </div>
          )}
          {liveAttempt && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-3 text-sm">
              <span><b className="tabular">{liveAttempt.matchCount}</b> matches found so far.</span>
              {(liveAttempt.progress.stopAt ?? 0) > 0 ? (
                <Badge variant="accent">Limit: will stop at {liveAttempt.progress.stopAt} matches</Badge>
              ) : (
                <span className="text-muted-foreground">No limit — all data will be checked.</span>
              )}
              <span>New limit:</span>
              <Input type="number" min={1} value={shrinkTo} onChange={(e) => setShrinkTo(e.target.value)} placeholder={`e.g. ${liveAttempt.matchCount + 5}`} className="h-8 w-28 tabular" />
              <Button size="sm" variant="outline" onClick={() => void shrink()} disabled={!shrinkTo}>Set</Button>
              <span className="text-xs text-muted-foreground">Once this many matches are found, the analysis will stop and complete on its own; the remaining people will not be checked.</span>
            </div>
          )}
        </CardContent>
      </Card>

      {focusRun && ranked.length > 0 && (
        <div className="mt-6 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="mr-2 text-lg font-bold text-foreground">Results</h2>
            <Badge variant="success"><Sparkles className="size-3" /> {ranked.length} people</Badge>
            <Badge variant="neutral">{ranked.length - notInLeads.length} in Leads</Badge>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Select value={sort} onValueChange={(v) => { setSort(v as typeof sort); setPage(0); }}>
                <SelectTrigger className="w-[160px]" aria-label="Sort results"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="best">Best match</SelectItem>
                  <SelectItem value="recent">Most recent</SelectItem>
                </SelectContent>
              </Select>
              {notInLeads.length > 0 && <Button variant="outline" size="sm" onClick={addAll}>Add the remaining {notInLeads.length} to Leads too</Button>}
              <Button asChild variant="link" size="sm"><Link to="/leads">View Leads →</Link></Button>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {pageItems.map((m) => {
              const added = inLeads(m);
              return (
                <Card key={m.personKey} className="shadow-card">
                  <CardContent className="space-y-3 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <a href={m.profileUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-foreground hover:text-primary">
                        {m.name} <ExternalLink className="size-3" />
                      </a>
                      <div className="flex shrink-0 gap-1.5">
                        <Badge variant="outline">{m.role === "poster" ? "Posted" : "Commented"}</Badge>
                        <Badge variant="accent" className="tabular">{m.score}%</Badge>
                      </div>
                    </div>
                    <p className="text-sm text-foreground">{m.reason}</p>
                    <blockquote className="border-l-2 border-primary pl-3 text-sm italic text-muted-foreground">“{m.quote}”</blockquote>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0 text-xs text-muted-foreground">
                        <p>{m.lastActiveAt ? `Last active ${fmtDate(m.lastActiveAt)}` : "Last active unknown"} · {m.activityCount} item{m.activityCount === 1 ? "" : "s"}</p>
                        {m.postUrl && (
                          <a href={m.postUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-primary">
                            {m.postTitle || "Post"} <ExternalLink className="size-3" />
                          </a>
                        )}
                      </div>
                      {added ? (
                        <Badge variant="success" className="shrink-0"><CheckCircle2 className="size-3" /> In Leads</Badge>
                      ) : (
                        <Button size="sm" onClick={() => addOne(m)} className="shrink-0"><Plus /> Add to Leads</Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
          {ranked.length > PAGE_SIZE && (
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>Page {safePage + 1} / {pages}</span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setPage(safePage - 1)} disabled={safePage === 0}>Previous</Button>
                <Button size="sm" variant="outline" onClick={() => setPage(safePage + 1)} disabled={safePage >= pages - 1}>Next</Button>
              </div>
            </div>
          )}
        </div>
      )}

      {!live && ranked.length === 0 && (
        <div className="mt-6">
          <EmptyState title="No matching person found yet">Resume, or write the query a bit broader and run a new analysis.</EmptyState>
        </div>
      )}
    </>
  );
}