import { Link } from "@tanstack/react-router";
import { ExternalLink, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { SourceAnalysisSheet } from "@/components/source-analysis-sheet";
import { SourceStatusBadge } from "@/components/badges";
import { EmptyState } from "@/components/page-header";
import { JobBanner, useLiveJob } from "@/components/sourcing-shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { uncheckedCounts } from "@/lib/analysis-client";
import { fmtDate, fmtNumber, shortUrl } from "@/lib/format";
import {
  addManualSource,
  listAgentSources,
  removeSource,
  startCollect,
  startScrape,
  type AgentJob,
  type AgentSource,
  type RejectedSource,
} from "@/lib/sourcing-client";
import { useStore } from "@/lib/store";

export function SourcesPanel() {
  const { state } = useStore();
  const accountId = state.activeAccountId;
  const agentUrl = state.settings.agentUrl;
  const { job, doneTick, online, refresh, finished, clearFinished } = useLiveJob();
  const [sources, setSources] = useState<AgentSource[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [scrapeFor, setScrapeFor] = useState<AgentSource | null>(null);
  const [panelFor, setPanelFor] = useState<AgentSource | null>(null);
  const [unchecked, setUnchecked] = useState<Record<string, { people: number; unchecked: number }>>({});

  const load = useCallback(async () => {
    if (!accountId) return;
    const r = await listAgentSources(agentUrl, accountId);
    if (r.ok) setSources(r.value.sources);
    setLoaded(true);
  }, [agentUrl, accountId]);

  // "N people haven't gone through AI yet" per source (refreshed when sources reload).
  useEffect(() => {
    if (!accountId || sources.length === 0) return;
    let off = false;
    void uncheckedCounts(agentUrl, accountId).then((r) => {
      if (!off && r.ok) setUnchecked(r.value.sources);
    });
    return () => {
      off = true;
    };
  }, [agentUrl, accountId, sources.length, doneTick]);

  // Reload when the account changes, when a job ends, and every few
  // seconds while a job runs (live "Scraped" counts).
  useEffect(() => {
    void load();
  }, [load, doneTick]);
  useEffect(() => {
    if (!job) return;
    const t = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(t);
  }, [job, load]);

  const running = !!job;

  const renderCheck = (s: AgentSource) => {
    if (s.postCount === 0) return <span className="text-muted-foreground">—</span>;
    const u = unchecked[s.id];
    if (!u) return <span className="text-xs text-muted-foreground">…</span>;
    return (
      <button type="button" onClick={() => setPanelFor(s)} title="View AI Analysis record">
        <Badge variant={u.unchecked > 0 ? "warning" : "success"}>
          {u.unchecked > 0 ? `${u.unchecked} people unchecked` : "No new data"}
        </Badge>
      </button>
    );
  };

  return (
    <Card className="shadow-card">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div>
          <CardTitle className="text-base">Sources</CardTitle>
          <CardDescription>
            Groups and pages the agent found or you added. Click a scraped count to see its posts.
          </CardDescription>
        </div>
        <Button onClick={() => setAddOpen(true)} disabled={!accountId || running}>
          <Plus /> Add Source
        </Button>
      </CardHeader>
      <CardContent className="px-0">
        {!accountId && (
          <div className="mx-6 mb-4 rounded-md border px-3 py-2 text-sm text-muted-foreground">
            No account yet — <Link to="/accounts" className="font-medium text-primary hover:underline">create an account</Link> first.
          </div>
        )}
        {!online && (
          <div className="mx-6 mb-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            The agent is not running — start run-agent.bat.
          </div>
        )}
        <JobBanner job={job} />
        {!job && finished && (
          <RejectedList
            job={finished}
            onAdded={() => void load()}
            onClose={clearFinished}
          />
        )}
        {loaded && sources.length === 0 ? (
          <div className="px-6">
            <EmptyState title="No sources yet">
              Click “Add Source”: enter a topic, how many you want, and pick a group/page — the agent will find them itself.
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
                <TableHead>Last scraped</TableHead>
                <TableHead className="text-right">Scraped</TableHead>
                <TableHead>AI check</TableHead>
                <TableHead className="pr-6">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sources.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="pl-6">
                    <button type="button" onClick={() => setPanelFor(s)} className="text-left font-semibold text-foreground hover:text-primary" title="View AI Analysis record">
                      {s.name || "(no name)"}
                    </button>
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
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{fmtDate(s.lastScrapedAt)}</TableCell>
                  <TableCell className="text-right tabular">
                    {s.postCount > 0 ? (
                      <Link
                        to="/data-sourcing/$sourceId"
                        params={{ sourceId: s.id }}
                        className="font-medium text-primary hover:underline"
                        title="View scraped posts"
                      >
                        {s.postCount} post{s.postCount === 1 ? "" : "s"}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {renderCheck(s)}
                  </TableCell>
                  <TableCell className="pr-6">
                    <RowActions
                      source={s}
                      disabled={running}
                      onScrap={() => setScrapeFor(s)}
                      onRemoved={() => void load()}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <SourceAnalysisSheet agentUrl={agentUrl} source={panelFor} onClose={() => setPanelFor(null)} />
      <AddSourceDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onStarted={() => {
          refresh();
          void load();
        }}
      />
      <ScrapeDialog
        source={scrapeFor}
        onClose={() => setScrapeFor(null)}
        onStarted={() => {
          refresh();
          void load();
        }}
      />
    </Card>
  );
}

function RejectedList({
  job,
  onAdded,
  onClose,
}: {
  job: AgentJob;
  onAdded: () => void;
  onClose: () => void;
}) {
  const { state } = useStore();
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const items = (job.result?.rejected ?? []).filter((r) => !hidden[r.url]);
  if (items.length === 0) return null;
  const add = async (r: RejectedSource) => {
    const res = await addManualSource(state.settings.agentUrl, {
      accountId: state.activeAccountId,
      name: r.name,
      url: r.url,
      memberCount: r.memberCount,
      status: "not-joined",
    });
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(`“${r.name}” added to the list`);
    setHidden((h) => ({ ...h, [r.url]: true }));
    onAdded();
  };
  return (
    <div className="mx-6 mb-4 rounded-md border">
      <div className="flex items-center justify-between border-b px-3 py-2 text-sm">
        <div>
          <span className="font-medium">Skipped by the agent ({items.length})</span>
          <span className="ml-2 text-muted-foreground">
            These are only temporary — they disappear on page refresh.
          </span>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>Hide</Button>
      </div>
      <div className="max-h-72 divide-y overflow-y-auto">
        {items.map((r) => (
          <div key={r.url} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
            <div className="min-w-0">
              <div className="truncate font-medium">{r.name}</div>
              <a href={r.url} target="_blank" rel="noreferrer" className="font-mono text-xs text-muted-foreground hover:text-primary">
                {shortUrl(r.url)}
              </a>
              <div className="text-xs text-amber-600">{r.why}</div>
            </div>
            <Button size="sm" variant="outline" onClick={() => void add(r)}>Add to list</Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function RowActions({
  source,
  disabled,
  onScrap,
  onRemoved,
}: {
  source: AgentSource;
  disabled: boolean;
  onScrap: () => void;
  onRemoved: () => void;
}) {
  const { state } = useStore();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );
  const onDelete = async () => {
    if (!armed) {
      setArmed(true);
      timer.current = window.setTimeout(() => setArmed(false), 8000);
      return;
    }
    if (timer.current) window.clearTimeout(timer.current);
    setArmed(false);
    setBusy(true);
    const r = await removeSource(state.settings.agentUrl, source.id, failed);
    setBusy(false);
    if (!r.ok) {
      toast.error(`${r.error} — clicking again removes only the record (Force delete).`);
      setFailed(true);
      return;
    }
    toast.success(`${source.name}: ${r.value.detail}`);
    onRemoved();
  };
  return (
    <div className="flex gap-1.5">
      <Button size="sm" disabled={disabled} onClick={onScrap} title="Scrape more posts from this source">
        Scrap
      </Button>
      <Button
        variant={armed ? "destructive" : "outline"}
        size="sm"
        disabled={disabled || busy}
        title="Leaves/unfollows on Facebook and removes the record"
        onClick={onDelete}
      >
        {busy ? "Deleting…" : armed ? (failed ? "Force delete?" : "Confirm delete?") : "Delete"}
      </Button>
    </div>
  );
}

function ScrapeDialog({
  source,
  onClose,
  onStarted,
}: {
  source: AgentSource | null;
  onClose: () => void;
  onStarted: () => void;
}) {
  const { state } = useStore();
  const [limit, setLimit] = useState("20");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!source) return;
    const n = Math.max(1, Math.min(200, Math.floor(Number(limit)) || 20));
    setBusy(true);
    const r = await startScrape(state.settings.agentUrl, {
      accountId: state.activeAccountId,
      source,
      limit: n,
    });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    toast.success(`Scraping started: ${source.name}`);
    onClose();
    onStarted();
  };
  return (
    <Dialog open={!!source} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Scrap posts</DialogTitle>
          <DialogDescription>
            {source?.name} — how many new posts should be scraped? Posts already saved won't come again.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="scrap-n">New posts (max)</Label>
          <Input id="scrap-n" type="number" min={1} max={200} value={limit} onChange={(e) => setLimit(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={go} disabled={busy}>Start scraping</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Mode = "agent" | "manual";

function AddSourceDialog({
  open,
  onOpenChange,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onStarted: () => void;
}) {
  const { state } = useStore();
  const accountId = state.activeAccountId;
  const agentUrl = state.settings.agentUrl;
  const [mode, setMode] = useState<Mode>("agent");
  const [topic, setTopic] = useState("");
  const [country, setCountry] = useState("");
  const [recheck, setRecheck] = useState(false);
  const [qty, setQty] = useState("5");
  const [kind, setKind] = useState<"group" | "page" | "both">("group");
  const [join, setJoin] = useState(true);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [members, setMembers] = useState("");
  const [busy, setBusy] = useState(false);

  const submitAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topic.trim()) {
      toast.error("Enter a topic / category (e.g. stock market Pakistan).");
      return;
    }
    const n = Math.floor(Number(qty));
    if (!Number.isFinite(n) || n < 1 || n > 50) {
      toast.error("Quantity must be between 1 and 50.");
      return;
    }
    setBusy(true);
    const r = await startCollect(agentUrl, {
      accountId,
      keyword: topic.trim(),
      country: country.trim(),
      recheck,
      type: kind,
      maxNew: n,
      join,
      minComments: state.settings.sourcing.minComments,
      minMembers: state.settings.sourcing.minMembers,
    });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    toast.success("The agent started the search");
    onOpenChange(false);
    onStarted();
  };

  const submitManual = async (e: React.FormEvent) => {
    e.preventDefault();
    const count = Number(members);
    if (!name.trim() || !url.trim() || members.trim() === "" || !Number.isInteger(count) || count < 0) {
      toast.error("Name, link, and members (a whole number) are required.");
      return;
    }
    setBusy(true);
    const r = await addManualSource(agentUrl, { accountId, name: name.trim(), url: url.trim(), memberCount: count });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    toast.success(`“${name.trim()}” added`);
    setName("");
    setUrl("");
    setMembers("");
    onOpenChange(false);
    onStarted();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add source</DialogTitle>
          <DialogDescription>
            Let the agent find them, or add your own group/page.
          </DialogDescription>
        </DialogHeader>
        <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
          <TabsList>
            <TabsTrigger value="agent">Find with the agent</TabsTrigger>
            <TabsTrigger value="manual">Add it yourself</TabsTrigger>
          </TabsList>
        </Tabs>
        {mode === "agent" ? (
          <form onSubmit={submitAgent} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="src-topic">Category / topic</Label>
              <Input id="src-topic" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. stock market Pakistan" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="src-country">Country (optional)</Label>
              <Input id="src-country" value={country} onChange={(e) => setCountry(e.target.value)} placeholder="e.g. Pakistan — leave empty for a general search" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="src-qty">How many (1–50)</Label>
              <Input id="src-qty" type="number" min={1} max={50} value={qty} onChange={(e) => setQty(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>What to look for</Label>
              <div className="flex flex-wrap gap-4 text-sm">
                {(["group", "page", "both"] as const).map((k) => (
                  <label key={k} className="flex items-center gap-1.5">
                    <input type="radio" name="src-kind" checked={kind === k} onChange={() => setKind(k)} />
                    {k === "group" ? "Groups" : k === "page" ? "Pages" : "Both"}
                  </label>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>When found</Label>
              <div className="space-y-1 text-sm">
                <label className="flex items-center gap-1.5">
                  <input type="radio" name="src-join" checked={join} onChange={() => setJoin(true)} />
                  Join groups / follow pages (and save in records)
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="radio" name="src-join" checked={!join} onChange={() => setJoin(false)} />
                  Only save in records (no join/follow)
                </label>
              </div>
            </div>
            <label className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={recheck} onChange={(e) => setRecheck(e.target.checked)} />
              Re-check groups rejected in the last 14 days
            </label>
            <p className="text-xs text-muted-foreground">
              The agent judges each group/page from several of its posts, checking whether comments/replies are really coming in
              (not just the first post). Min comments {state.settings.sourcing.minComments}, min members {state.settings.sourcing.minMembers} (from Configurations).
            </p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={!accountId || busy}>Start search</Button>
            </DialogFooter>
          </form>
        ) : (
          <form onSubmit={submitManual} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="m-name">Name</Label>
              <Input id="m-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="m-url">Link</Label>
              <Input id="m-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.facebook.com/groups/…" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="m-members">Members</Label>
              <Input id="m-members" type="number" min={0} value={members} onChange={(e) => setMembers(e.target.value)} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={!accountId || busy}>Add source</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}