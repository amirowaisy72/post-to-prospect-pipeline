import { Link, Outlet, createFileRoute, useChildMatches, useNavigate } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Info, Loader2, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { AiChat } from "@/components/ai-chat";
import { groupRuns, RunStatusBadge, useAutoSaveFinished } from "@/components/analysis-bits";
import { SourceAnalysisSheet } from "@/components/source-analysis-sheet";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  getTraining,
  isRunLive,
  listAnalyses,
  uncheckedCounts,
  startAnalysis,
  type AnalysisSummary,
  type Training,
} from "@/lib/analysis-client";
import { fmtDate } from "@/lib/format";
import { accountName } from "@/lib/leadhunter-service";
import { listAgentSources, type AgentSource } from "@/lib/sourcing-client";
import { useStore } from "@/lib/store";

const PAGE_SIZE = 10;

export const Route = createFileRoute("/analysis")({
  head: () => ({
    meta: [
      { title: "AI Analysis — LeadHunter" },
      { name: "description", content: "Describe the people you want and let AI find them in your collected posts, comments and replies." },
      { property: "og:title", content: "AI Analysis — LeadHunter" },
      { property: "og:description", content: "Describe the people you want and let AI find them in your collected posts, comments and replies." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AnalysisLayout,
});


function AnalysisLayout() {
  useAutoSaveFinished();
  const childMatches = useChildMatches();
  // One query opens on its own page and replaces this one.
  if (childMatches.length > 0) return <Outlet />;
  return <AnalysisHome />;
}

function AnalysisHome() {
  const { state } = useStore();
  const navigate = useNavigate();
  const accountId = state.activeAccountId;
  const agentUrl = state.settings.agentUrl;
  const account = state.accounts.find((a) => a.id === accountId);
  const accountBlocked = account?.status !== "active";
  const provider = state.settings.provider;
  const model = state.settings.model;
  const geminiKey = state.settings.geminiApiKey;
  const ollamaUrl = state.settings.ollamaUrl;
  const modelOk = !!model.trim() && (provider !== "gemini" || !!geminiKey.trim());

  const [sources, setSources] = useState<AgentSource[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [criteria, setCriteria] = useState("");
  const [quantity, setQuantity] = useState(state.settings.leadRules.defaultLeadsCount || 20);
  const [offline, setOffline] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [runs, setRuns] = useState<AnalysisSummary[]>([]);
  const [starting, setStarting] = useState(false);
  const [checkingTraining, setCheckingTraining] = useState(false);
  const [foundTraining, setFoundTraining] = useState<Training | null>(null);
  const [showTrainingPanel, setShowTrainingPanel] = useState(false);
  const [trainingMode, setTrainingMode] = useState(false);
  const [trainingCriteria, setTrainingCriteria] = useState("");
  const [page, setPage] = useState(0);
  const [counts, setCounts] = useState<Record<string, { people: number; unchecked: number }>>({});
  const [panelFor, setPanelFor] = useState<{ id: string; name: string } | null>(null);

  const leadUrls = state.leads.map((l) => l.profileUrl);
  const liveRun = runs.find((r) => isRunLive(r)) ?? null;
  const sourceName = useCallback((id: string) => sources.find((s) => s.id === id)?.name ?? "(deleted source)", [sources]);

  const loadRuns = useCallback(async () => {
    const r = await listAnalyses(agentUrl, accountId);
    if (r.ok) {
      setRuns(r.value.runs);
      setOffline(false);
    } else setOffline(true);
  }, [agentUrl, accountId]);

  useEffect(() => {
    let off = false;
    setSelected([]);
    setLoaded(false);
    void (async () => {
      const [s] = await Promise.all([listAgentSources(agentUrl, accountId), loadRuns()]);
      if (off) return;
      setOffline(!s.ok);
      if (s.ok) {
        const withPosts = s.value.sources.filter((x) => x.postCount > 0);
        setSources(withPosts);
        setSelected(withPosts.map((x) => x.id));
      }
      setLoaded(true);
    })();
    return () => {
      off = true;
    };
  }, [agentUrl, accountId, loadRuns]);

  useEffect(() => {
    let off = false;
    void uncheckedCounts(agentUrl, accountId).then((u) => !off && u.ok && setCounts(u.value.sources));
    return () => {
      off = true;
    };
  }, [agentUrl, accountId, runs.length, liveRun?.id]);

  useEffect(() => {
    const t = window.setInterval(() => void loadRuns(), liveRun ? 2500 : 8000);
    return () => window.clearInterval(t);
  }, [loadRuns, liveRun]);

  const settings = { provider, model: model.trim(), geminiKey, ollamaUrl, excludeUrls: leadUrls };

  const doStart = async (training?: Training, rescan = false) => {
    if (liveRun || starting) return;
    setStarting(true);
    const r = await startAnalysis(agentUrl, {
      ...settings,
      accountId,
      sourceIds: selected,
      criteria: criteria.trim(),
      quantity: Math.max(1, Math.floor(quantity) || 20),
      rescan,
      ...(training ? { training } : {}),
    });
    setStarting(false);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    void navigate({ to: "/analysis/$runId", params: { runId: r.value.id } });
  };

  /** Start click: check for saved training first, then train, then start. */
  const handleStartClick = async () => {
    if (liveRun || starting || checkingTraining || trainingMode) return;
    const crit = criteria.trim();
    setTrainingCriteria(crit);
    setCheckingTraining(true);
    const r = await getTraining(agentUrl, accountId, crit);
    setCheckingTraining(false);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    if (r.value.found) {
      setFoundTraining({ rules: r.value.rules ?? [], categories: r.value.categories ?? [] });
      setShowTrainingPanel(true);
    } else {
      setFoundTraining(null);
      setShowTrainingPanel(false);
      setTrainingMode(true);
    }
  };

  const start = handleStartClick;

  const canStart =
    !liveRun && !starting && !checkingTraining && !trainingMode && !accountBlocked && !offline && modelOk && selected.length > 0 && criteria.trim().length >= 5;

  const guide = (() => {
    if (offline) return { tone: "bad", text: "The agent is not running. Start run-agent.bat, then refresh the page." };
    if (loaded && sources.length === 0)
      return { tone: "info", text: "First scrape posts from a group/page on the Data Sourcing page. Then come back here." };
    if (liveRun) return { tone: "info", text: "An analysis is running. Click it in the list below to see its progress." };
    if (!modelOk) return { tone: "bad", text: "No AI model is set. Pick a model in Configurations, Test it, and Save." };
    if (selected.length === 0) return { tone: "info", text: "Step 1: on the left, pick the groups/pages whose data you want to check." };
    if (criteria.trim().length < 5) return { tone: "info", text: "Step 2: on the right, write who you are looking for (in your own words)." };
    return { tone: "ok", text: "Everything is ready. Click Start below. People already in Leads or already checked won't be sent again." };
  })();
  const guideClass =
    guide.tone === "bad"
      ? "border-destructive/40 bg-destructive/5 text-destructive"
      : guide.tone === "warn"
        ? "border-amber-500/40 bg-amber-500/10 text-foreground"
        : guide.tone === "ok"
          ? "border-primary/30 bg-accent/60 text-accent-foreground"
          : "bg-muted/50 text-foreground";

  const groups = groupRuns(runs);
  const gPages = Math.max(1, Math.ceil(groups.length / PAGE_SIZE));
  const gPage = Math.min(page, gPages - 1);
  const pageGroups = groups.slice(gPage * PAGE_SIZE, gPage * PAGE_SIZE + PAGE_SIZE);

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  return (
    <>
      <PageHeader
        title="AI Analysis"
        description="Pick data, write who you're looking for, and the AI will read every post, comment, and reply to find them."
      />

      <div className={`mb-6 flex items-start gap-2 rounded-lg border p-3 text-sm ${guideClass}`}>
        <Info className="mt-0.5 size-4 shrink-0" />
        <p>{guide.text}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="shadow-card lg:col-span-2">
          <CardHeader className="flex flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle className="text-base">1. Which data?</CardTitle>
              <CardDescription>
                {sources.length} group/page whose posts have been scraped · {accountName(state, accountId)}
              </CardDescription>
            </div>
            {sources.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setSelected(selected.length === sources.length ? [] : sources.map((s) => s.id))} disabled={trainingMode}>
                {selected.length === sources.length ? "Deselect all" : "Select all"}
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-2">
            {sources.length === 0 && loaded ? (
              <EmptyState title="No scraped posts yet">
                <Link to="/data-sourcing" className="font-semibold text-primary">Data Sourcing</Link> page — scrape posts there.
              </EmptyState>
            ) : (
              sources.map((s) => {
                const on = selected.includes(s.id);
                return (
                  <label key={s.id} className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors ${on ? "border-primary bg-accent/60" : "hover:bg-muted/50"}`}>
                    <Checkbox checked={on} onCheckedChange={() => toggle(s.id)} disabled={trainingMode} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-foreground">{s.name}</p>
                      <p className="text-xs text-muted-foreground tabular">{s.postCount} posts scraped</p>
                      {counts[s.id] && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          <Badge variant="outline" className="tabular">{counts[s.id]?.people ?? 0} unique people</Badge>
                          <Badge variant="success" className="tabular">{(counts[s.id]?.people ?? 0) - (counts[s.id]?.unchecked ?? 0)} checked</Badge>
                          <Badge variant="warning" className="tabular">{counts[s.id]?.unchecked ?? 0} new (no analysis yet)</Badge>
                        </div>
                      )}
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setPanelFor({ id: s.id, name: s.name });
                      }}
                    >
                      Detail
                    </Button>
                  </label>
                );
              })
            )}
          </CardContent>
        </Card>

        <Card className="h-fit shadow-card">
          <CardHeader>
            <CardTitle className="text-base">2. What are you looking for?</CardTitle>
            <CardDescription>In your own words, e.g. “People looking for software to create YouTube videos”.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="criteria">Who are you looking for?</Label>
              <Textarea id="criteria" rows={5} value={criteria} disabled={trainingMode} onChange={(e) => { setCriteria(e.target.value); setShowTrainingPanel(false); setFoundTraining(null); }} placeholder="e.g. People who need a software or tool to create YouTube videos faster and may pay for it." />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="qty">How many people?</Label>
              <Input id="qty" type="number" min={1} max={500} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} className="tabular" />
              <p className="text-xs text-muted-foreground">All data is checked; the best of these go to Leads.</p>
            </div>
            <div className="rounded-lg border bg-muted/40 p-3 text-sm">
              <p className="text-xs text-muted-foreground">AI model (from Configurations)</p>
              <p className="mt-0.5 font-semibold text-foreground">
                {provider === "ollama" ? "Ollama" : "Gemini"} · <span className="font-mono">{model || "—"}</span>
              </p>
              <Link to="/configurations" className="mt-1 inline-block text-xs font-semibold text-primary">
                To change or test the model, open Configurations →
              </Link>
              {provider === "gemini" && !geminiKey.trim() && <p className="mt-1 text-xs text-destructive">The Gemini key is not saved in Configurations.</p>}
            </div>
            {showTrainingPanel && foundTraining && (
              <div className="space-y-2 rounded-lg border border-primary/30 bg-accent/60 p-3 text-sm">
                <p className="font-semibold text-foreground">
                  Training found for this query — {foundTraining.rules.length} rule{foundTraining.rules.length === 1 ? "" : "s"}
                  , categories: {foundTraining.categories.length > 0 ? foundTraining.categories.join(", ") : "none"}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => void doStart(foundTraining, false)} disabled={starting}>
                    Use training
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setShowTrainingPanel(false);
                      setTrainingCriteria(criteria.trim());
                      setTrainingMode(true);
                    }}
                  >
                    Retrain
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void doStart(undefined, false)} disabled={starting}>
                    Run without training
                  </Button>
                </div>
              </div>
            )}
            <Button className="w-full" size="lg" onClick={() => void start()} disabled={!canStart}>
              {starting || checkingTraining ? <Loader2 className="animate-spin" /> : <Plus />}
              {checkingTraining ? "Checking training…" : "Start a new analysis"}
            </Button>
            {trainingMode && <p className="text-xs text-muted-foreground">Answer the questions in the chat below — the analysis starts once you save the training (or skip it).</p>}
            {liveRun && <p className="text-xs text-muted-foreground">Only one analysis can run at a time. Stop the running one first.</p>}
            {accountBlocked && (
              <p className="rounded-lg border border-primary/25 bg-accent/60 p-3 text-xs text-accent-foreground">
                This account is {account?.status ?? "not active"}. Activate it on the Accounts page.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-10">
        <h2 className="text-lg font-bold text-foreground">My analyses ({groups.length})</h2>
        <p className="mb-3 text-sm text-muted-foreground">One card per query. Click it to open its full record.</p>
        {loaded && groups.length === 0 ? (
          <EmptyState title="No analyses yet">Start your first query above.</EmptyState>
        ) : (
          <div className="space-y-3">
            {pageGroups.map((g) => {
              const newest = g.runs[0];
              return (
                <Link key={g.key} to="/analysis/$runId" params={{ runId: g.id }} className="block">
                  <Card className="shadow-card transition-colors hover:bg-muted/40">
                    <CardContent className="flex flex-wrap items-center gap-3 p-4">
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-2 text-sm font-semibold text-foreground">{g.criteria}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {g.sourceIds.map(sourceName).join(", ")} · {newest ? fmtDate(newest.createdAt) : ""}
                        </p>
                        {g.live && newest && <p className="mt-1 text-xs text-muted-foreground">{newest.progress.message}</p>}
                      </div>
                      <Badge variant="outline" className="tabular">{g.best} matches</Badge>
                      {newest && <RunStatusBadge run={newest} />}
                      <ChevronRight className="size-4 text-muted-foreground" />
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}
        {groups.length > PAGE_SIZE && (
          <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
            <span>Page {gPage + 1} / {gPages}</span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setPage(gPage - 1)} disabled={gPage === 0}>
                <ChevronLeft /> Previous
              </Button>
              <Button size="sm" variant="outline" onClick={() => setPage(gPage + 1)} disabled={gPage >= gPages - 1}>
                Next <ChevronRight />
              </Button>
            </div>
          </div>
        )}
      </div>

      <SourceAnalysisSheet agentUrl={agentUrl} source={panelFor} onClose={() => setPanelFor(null)} />
      {trainingMode ? (
        <AiChat
          key={`train-${accountId}`}
          trainingMode={{
            criteria: trainingCriteria,
            sourceIds: selected,
            onTrainingSaved: (t) => {
              setTrainingMode(false);
              void doStart(t, true);
            },
            onSkip: () => {
              setTrainingMode(false);
              void doStart(undefined, false);
            },
          }}
        />
      ) : (
        <AiChat key={accountId} />
      )}
    </>
  );
}