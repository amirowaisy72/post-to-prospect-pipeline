import { createFileRoute } from "@tanstack/react-router";
import { Check, ExternalLink, Search, X } from "lucide-react";
import { useMemo, useState } from "react";

import { LeadStatusBadge, PriorityBadge } from "@/components/badges";
import { LeadDetailSheet } from "@/components/lead-detail-sheet";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useActiveAccountData, useStore } from "@/lib/store";
import type { LeadPriority, LeadStatus } from "@/lib/types";

export const Route = createFileRoute("/leads")({
  head: () => ({
    meta: [
      { title: "Leads — LeadHunter" },
      { name: "description", content: "Review leads found by AI analysis, filter by priority and status, then shortlist or reject." },
      { property: "og:title", content: "Leads — LeadHunter" },
      { property: "og:description", content: "Review leads found by AI analysis, filter by priority and status, then shortlist or reject." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: LeadsPage,
});

function LeadsPage() {
  const { state, setLeadStatus } = useStore();
  const { leads } = useActiveAccountData();
  const [priority, setPriority] = useState<"all" | LeadPriority>("all");
  const [status, setStatus] = useState<"all" | LeadStatus>("all");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return leads.filter(
      (l) =>
        (priority === "all" || l.priority === priority) &&
        (status === "all" || l.status === status) &&
        (!term || `${l.name} ${l.reason} ${l.quotedComment}`.toLowerCase().includes(term)),
    );
  }, [leads, priority, status, q]);

  const postLabel = (postId: string) => {
    const post = state.posts.find((p) => p.id === postId);
    if (!post) return { title: "—", url: null as string | null };
    const source = state.sources.find((s) => s.id === post.sourceId);
    return { title: `${post.author.name}${source ? ` · ${source.name}` : ""}`, url: post.postUrl };
  };

  return (
    <>
      <PageHeader
        title="Leads"
        description="Everyone the analysis flagged for this account. Each person appears only once across all accounts."
      />

      <Card className="shadow-card">
        <CardContent className="p-0">
          <div className="flex flex-col gap-2 border-b p-4 md:flex-row md:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, reason or comment…" className="pl-8" aria-label="Search leads" />
            </div>
            <Select value={priority} onValueChange={(v) => setPriority(v as typeof priority)}>
              <SelectTrigger className="md:w-[190px]" aria-label="Filter by priority"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All priorities</SelectItem>
                <SelectItem value="rich-beginner">Rich Beginner</SelectItem>
                <SelectItem value="rich-experienced">Rich Experienced</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
              <SelectTrigger className="md:w-[160px]" aria-label="Filter by status"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="new">New</SelectItem>
                <SelectItem value="shortlisted">Shortlisted</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {rows.length === 0 ? (
            <div className="p-6">
              <EmptyState title={leads.length ? "No leads match these filters" : "No leads yet for this account"}>
                {leads.length ? "Try clearing the search or filters." : "Run an AI Analysis on collected posts to find leads."}
              </EmptyState>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Name</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Source post</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="pr-6 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((l) => {
                  const post = postLabel(l.sourcePostId);
                  return (
                    <TableRow key={l.id} className="cursor-pointer" onClick={() => setOpenId(l.id)}>
                      <TableCell className="pl-6">
                        <a
                          href={l.profileUrl}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 font-semibold text-foreground hover:text-primary"
                        >
                          {l.name} <ExternalLink className="size-3" />
                        </a>
                      </TableCell>
                      <TableCell><PriorityBadge priority={l.priority} /></TableCell>
                      <TableCell className="max-w-xs"><p className="line-clamp-2 text-sm text-muted-foreground">{l.reason}</p></TableCell>
                      <TableCell className="max-w-[200px] text-sm">
                        {post.url ? (
                          <a href={post.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="line-clamp-2 hover:text-primary">
                            {post.title}
                          </a>
                        ) : post.title}
                      </TableCell>
                      <TableCell><LeadStatusBadge status={l.status} /></TableCell>
                      <TableCell className="pr-6" onClick={(e) => e.stopPropagation()}>
                        <div className="flex justify-end gap-1.5">
                          <Button size="sm" variant={l.status === "shortlisted" ? "secondary" : "default"} disabled={l.status === "shortlisted"} onClick={() => setLeadStatus(l.id, "shortlisted")} aria-label={`Shortlist ${l.name}`}>
                            <Check /> <span className="hidden xl:inline">Shortlist</span>
                          </Button>
                          <Button size="sm" variant="outline" disabled={l.status === "rejected"} onClick={() => setLeadStatus(l.id, "rejected")} aria-label={`Reject ${l.name}`}>
                            <X /> <span className="hidden xl:inline">Reject</span>
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <p className="mt-2 text-xs text-muted-foreground">Click a row to see the full reason and quoted comment.</p>

      <LeadDetailSheet leadId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}
