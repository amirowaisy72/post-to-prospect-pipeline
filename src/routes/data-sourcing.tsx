import { createFileRoute } from "@tanstack/react-router";
import { ExternalLink, Plus } from "lucide-react";
import { useMemo, useState } from "react";

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
import { accountName } from "@/lib/leadhunter-service";
import { fmtDate, fmtNumber, shortUrl } from "@/lib/format";
import { useStore } from "@/lib/store";
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
        description="Groups and pages your accounts have joined."
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
