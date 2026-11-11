import { Link, Outlet, createFileRoute, useChildMatches } from "@tanstack/react-router";
import { ExternalLink, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { SourceStatusBadge } from "@/components/badges";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AGENT_NOT_RUNNING_MESSAGE } from "@/lib/agent-client";
import { accountName, runningJobForSource, scrapedCount } from "@/lib/leadhunter-service";
import { fmtDate, fmtNumber, shortUrl } from "@/lib/format";
import { useStore } from "@/lib/store";
import { useAgentHealth } from "@/lib/use-agent-health";
import type { SourceType } from "@/lib/types";

export const Route = createFileRoute("/data-sourcing")({
  head: () => ({
    meta: [
      { title: "Data Sourcing — LeadHunter" },
      { name: "description", content: "Join Facebook groups and pages and collect post data with comments and replies." },
      { property: "og:title", content: "Data Sourcing — LeadHunter" },
      { property: "og:description", content: "Join Facebook groups and pages and collect post data with comments and replies." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DataSourcingPage,
});

function DataSourcingPage() {
  // The per-source posts page (/data-sourcing/$sourceId) and the post
  // detail page are nested routes: when one matches, it REPLACES the
  // sources table instead of rendering underneath it.
  const childMatches = useChildMatches();
  if (childMatches.length > 0) return <Outlet />;

  return (
    <>
      <PageHeader
        title="Data Sourcing"
        description="Groups and pages your accounts have joined, and the posts collected from them."
      />
      <div className="space-y-6">
        <SourcesSection />
      </div>
    </>
  );
}

/* ---------------- Sources ---------------- */

function SourcesSection() {
  const { state, stopJob } = useStore();
  const { reachable, refresh } = useAgentHealth();
  const accountId = state.activeAccountId;
  const [filter, setFilter] = useState<"all" | "mine">("all");
  const [open, setOpen] = useState(false);

  const rows = useMemo(() => {
    // Only joined groups/pages are listed.
    const list = state.sources.filter((s) =>
      filter === "mine" ? s.joinedByAccountId === accountId : !!s.joinedByAccountId,
    );
    const rank = (id: string | null) => (id === accountId ? 0 : 1);
    return [...list].sort((a, b) => rank(a.joinedByAccountId) - rank(b.joinedByAccountId));
  }, [state.sources, filter, accountId]);

  // A collect job (Add Source) has no source row — show its progress
  // as a banner above the table instead.
  const collectJob = state.jobs.find((j) => j.kind === "collect" && (j.status === "running" || j.status === "stop-requested"));
  const lastCollectJob = state.jobs.find((j) => j.kind === "collect" && (j.status === "done" || j.status === "failed" || j.status === "stopped"));

  return (
    <Card className="shadow-card">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div>
          <CardTitle className="text-base">Sources</CardTitle>
          <CardDescription>A group or page can be joined by one account only.</CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Tabs value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
            <TabsList>
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="mine">Joined by me</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button onClick={() => setOpen(true)} disabled={!accountId}>
            <Plus /> Add Source
          </Button>
        </div>
      </CardHeader>
      <CardContent className="px-0">
        {reachable === false && (
          <div className="mx-6 mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <span>{AGENT_NOT_RUNNING_MESSAGE}</span>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              Recheck
            </Button>
          </div>
        )}
        {!accountId && (
          <div className="mx-6 mb-4 rounded-md border px-3 py-2 text-sm text-muted-foreground">
            No account yet — <Link to="/accounts" className="font-medium text-primary hover:underline">create an account</Link> first.
            Sources belong to the account that collects them.
          </div>
        )}
        {collectJob && (
          <div className="mx-6 mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
            <span>
              Collecting sources… {collectJob.postsProcessed} checked, {collectJob.newPosts} joined
            </span>
            <Button variant="outline" size="sm" onClick={() => void stopJob(collectJob.id)}>
              Stop
            </Button>
          </div>
        )}
        {lastCollectJob?.status === "failed" && (
          <div className="mx-6 mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            Last collect failed: {lastCollectJob.error ?? "unknown error"}
          </div>
        )}
        {rows.length === 0 ? (
          <div className="px-6">
            <EmptyState title={accountId ? "No sources here yet" : "No account yet"}>
              {accountId
                ? "Add a source: search Facebook by keyword — the agent joins groups that pass the comments and member gates."
                : "Create an account first, then add a source."}
            </EmptyState>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Members</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Joined by</TableHead>
                <TableHead>Last scraped</TableHead>
                <TableHead className="text-right">Scraped</TableHead>
                <TableHead className="pr-6">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((s) => {
                const mine = s.joinedByAccountId === accountId;
                const count = scrapedCount(state, s.id);
                return (
                  <TableRow key={s.id}>
                    <TableCell className="pl-6">
                      <div className="font-semibold text-foreground">{s.name}</div>
                      {s.url && (
                        <a href={s.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-primary">
                          {shortUrl(s.url)} <ExternalLink className="size-3" />
                        </a>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">{s.type}</Badge>
                    </TableCell>
                    <TableCell className="text-right tabular">{s.memberCount ? fmtNumber(s.memberCount) : "—"}</TableCell>
                    <TableCell><SourceStatusBadge status={s.status} /></TableCell>
                    <TableCell className="text-sm">
                      {s.joinedByAccountId ? (
                        <span className={mine ? "font-semibold text-foreground" : "text-muted-foreground"}>
                          {accountName(state, s.joinedByAccountId)}
                          {mine && " (you)"}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{fmtDate(s.lastScrapedAt)}</TableCell>
                    <TableCell className="text-right tabular">
                      {count > 0 ? (
                        <Link
                          to="/data-sourcing/$sourceId"
                          params={{ sourceId: s.id }}
                          className="font-medium text-primary hover:underline"
                          title="View scraped posts"
                        >
                          {count} post{count === 1 ? "" : "s"}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </TableCell>
                    <TableCell className="pr-6">
                      <SourceActions sourceId={s.id} reachable={reachable} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <AddSourceDialog open={open} onOpenChange={setOpen} />
    </Card>
  );
}

/** Per-row Scrap / Sync / Stop / Delete. While a job runs for this
 * source the buttons are replaced by its progress and a Stop button. */
function SourceActions({ sourceId, reachable }: { sourceId: string; reachable: boolean | null }) {
  const { state, startScrape, startSync, stopJob, deleteSource } = useStore();
  const job = runningJobForSource(state, sourceId);
  const count = scrapedCount(state, sourceId);
  // Most recent job for this source, so an incomplete run stays
  // visible after its toast disappears — until a later run succeeds.
  const latestJob = state.jobs.find((j) => j.sourceId === sourceId);
  const lastJob =
    latestJob && (latestJob.status === "incomplete" || latestJob.status === "failed") ? latestJob : undefined;
  const [armed, setArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const armTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (armTimer.current) window.clearTimeout(armTimer.current);
    },
    [],
  );

  const onDelete = () => {
    if (!armed) {
      setArmed(true);
      armTimer.current = window.setTimeout(() => setArmed(false), 8000);
      return;
    }
    if (armTimer.current) window.clearTimeout(armTimer.current);
    setArmed(false);
    setDeleting(true);
    void deleteSource(sourceId).finally(() => setDeleting(false));
  };

  if (job) {
    return (
      <div className="flex flex-col gap-1">
        <span className="whitespace-nowrap text-xs text-muted-foreground">
          {job.kind === "scrape" ? "Scraping" : "Syncing"}… {job.postsProcessed} processed, {job.newPosts} new
        </span>
        <div>
          <Button variant="outline" size="sm" onClick={() => void stopJob(job.id)}>
            Stop
          </Button>
        </div>
      </div>
    );
  }
  const agentDown = reachable === false;
  const agentReason = agentDown ? AGENT_NOT_RUNNING_MESSAGE : undefined;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-1.5">
        <Button variant="outline" size="sm" disabled={agentDown} title={agentReason} onClick={() => void startScrape(sourceId)}>
          Scrap
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={agentDown || count === 0}
          title={agentDown ? agentReason : count === 0 ? "No collected posts to sync yet" : undefined}
          onClick={() => void startSync(sourceId)}
        >
          Sync
        </Button>
        <Button
          variant={armed ? "destructive" : "outline"}
          size="sm"
          disabled={agentDown || deleting}
          title={
            agentDown
              ? agentReason
              : armed
                ? "Click again to confirm — this leaves the group/page on Facebook and removes it from everywhere"
                : "Leave the group/page on Facebook and remove it from everywhere"
          }
          onClick={onDelete}
        >
          {deleting ? "Deleting…" : armed ? "Confirm delete?" : "Delete"}
        </Button>
      </div>
      {lastJob?.status === "incomplete" && (
        <span className="max-w-56 text-xs text-amber-600">
          Last {lastJob.kind}:{" "}
          {lastJob.verification
            .filter((v) => !v.complete)
            .map((v) => `collected ${v.collectedComments} of ${v.expectedComments ?? "?"} — ${v.missing ?? "?"} missing`)
            .join("; ")}
        </span>
      )}
      {lastJob?.status === "failed" && (
        <span className="max-w-56 text-xs text-destructive">Last {lastJob.kind} failed: {lastJob.error ?? "unknown error"}</span>
      )}
    </div>
  );
}

type CollectType = SourceType | "both";

/**
 * Add Source = keyword search + collect, exactly like client-hunting.
 * The Name field is the search keyword; Type filters Group/Page (or
 * both); "Number of groups" is how many good sources to collect at
 * most. The agent searches Facebook, applies the comments gate and
 * the member gate from Configurations, joins the good groups, and
 * lists them here. There is no URL input anywhere.
 */
function AddSourceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { collectSources, state } = useStore();
  const [keyword, setKeyword] = useState("");
  const [type, setType] = useState<CollectType>("group");
  const [quantity, setQuantity] = useState("");
  const [busy, setBusy] = useState(false);
  const qty = Number(quantity);
  const validQty = Number.isInteger(qty) && qty >= 1;
  const typeLabel = type === "group" ? "groups" : type === "page" ? "pages" : "groups/pages";

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!keyword.trim() || !validQty) return;
    setBusy(true);
    void collectSources({ keyword: keyword.trim(), type, maxNew: qty })
      .then((ok) => {
        if (ok) {
          setKeyword("");
          setQuantity("");
          onOpenChange(false);
        }
      })
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add source</DialogTitle>
          <DialogDescription>
            Search Facebook by keyword. The agent joins up to {quantity || "N"} active {typeLabel} with posts and comments
            (at least {state.settings.sourcing.minComments} comments and {state.settings.sourcing.minMembers} members —
            see Configurations), and lists them here. Dead sources are never saved.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="src-name">Keyword</Label>
            <Input
              id="src-name"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="e.g. stock market"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as CollectType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="group">Group</SelectItem>
                <SelectItem value="page">Page</SelectItem>
                <SelectItem value="both">Groups + Pages</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="src-number">Number of {typeLabel}</Label>
            <Input
              id="src-number"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="e.g. 10"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!keyword.trim() || !validQty || busy}>
              {busy ? "Starting…" : "Search & collect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
