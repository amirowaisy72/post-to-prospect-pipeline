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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { accountName, scrapedCount } from "@/lib/leadhunter-service";
import { fmtDate, fmtNumber, shortUrl } from "@/lib/format";
import { useStore } from "@/lib/store";

export const Route = createFileRoute("/data-sourcing")({
  head: () => ({
    meta: [
      { title: "Data Sourcing — LeadHunter" },
      { name: "description", content: "Add the Facebook groups and pages you joined, and the posts collected from them." },
      { property: "og:title", content: "Data Sourcing — LeadHunter" },
      { property: "og:description", content: "Add the Facebook groups and pages you joined, and the posts collected from them." },
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
          <Button onClick={() => setOpen(true)} disabled={!accountId}>
            <Plus /> Add Source
          </Button>
        </div>
      </CardHeader>
      <CardContent className="px-0">
        {!accountId && (
          <div className="mx-6 mb-4 rounded-md border px-3 py-2 text-sm text-muted-foreground">
            No account yet — <Link to="/accounts" className="font-medium text-primary hover:underline">create an account</Link> first.
            Sources belong to the account that collects them.
          </div>
        )}
        {rows.length === 0 ? (
          <div className="px-6">
            <EmptyState title={accountId ? "No sources here yet" : "No account yet"}>
              {accountId
                ? "Add a source by hand: paste the group's or page's name, its Facebook link and its member count."
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
                      <SourceActions sourceId={s.id} />
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

/** Per-row Delete. Local-only: it removes the source, its posts and
 * its derived leads from LeadHunter. It does NOT leave the group/page
 * on Facebook — that is done by hand on Facebook if needed. */
function SourceActions({ sourceId }: { sourceId: string }) {
  const { deleteSource } = useStore();
  const [armed, setArmed] = useState(false);
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
    deleteSource(sourceId);
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-1.5">
        <Button
          variant={armed ? "destructive" : "outline"}
          size="sm"
          title={
            armed
              ? "Click again to confirm — this removes the source from LeadHunter only, it stays joined on Facebook"
              : "Delete from LeadHunter only — it stays joined on Facebook"
          }
          onClick={onDelete}
        >
          {armed ? "Confirm delete?" : "Delete"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Add Source = manual entry. Three fields only: Name, Link, Members
 * count. Group or Page is derived from the link — /groups/ in the
 * URL means Group, otherwise Page. The source is saved under the
 * active account as Joined. A link already present as a source is
 * rejected with "Already joined by <account>".
 */
function AddSourceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { addSource, state } = useStore();
  const accountId = state.activeAccountId;
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [members, setMembers] = useState("");
  const [errors, setErrors] = useState<{ name?: string; url?: string; members?: string }>({});

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs: typeof errors = {};
    if (!name.trim()) errs.name = "Enter the group's or page's name.";
    if (!url.trim()) errs.url = "Paste the group's or page's Facebook link.";
    const count = Number(members);
    if (members.trim() === "" || !Number.isInteger(count) || count < 0)
      errs.members = "Enter a whole number, 0 or more.";
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    // addSource toasts the reason itself on failure (e.g. a duplicate
    // link) — the dialog stays open so the entry can be corrected.
    const ok = addSource({ name: name.trim(), url: url.trim(), memberCount: count });
    if (!ok) return;
    setName("");
    setUrl("");
    setMembers("");
    setErrors({});
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add source</DialogTitle>
          <DialogDescription>
            Add a group or page you already joined on Facebook. Group or Page is worked out from the link —
            <span className="font-medium text-foreground"> /groups/</span> in the link means Group, otherwise Page.
            It is saved under your active account ({accountId ? accountName(state, accountId) : "no account"}) as
            Joined.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="src-name">Name</Label>
            <Input
              id="src-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Stocks To Watch"
            />
            {errors.name && <p className="text-sm text-destructive">{errors.name}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="src-url">Link</Label>
            <Input
              id="src-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.facebook.com/groups/…"
            />
            {errors.url && <p className="text-sm text-destructive">{errors.url}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="src-members">Members</Label>
            <Input
              id="src-members"
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              value={members}
              onChange={(e) => setMembers(e.target.value)}
              placeholder="e.g. 780000"
            />
            {errors.members && <p className="text-sm text-destructive">{errors.members}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!accountId}>
              Add source
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
