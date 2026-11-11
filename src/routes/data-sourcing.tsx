import { createFileRoute } from "@tanstack/react-router";
import { ExternalLink, FileJson, Lock, MessageSquare, Plus, Upload } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { SourceStatusBadge } from "@/components/badges";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import {
  accountName,
  countReplies,
  joinBlockReason,
  parsePostDataJson,
  SAMPLE_POST_JSON,
  type PostParseResult,
} from "@/lib/leadhunter-service";
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
        description="Join groups and pages, then collect posts with their comments and replies as PostData."
      />
      <div className="space-y-6">
        <SourcesSection />
        <PostsSection />
      </div>
    </>
  );
}

/* ---------------- Sources ---------------- */

function SourcesSection() {
  const { state, joinSource } = useStore();
  const accountId = state.activeAccountId;
  const [filter, setFilter] = useState<"all" | "mine" | "available">("all");
  const [open, setOpen] = useState(false);

  const rows = useMemo(() => {
    const list = state.sources.filter((s) =>
      filter === "mine" ? s.joinedByAccountId === accountId : filter === "available" ? !s.joinedByAccountId : true,
    );
    const rank = (id: string | null) => (id === accountId ? 0 : id === null ? 1 : 2);
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
              <TabsTrigger value="available">Available</TabsTrigger>
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
                <TableHead className="text-right">Members</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Joined by</TableHead>
                <TableHead>Last scraped</TableHead>
                <TableHead className="pr-6 text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((s) => {
                const block = joinBlockReason(state, s, accountId);
                const mine = s.joinedByAccountId === accountId;
                return (
                  <TableRow key={s.id}>
                    <TableCell className="pl-6">
                      <div className="font-semibold text-foreground">{s.name}</div>
                      <a href={s.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-primary">
                        {shortUrl(s.url)} <ExternalLink className="size-3" />
                      </a>
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
                    <TableCell className="pr-6 text-right">
                      {mine ? (
                        <Badge variant="success">Joined</Badge>
                      ) : block ? (
                        <div className="flex flex-col items-end gap-1">
                          <Button size="sm" variant="outline" disabled>
                            <Lock /> Join
                          </Button>
                          <span className="text-xs font-medium text-danger">{block}</span>
                        </div>
                      ) : (
                        <Button size="sm" onClick={() => joinSource(s.id)}>Join</Button>
                      )}
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

function AddSourceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { addSource } = useStore();
  const [name, setName] = useState("");
  const [type, setType] = useState<SourceType>("group");
  const [url, setUrl] = useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (addSource({ name, type, url })) {
      setName("");
      setUrl("");
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add source</DialogTitle>
          <DialogDescription>Add a Facebook group or page. You can join it right after.</DialogDescription>
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
            <Label htmlFor="src-url">URL</Label>
            <Input id="src-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://facebook.com/groups/…" className="font-mono text-sm" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!name.trim() || !url.trim()}>Add source</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- Collected posts ---------------- */

function PostsSection() {
  const { state } = useStore();
  const { posts } = useActiveAccountData();
  const [open, setOpen] = useState(false);
  const sourceName = (id: string) => state.sources.find((s) => s.id === id)?.name ?? "Unknown source";

  return (
    <Card className="shadow-card">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div>
          <CardTitle className="text-base">Collected Posts ({posts.length})</CardTitle>
          <CardDescription>PostData collected by this account. The same post can only be collected once.</CardDescription>
        </div>
        <Button onClick={() => setOpen(true)}>
          <FileJson /> Add Post Data
        </Button>
      </CardHeader>
      <CardContent className="px-0">
        {posts.length === 0 ? (
          <div className="px-6">
            <EmptyState title="No posts collected for this account">Use “Add Post Data” to paste or upload a PostData JSON.</EmptyState>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Post</TableHead>
                <TableHead className="text-right">Comments</TableHead>
                <TableHead className="text-right">Replies</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="pr-6">Collected</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {posts.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="max-w-md pl-6">
                    <a href={p.author.url} target="_blank" rel="noreferrer" className="font-semibold text-foreground hover:text-primary">
                      {p.author.name}
                    </a>
                    <p className="line-clamp-2 text-sm text-muted-foreground">{p.text}</p>
                    <a href={p.postUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-primary">
                      View post <ExternalLink className="size-3" />
                    </a>
                  </TableCell>
                  <TableCell className="text-right tabular">{p.comments.length}</TableCell>
                  <TableCell className="text-right tabular">{countReplies(p)}</TableCell>
                  <TableCell className="text-sm">{sourceName(p.sourceId)}</TableCell>
                  <TableCell className="whitespace-nowrap pr-6 text-sm text-muted-foreground">{fmtDate(p.collectedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <AddPostDialog open={open} onOpenChange={setOpen} />
    </Card>
  );
}

function AddPostDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { state, addPost } = useStore();
  const { joinedSources } = useActiveAccountData();
  const [raw, setRaw] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<PostParseResult | null>(null);
  const [sourceId, setSourceId] = useState<string>("");
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setRaw("");
    setFileName(null);
    setResult(null);
    setSourceId("");
  };

  const validate = (text = raw) => {
    const r = parsePostDataJson(text, state);
    setResult(r);
    const suggested = r.draft?.sourceId;
    if (suggested && joinedSources.some((s) => s.id === suggested)) setSourceId(suggested);
    else if (!sourceId && joinedSources[0]) setSourceId(joinedSources[0].id);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    setFileName(file.name);
    setRaw(text);
    validate(text);
  };

  const save = () => {
    if (!result?.draft || !result.ok || !sourceId) return;
    if (addPost(result.draft, sourceId)) {
      reset();
      onOpenChange(false);
    }
  };

  const draft = result?.draft;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add Post Data</DialogTitle>
          <DialogDescription>
            Paste one PostData JSON object or upload a .json file. It is validated and previewed before saving.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              <Upload /> Upload .json
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                void onFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setRaw(SAMPLE_POST_JSON);
                setFileName(null);
                setResult(null);
              }}
            >
              Insert sample JSON
            </Button>
            {fileName && <span className="font-mono text-xs text-muted-foreground">{fileName}</span>}
          </div>
          <Textarea
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value);
              setResult(null);
            }}
            rows={10}
            spellCheck={false}
            placeholder='{ "postUrl": "...", "author": { "name": "...", "url": "..." }, "text": "...", "comments": [ ... ] }'
            className="font-mono text-xs"
            aria-label="PostData JSON"
          />
          <Button type="button" variant="secondary" onClick={() => validate()} disabled={!raw.trim()}>
            Validate JSON
          </Button>
        </div>

        {result && result.errors.length > 0 && (
          <Alert variant="destructive">
            <AlertTitle>JSON is not valid PostData</AlertTitle>
            <AlertDescription>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">
                {result.errors.slice(0, 8).map((e) => <li key={e}>{e}</li>)}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {result?.alreadyCollected && (
          <Alert variant="destructive">
            <AlertTitle>Already collected</AlertTitle>
            <AlertDescription>This post URL was already collected by {result.alreadyCollected.accountName}. It can't be added twice.</AlertDescription>
          </Alert>
        )}

        {draft && (
          <div className="rounded-lg border bg-muted/40 p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Preview</span>
              {result?.ok && <Badge variant="success">Valid</Badge>}
            </div>
            <p className="font-semibold text-foreground">{draft.author.name}</p>
            <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">{draft.text}</p>
            <div className="mt-3 flex gap-4 text-sm">
              <span className="inline-flex items-center gap-1.5"><MessageSquare className="size-4 text-muted-foreground" /> {draft.comments.length} comments</span>
              <span>{countReplies(draft)} replies</span>
            </div>
            {result?.ok && (
              <div className="mt-4 space-y-1.5">
                <Label>Source (joined by this account)</Label>
                {joinedSources.length ? (
                  <Select value={sourceId} onValueChange={setSourceId}>
                    <SelectTrigger className="bg-card"><SelectValue placeholder="Pick a source" /></SelectTrigger>
                    <SelectContent>
                      {joinedSources.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="text-sm text-danger">This account hasn't joined any source yet — join one first.</p>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={!result?.ok || !sourceId}>Save post data</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
