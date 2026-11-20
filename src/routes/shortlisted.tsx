import { createFileRoute, Link } from "@tanstack/react-router";
import { ExternalLink, MessagesSquare } from "lucide-react";
import { useState } from "react";

import { PriorityBadge } from "@/components/badges";
import { LeadDetailSheet } from "@/components/lead-detail-sheet";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { useActiveAccountData, useStore } from "@/lib/store";

export const Route = createFileRoute("/shortlisted")({
  head: () => ({
    meta: [
      { title: "Shortlisted — LeadHunter" },
      { name: "description", content: "Approved leads ready for outreach." },
      { property: "og:title", content: "Shortlisted — LeadHunter" },
      { property: "og:description", content: "Approved leads ready for outreach." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ShortlistedPage,
});

function ShortlistedPage() {
  const { state } = useStore();
  const { leads } = useActiveAccountData();
  const shortlisted = leads.filter((l) => l.status === "shortlisted");
  const [openId, setOpenId] = useState<string | null>(null);

  const sourceOf = (postId: string) => {
    const post = state.posts.find((p) => p.id === postId);
    return state.sources.find((s) => s.id === post?.sourceId)?.name ?? "Unknown source";
  };

  return (
    <>
      <PageHeader title="Shortlisted" description="Approved leads for this account." />

      <div className="mb-6 flex items-start gap-3 rounded-lg border border-dashed border-primary/40 bg-accent/60 p-4">
        <MessagesSquare className="mt-0.5 size-5 shrink-0 text-primary" />
        <div>
          <p className="text-sm font-semibold text-accent-foreground">DM chats live in the Inbox tab now.</p>
          <p className="text-sm text-muted-foreground">
            Start a chat from the <Link to="/inbox" className="font-semibold text-primary">Inbox</Link> page — the
            agent opens with their comment or post and follows your script.
          </p>
        </div>
      </div>

      {shortlisted.length === 0 ? (
        <EmptyState title="Nobody shortlisted yet">
          Approve leads on the <Link to="/leads" className="font-semibold text-primary">Leads</Link> page.
        </EmptyState>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {shortlisted.map((l) => (
            <Card key={l.id} className="cursor-pointer shadow-card transition-shadow hover:shadow-raised" onClick={() => setOpenId(l.id)}>
              <CardContent className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-2">
                  <a
                    href={l.profileUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-1 font-semibold text-foreground hover:text-primary"
                  >
                    {l.name} <ExternalLink className="size-3" />
                  </a>
                  <PriorityBadge priority={l.priority} />
                </div>
                <p className="text-sm text-foreground">{l.reason}</p>
                <p className="text-xs text-muted-foreground">Source: {l.sourcePostTitle || sourceOf(l.sourcePostId)}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <LeadDetailSheet leadId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}
