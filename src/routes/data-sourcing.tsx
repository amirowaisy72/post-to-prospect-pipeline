import { createFileRoute } from "@tanstack/react-router";
import { ExternalLink, Plus, Upload } from "lucide-react";
import { useMemo, useRef, useState } from "react";

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
import { Textarea } from "@/components/ui/textarea";
import { accountName, countReplies, parsePostDataJson, SAMPLE_POST_JSON } from "@/lib/leadhunter-service";
import type { PostImportResult } from "@/lib/leadhunter-service";
import { fmtDate, fmtNumber, shortUrl } from "@/lib/format";
import { useActiveAccountData, useStore } from "@/lib/store";
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
  return (
    <>
      <PageHeader
        title="Data Sourcing"
        description="Groups and pages your accounts have joined, and the posts collected from them."
      />
      <div className="space-y-6">
        <SourcesSection />
        <CollectedPostsSection />
      </div>
    </>
  );
}

/* ---------------- Sources ---------------- */

function SourcesSection() {
  const { state } = useStore();
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
          <Button onClick={() => setOpen(true)}>
            <Plus /> Add Source
          </Button>
        </div>
      </CardHeader>
      <CardContent className="px-0">
        {rows.length === 0 ? (
          <div className="px-6">
            <EmptyState title="No sources here yet" />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Number</TableHead>
                <TableHead className="text-right">Members</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Joined by</TableHead>
                <TableHead className="pr-6">Last scraped</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((s) => {
                const mine = s.joinedByAccountId === accountId;
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
                    <TableCell className="text-right tabular">{s.quantity ? fmtNumber(s.quantity) : "—"}</TableCell>
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
                    <TableCell className="whitespace-nowrap pr-6 text-sm text-muted-foreground">{fmtDate(s.lastScrapedAt)}</TableCell>
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

function AddSourceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { addSource } = useStore();
  const [name, setName] = useState("");
  const [type, setType] = useState<SourceType>("group");
  const [quantity, setQuantity] = useState("");
  const qty = Number(quantity);
  const validQty = Number.isInteger(qty) && qty >= 1;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (addSource({ name, type, quantity: qty })) {
      setName("");
      setQuantity("");
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add source</DialogTitle>
          <DialogDescription>Enter how many groups or pages to add. It will be listed as joined by this account.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="src-name">Name</Label>
            <Input id="src-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Lahore Investors Circle" />
          </div>
          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as SourceType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="group">Group</SelectItem>
                <SelectItem value="page">Page</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="src-number">Number of {type === "group" ? "groups" : "pages"}</Label>
            <Input id="src-number" type="number" inputMode="numeric" min={1} step={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="e.g. 10" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!name.trim() || !validQty}>Add source</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- Collected posts ---------------- */

function CollectedPostsSection() {
  const { state } = useStore();
  const { posts, accountId } = useActiveAccountData();
  const [open, setOpen] = useState(false);

  return (
    <Card className="shadow-card">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div>
          <CardTitle className="text-base">Collected Posts</CardTitle>
          <CardDescription>
            PostData collected by the Chrome extension — one post with its comments and replies.
          </CardDescription>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus /> Add Post Data
        </Button>
      </CardHeader>
      <CardContent className="px-0">
        {posts.length === 0 ? (
          <div className="px-6">
            <EmptyState title="No posts collected yet">
              Collect a Facebook post with the Chrome extension, then import the _structured.json file here.
            </EmptyState>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Post</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Comments</TableHead>
                <TableHead className="text-right">Replies</TableHead>
                <TableHead className="pr-6">Collected</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {posts.map((p) => {
                const source = state.sources.find((s) => s.id === p.sourceId);
                return (
                  <TableRow key={p.id}>
                    <TableCell className="pl-6">
                      <div className="font-semibold text-foreground">{p.author.name}</div>
                      <div className="line-clamp-2 max-w-md text-sm text-muted-foreground">{p.text}</div>
                      {p.postUrl && (
                        <a href={p.postUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-primary">
                          {shortUrl(p.postUrl)} <ExternalLink className="size-3" />
                        </a>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">{source?.name ?? "—"}</TableCell>
                    <TableCell className="text-right tabular">{p.comments.length}</TableCell>
                    <TableCell className="text-right tabular">{countReplies(p)}</TableCell>
                    <TableCell className="whitespace-nowrap pr-6 text-sm text-muted-foreground">{fmtDate(p.collectedAt)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <AddPostDataDialog open={open} onOpenChange={setOpen} />
    </Card>
  );
}

type PreviewRow =
  | { key: string; label: string; status: "ready"; author: string; comments: number; replies: number }
  | { key: string; label: string; status: "already"; accountName: string }
  | { key: string; label: string; status: "error"; reason: string };

function AddPostDataDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { state, addPosts } = useStore();
  const { joinedSources } = useActiveAccountData();
  const [raw, setRaw] = useState("");
  const [fileName, setFileName] = useState("");
  const [sourceId, setSourceId] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const parsed: PostImportResult | null = useMemo(
    () => (raw.trim() ? parsePostDataJson(raw, state) : null),
    [raw, state],
  );

  const preview: PreviewRow[] = useMemo(() => {
    if (!parsed) return [];
    const rows: PreviewRow[] = parsed.drafts.map((d) => ({
      key: `ready-${d.postUrl}`,
      label: d.postUrl,
      status: "ready" as const,
      author: d.author.name,
      comments: d.comments.length,
      replies: countReplies(d),
    }));
    for (const a of parsed.alreadyCollected) {
      rows.push({ key: `already-${a.postUrl}`, label: a.postUrl, status: "already", accountName: a.accountName });
    }
    for (const e of parsed.errors) {
      rows.push({ key: `error-${e.label}`, label: e.label, status: "error", reason: e.reason });
    }
    return rows;
  }, [parsed]);

  const effectiveSourceId = sourceId || joinedSources[0]?.id || "";

  const openDialog = (o: boolean) => {
    if (o && !sourceId) setSourceId(joinedSources[0]?.id ?? "");
    onOpenChange(o);
  };

  const onFile = (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => setRaw(String(reader.result ?? ""));
    reader.readAsText(file);
  };

  const doImport = () => {
    if (!parsed || parsed.drafts.length === 0 || !effectiveSourceId) return;
    addPosts(parsed.drafts, effectiveSourceId);
    setRaw("");
    setFileName("");
    setSourceId("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={openDialog}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add post data</DialogTitle>
          <DialogDescription>
            Paste a PostData JSON object, or upload the _structured.json file from the Chrome extension.
            It can hold one post, a posts wrapper, or a bare array of posts.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="post-json">Post data (JSON)</Label>
            <Textarea
              id="post-json"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder='{"posts": [{ "postUrl": "https://facebook.com/...", "author": {...}, "text": "...", "comments": [...] }]}'
              rows={8}
              className="font-mono text-xs"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => onFile(e.target.files?.[0])}
            />
            <Button type="button" variant="outline" onClick={() => fileRef.current?.click()}>
              <Upload /> Upload .json{fileName ? ` — ${fileName}` : ""}
            </Button>
            <Button type="button" variant="outline" onClick={() => { setRaw(SAMPLE_POST_JSON); setFileName(""); }}>
              Use sample
            </Button>
          </div>
          <div className="space-y-1.5">
            <Label>Source</Label>
            <Select value={effectiveSourceId} onValueChange={setSourceId} disabled={joinedSources.length === 0}>
              <SelectTrigger><SelectValue placeholder="Pick a joined source" /></SelectTrigger>
              <SelectContent>
                {joinedSources.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {joinedSources.length === 0 && (
              <p className="text-xs text-muted-foreground">This account has not joined any source yet — join one first.</p>
            )}
          </div>
          {parsed && (
            <div className="space-y-2">
              <Label>Preview</Label>
              {preview.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing to import — check the JSON.</p>
              ) : (
                <div className="max-h-56 space-y-2 overflow-y-auto rounded-lg border p-3">
                  {preview.map((row) => (
                    <div key={row.key} className="flex items-start justify-between gap-3 text-sm">
                      <div className="min-w-0">
                        <div className="truncate font-mono text-xs text-muted-foreground">{row.label}</div>
                        {row.status === "ready" && (
                          <div className="text-foreground">
                            {row.author} — {row.comments} comment{row.comments === 1 ? "" : "s"}, {row.replies} repl{row.replies === 1 ? "y" : "ies"}
                          </div>
                        )}
                        {row.status === "already" && (
                          <div className="text-muted-foreground">Already collected by {row.accountName}</div>
                        )}
                        {row.status === "error" && <div className="text-destructive">{row.reason}</div>}
                      </div>
                      {row.status === "ready" && <Badge className="shrink-0 bg-green-600 text-white hover:bg-green-600">Ready</Badge>}
                      {row.status === "already" && <Badge variant="secondary" className="shrink-0">Already collected</Badge>}
                      {row.status === "error" && <Badge variant="destructive" className="shrink-0">Error</Badge>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => openDialog(false)}>Cancel</Button>
          <Button
            type="button"
            disabled={!parsed || parsed.drafts.length === 0 || !effectiveSourceId}
            onClick={doImport}
          >
            Import{parsed && parsed.drafts.length > 0 ? ` ${parsed.drafts.length} post${parsed.drafts.length === 1 ? "" : "s"}` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
