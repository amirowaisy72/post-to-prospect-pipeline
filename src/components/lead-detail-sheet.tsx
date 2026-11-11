import { Check, ExternalLink, RotateCcw, X } from "lucide-react";

import { LeadStatusBadge, PriorityBadge } from "@/components/badges";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { fmtDate } from "@/lib/format";
import { useStore } from "@/lib/store";

export function LeadDetailSheet({ leadId, onClose }: { leadId: string | null; onClose: () => void }) {
  const { state, setLeadStatus } = useStore();
  const lead = state.leads.find((l) => l.id === leadId);
  const post = lead && state.posts.find((p) => p.id === lead.sourcePostId);
  const source = post && state.sources.find((s) => s.id === post.sourceId);

  return (
    <Sheet open={!!lead} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        {lead && (
          <>
            <SheetHeader>
              <SheetTitle className="text-xl">{lead.name}</SheetTitle>
              <SheetDescription asChild>
                <a href={lead.profileUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs hover:text-primary">
                  {lead.profileUrl.replace(/^https?:\/\//, "")} <ExternalLink className="size-3" />
                </a>
              </SheetDescription>
            </SheetHeader>
            <div className="mt-4 flex gap-2">
              <PriorityBadge priority={lead.priority} />
              <LeadStatusBadge status={lead.status} />
            </div>

            <section className="mt-6">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Why this is a lead</h3>
              <p className="mt-1.5 text-sm text-foreground">{lead.reason}</p>
            </section>

            <section className="mt-6">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Quoted comment</h3>
              <blockquote className="mt-1.5 rounded-md border-l-2 border-primary bg-muted/60 p-3 text-sm italic text-foreground">
                “{lead.quotedComment}”
              </blockquote>
            </section>

            {post && (
              <section className="mt-6">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Source post</h3>
                <div className="mt-1.5 rounded-md border p-3 text-sm">
                  <p className="font-semibold text-foreground">{post.author.name}{source && <span className="font-normal text-muted-foreground"> in {source.name}</span>}</p>
                  <p className="mt-1 line-clamp-4 text-muted-foreground">{post.text}</p>
                  <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                    <span>Collected {fmtDate(post.collectedAt)}</span>
                    <a href={post.postUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-primary">
                      Open <ExternalLink className="size-3" />
                    </a>
                  </div>
                </div>
              </section>
            )}

            <div className="mt-8 flex gap-2">
              {lead.status !== "shortlisted" && (
                <Button className="flex-1" onClick={() => setLeadStatus(lead.id, "shortlisted")}>
                  <Check /> Shortlist
                </Button>
              )}
              {lead.status !== "rejected" && (
                <Button className="flex-1" variant="outline" onClick={() => setLeadStatus(lead.id, "rejected")}>
                  <X /> Reject
                </Button>
              )}
              {lead.status !== "new" && (
                <Button variant="ghost" onClick={() => setLeadStatus(lead.id, "new")}>
                  <RotateCcw /> Reset
                </Button>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
