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
  isRunLive,
  listAnalyses,
  uncheckedCounts,
  startAnalysis,
  type AnalysisSummary,
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

  const start = async () => {
    if (liveRun || starting) return;
    setStarting(true);
    const r = await startAnalysis(agentUrl, {
      ...settings,
      accountId,
      sourceIds: selected,
      criteria: criteria.trim(),
      quantity: Math.max(1, Math.floor(quantity) || 20),
      rescan: false,
    });
    setStarting(false);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    void navigate({ to: "/analysis/$runId", params: { runId: r.value.id } });
  };

  const canStart =
    !liveRun && !starting && !accountBlocked && !offline && modelOk && selected.length > 0 && criteria.trim().length >= 5;

  const guide = (() => {
    if (offline) return { tone: "bad", text: "Agent chal nahi raha. run-agent.bat chalayen, phir page refresh karein." };
    if (loaded && sources.length === 0)
      return { tone: "info", text: "Pehle Data Sourcing page par kisi group/page ki posts scrape karein. Phir yahan wapas aayein." };
    if (liveRun) return { tone: "info", text: "Ek analysis chal rahi hai. Neeche list mein us par click karke progress dekhein." };
    if (!modelOk) return { tone: "bad", text: "AI model set nahi hai. Configurations mein model chun kar Test karein aur Save karein." };
    if (selected.length === 0) return { tone: "info", text: "Step 1: left side se woh groups/pages chunein jin ka data check karna hai." };
    if (criteria.trim().length < 5) return { tone: "info", text: "Step 2: right side par likhein ke aap kin logon ko dhoond rahe hain (apne alfaaz mein)." };
    return { tone: "ok", text: "Sab tayyar hai. Neeche Start dabayein. Jo log Leads mein hain ya pehle check ho chuke, unhein dobara nahi bheja jayega." };
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
        description="Data chunein, likhein kin logon ko dhoondna hai, aur AI har post, comment aur reply parh kar unhein dhoond dega."
      />

      <div className={`mb-6 flex items-start gap-2 rounded-lg border p-3 text-sm ${guideClass}`}>
        <Info className="mt-0.5 size-4 shrink-0" />
        <p>{guide.text}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="shadow-card lg:col-span-2">
          <CardHeader className="flex flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle className="text-base">1. Kis data par?</CardTitle>
              <CardDescription>
                {sources.length} group/page jin ki posts scrape ho chuki hain · {accountName(state, accountId)}
              </CardDescription>
            </div>
            {sources.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setSelected(selected.length === sources.length ? [] : sources.map((s) => s.id))}>
                {selected.length === sources.length ? "Sab hatayen" : "Sab chunein"}
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-2">
            {sources.length === 0 && loaded ? (
              <EmptyState title="Abhi koi scraped posts nahi">
                <Link to="/data-sourcing" className="font-semibold text-primary">Data Sourcing</Link> page par posts scrape karein.
              </EmptyState>
            ) : (
              sources.map((s) => {
                const on = selected.includes(s.id);
                return (
                  <label key={s.id} className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors ${on ? "border-primary bg-accent/60" : "hover:bg-muted/50"}`}>
                    <Checkbox checked={on} onCheckedChange={() => toggle(s.id)} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-foreground">{s.name}</p>
                      <p className="text-xs text-muted-foreground tabular">{s.postCount} posts scraped</p>
                      {counts[s.id] && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          <Badge variant="outline" className="tabular">{counts[s.id]?.people ?? 0} unique log</Badge>
                          <Badge variant="success" className="tabular">{(counts[s.id]?.people ?? 0) - (counts[s.id]?.unchecked ?? 0)} check ho chuke</Badge>
                          <Badge variant="warning" className="tabular">{counts[s.id]?.unchecked ?? 0} naye (abhi koi analysis nahi)</Badge>
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
            <CardTitle className="text-base">2. Kya dhoondna hai?</CardTitle>
            <CardDescription>Apne alfaaz mein likhein, jaise “Jo log YouTube ke liye software dhoond rahe hain”.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="criteria">Kin logon ko dhoondna hai?</Label>
              <Textarea id="criteria" rows={5} value={criteria} onChange={(e) => setCriteria(e.target.value)} placeholder="e.g. People who need a software or tool to create YouTube videos faster and may pay for it." />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="qty">Kitne log chahiye?</Label>
              <Input id="qty" type="number" min={1} max={500} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} className="tabular" />
              <p className="text-xs text-muted-foreground">Sab data check hota hai; behtareen itne log Leads mein chale jate hain.</p>
            </div>
            <div className="rounded-lg border bg-muted/40 p-3 text-sm">
              <p className="text-xs text-muted-foreground">AI model (Configurations se)</p>
              <p className="mt-0.5 font-semibold text-foreground">
                {provider === "ollama" ? "Ollama" : "Gemini"} · <span className="font-mono">{model || "—"}</span>
              </p>
              <Link to="/configurations" className="mt-1 inline-block text-xs font-semibold text-primary">
                Model badalna ya test karna ho to Configurations kholen →
              </Link>
              {provider === "gemini" && !geminiKey.trim() && <p className="mt-1 text-xs text-destructive">Gemini key Configurations mein save nahi hai.</p>}
            </div>
            <Button className="w-full" size="lg" onClick={() => void start()} disabled={!canStart}>
              {starting ? <Loader2 className="animate-spin" /> : <Plus />}
              Naya analysis shuru karein
            </Button>
            {liveRun && <p className="text-xs text-muted-foreground">Ek waqt mein ek analysis chal sakti hai. Pehle chalti hui ko Stop karein.</p>}
            {accountBlocked && (
              <p className="rounded-lg border border-primary/25 bg-accent/60 p-3 text-xs text-accent-foreground">
                Ye account {account?.status ?? "active nahi"} hai. Accounts page par Active karein.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-10">
        <h2 className="text-lg font-bold text-foreground">Meri analyses ({groups.length})</h2>
        <p className="mb-3 text-sm text-muted-foreground">Har query ka ek card. Click karein to us ka poora record khulega.</p>
        {loaded && groups.length === 0 ? (
          <EmptyState title="Abhi koi analysis nahi">Upar se pehli query shuru karein.</EmptyState>
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
                <ChevronLeft /> Pichla
              </Button>
              <Button size="sm" variant="outline" onClick={() => setPage(gPage + 1)} disabled={gPage >= gPages - 1}>
                Agla <ChevronRight />
              </Button>
            </div>
          </div>
        )}
      </div>

      <SourceAnalysisSheet agentUrl={agentUrl} source={panelFor} onClose={() => setPanelFor(null)} />
      <AiChat key={accountId} />
    </>
  );
}