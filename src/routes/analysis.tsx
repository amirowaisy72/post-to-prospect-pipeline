import { createFileRoute, Link } from "@tanstack/react-router";
import { BrainCircuit, CheckCircle2, CopyX, ExternalLink, Loader2, ShieldX, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AgentDot } from "@/components/agent-status";
import { AiChat } from "@/components/ai-chat";
import { PriorityBadge } from "@/components/badges";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { accountName, agentFor, agentStatus, countReplies, type AnalysisResult } from "@/lib/leadhunter-service";
import { useActiveAccountData, useStore } from "@/lib/store";
import type { AiProvider } from "@/lib/types";

export const Route = createFileRoute("/analysis")({
  head: () => ({
    meta: [
      { title: "AI Analysis — LeadHunter" },
      { name: "description", content: "Analyse collected Facebook posts and find Rich Beginner and Rich Experienced leads." },
      { property: "og:title", content: "AI Analysis — LeadHunter" },
      { property: "og:description", content: "Analyse collected Facebook posts and find Rich Beginner and Rich Experienced leads." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AnalysisPage,
});

const STEPS = ["Loading post data", "Reading comments and replies", "Applying lead criteria", "Removing duplicates"];
const STEP_MS = 650;

function AnalysisPage() {
  const { state, runAnalysis, saveLeads, startAgentTask, finishAgentTask } = useStore();
  const { posts, accountId } = useActiveAccountData();
  const [selected, setSelected] = useState<string[]>([]);
  const [provider, setProvider] = useState<AiProvider>(state.settings.provider);
  const [model, setModel] = useState(state.settings.model);
  const [step, setStep] = useState(-1);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const timers = useRef<number[]>([]);

  // Switching account resets the page.
  useEffect(() => {
    setSelected([]);
    setResult(null);
    setStep(-1);
  }, [accountId]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const running = step >= 0;
  const agent = agentStatus(state, accountId);
  const agentTask = agentFor(state, accountId).task;
  const agentBlocked = !running && agent !== "free";
  const sourceName = (id: string) => state.sources.find((s) => s.id === id)?.name ?? "";
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const analyse = () => {
    const ids = [...selected];
    const total = STEPS.length * STEP_MS;
    // The account's agent does the analysis, so it is busy until the run ends.
    const label = `Analysing ${ids.length} post${ids.length === 1 ? "" : "s"}`;
    if (!startAgentTask(accountId, { kind: "analysing", label, expectedMs: total + 1000 })) return;
    setResult(null);
    setStep(0);
    STEPS.forEach((_, i) => {
      timers.current.push(window.setTimeout(() => setStep(i), i * STEP_MS));
    });
    timers.current.push(
      window.setTimeout(() => {
        const r = runAnalysis(ids);
        saveLeads(r.found, ids.length);
        setResult(r);
        setStep(-1);
        finishAgentTask(accountId);
      }, total),
    );
  };

  return (
    <>
      <PageHeader
        title="AI Analysis"
        description="Pick collected posts and an AI model. LeadHunter reads every comment and reply and returns leads that match your criteria."
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="shadow-card lg:col-span-2">
          <CardHeader className="flex flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle className="text-base">1. Pick posts</CardTitle>
              <CardDescription>{posts.length} collected for {accountName(state, accountId)}</CardDescription>
            </div>
            {posts.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelected(selected.length === posts.length ? [] : posts.map((p) => p.id))}
                disabled={running}
              >
                {selected.length === posts.length ? "Clear" : "Select all"}
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-2">
            {posts.length === 0 ? (
              <EmptyState title="No collected posts for this account">
                Add post data on the <Link to="/data-sourcing" className="font-semibold text-primary">Data Sourcing</Link> page first.
              </EmptyState>
            ) : (
              posts.map((p) => {
                const on = selected.includes(p.id);
                return (
                  <label
                    key={p.id}
                    className={`flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors ${on ? "border-primary bg-accent/60" : "hover:bg-muted/50"}`}
                  >
                    <Checkbox checked={on} onCheckedChange={() => toggle(p.id)} disabled={running} className="mt-0.5" />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-2 text-sm">
                        <span className="font-semibold text-foreground">{p.author.name}</span>
                        <span className="text-xs text-muted-foreground">in {sourceName(p.sourceId)}</span>
                      </div>
                      <p className="line-clamp-2 text-sm text-muted-foreground">{p.text}</p>
                      <p className="mt-1 text-xs text-muted-foreground tabular">
                        {p.comments.length} comments · {countReplies(p)} replies
                      </p>
                    </div>
                  </label>
                );
              })
            )}
          </CardContent>
        </Card>

        <Card className="h-fit shadow-card">
          <CardHeader>
            <CardTitle className="text-base">2. AI model</CardTitle>
            <CardDescription>Defaults come from Configurations.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Provider</Label>
              <Select value={provider} onValueChange={(v) => setProvider(v as AiProvider)} disabled={running}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ollama">Ollama (Local)</SelectItem>
                  <SelectItem value="gemini">Gemini</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="model">Model name</Label>
              <Input id="model" value={model} onChange={(e) => setModel(e.target.value)} className="font-mono text-sm" disabled={running} />
            </div>
            <Button className="w-full" size="lg" onClick={analyse} disabled={running || agentBlocked || selected.length === 0 || !model.trim()}>
              {running ? <Loader2 className="animate-spin" /> : <BrainCircuit />}
              {running ? "Analysing…" : `Analyse ${selected.length || ""} post${selected.length === 1 ? "" : "s"}`}
            </Button>
            {agentBlocked && (
              <div className="flex gap-2 rounded-lg border border-primary/25 bg-accent/60 p-3 text-xs text-accent-foreground">
                <AgentDot status={agent} className="mt-1" />
                <p>
                  {agent === "busy"
                    ? <>This account's agent is busy: <span className="font-semibold">{agentTask?.label}</span>. Wait for it to finish, or stop it from the agent button in the top bar.</>
                    : "This account is paused or blocked, so its agent is offline. Set it to Active on the Accounts page."}
                </p>
              </div>
            )}
            <p className="text-xs text-muted-foreground">Simulated for now — real AI calls arrive with the backend.</p>
          </CardContent>
        </Card>
      </div>

      {running && (
        <Card className="mt-6 overflow-hidden shadow-card">
          <div className="relative h-1 overflow-hidden bg-muted">
            <div className="absolute inset-y-0 w-1/4 animate-scan bg-primary" />
          </div>
          <CardContent className="space-y-4 p-6">
            <div className="flex items-center justify-between text-sm">
              <span className="font-semibold text-foreground">
                {provider === "ollama" ? "Ollama" : "Gemini"} · <span className="font-mono">{model}</span>
              </span>
              <span className="text-muted-foreground tabular">{Math.round(((step + 1) / STEPS.length) * 100)}%</span>
            </div>
            <Progress value={((step + 1) / STEPS.length) * 100} />
            <ol className="grid gap-2 sm:grid-cols-4">
              {STEPS.map((s, i) => (
                <li key={s} className={`flex items-center gap-2 text-sm ${i <= step ? "text-foreground" : "text-muted-foreground"}`}>
                  {i < step ? <CheckCircle2 className="size-4 text-success" /> : i === step ? <Loader2 className="size-4 animate-spin text-primary" /> : <span className="size-4 rounded-full border" />}
                  {s}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      )}

      {result && <AnalysisResults result={result} />}

      <AiChat key={accountId} />
    </>
  );
}

function AnalysisResults({ result }: { result: AnalysisResult }) {
  return (
    <div className="mt-6 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-2 text-lg font-bold text-foreground">Results</h2>
        <Badge variant="success"><Sparkles className="size-3" /> {result.found.length} new leads</Badge>
        <Badge variant="neutral"><CopyX className="size-3" /> {result.duplicates.length} already in Leads</Badge>
        <Badge variant="danger"><ShieldX className="size-3" /> {result.rejected.length} rejected by criteria</Badge>
        {result.found.length > 0 && (
          <Button asChild variant="link" size="sm" className="ml-auto">
            <Link to="/leads">Review in Leads →</Link>
          </Button>
        )}
      </div>

      {result.found.length === 0 ? (
        <EmptyState title="No new leads in these posts">Everyone who matched is already in Leads or was rejected.</EmptyState>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {result.found.map((l) => (
            <Card key={l.id} className="shadow-card">
              <CardContent className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-2">
                  <a href={l.profileUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-foreground hover:text-primary">
                    {l.name} <ExternalLink className="size-3" />
                  </a>
                  <PriorityBadge priority={l.priority} />
                </div>
                <p className="text-sm text-foreground">{l.reason}</p>
                <blockquote className="border-l-2 border-primary pl-3 text-sm italic text-muted-foreground">“{l.quotedComment}”</blockquote>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {(result.duplicates.length > 0 || result.rejected.length > 0) && (
        <Card className="shadow-card">
          <CardContent className="grid gap-6 p-4 md:grid-cols-2">
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Skipped — already in Leads</p>
              <ul className="space-y-1 text-sm">
                {result.duplicates.map((d) => (
                  <li key={d.profileUrl} className="flex items-center justify-between gap-2">
                    <span className="text-foreground">{d.name}</span>
                    <span className="text-xs text-muted-foreground capitalize">{d.existing.status}</span>
                  </li>
                ))}
                {result.duplicates.length === 0 && <li className="text-muted-foreground">None</li>}
              </ul>
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Rejected — spam, tip or course sellers</p>
              <ul className="space-y-1 text-sm">
                {result.rejected.map((r) => (
                  <li key={r.profileUrl}>
                    <span className="text-foreground">{r.name}</span>
                    <span className="text-xs text-muted-foreground"> — {r.reason}</span>
                  </li>
                ))}
                {result.rejected.length === 0 && <li className="text-muted-foreground">None</li>}
              </ul>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
