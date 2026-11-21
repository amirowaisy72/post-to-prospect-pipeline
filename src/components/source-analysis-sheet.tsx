import { Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { RunStatusBadge } from "@/components/analysis-bits";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { sourceAnalysis, type SourceAnalysis } from "@/lib/analysis-client";
import { fmtDate } from "@/lib/format";

/** Side panel: everything AI Analysis knows about ONE group/page. */
export function SourceAnalysisSheet({
  agentUrl,
  source,
  onClose,
}: {
  agentUrl: string;
  source: { id: string; name: string } | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<SourceAnalysis | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setData(null);
    setError("");
    if (!source) return;
    let off = false;
    void sourceAnalysis(agentUrl, source.id).then((r) => {
      if (off) return;
      if (r.ok) setData(r.value);
      else setError(r.error);
    });
    return () => {
      off = true;
    };
  }, [agentUrl, source]);

  return (
    <Sheet open={!!source} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="left" className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="text-xl">{source?.name || "Source"}</SheetTitle>
          <SheetDescription>The full AI Analysis record for this group/page.</SheetDescription>
        </SheetHeader>

        {!data && !error && (
          <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Calculating…
          </p>
        )}
        {error && <p className="mt-6 text-sm text-destructive">{error}</p>}

        {data && (
          <div className="mt-6 space-y-6">
            <section className="grid grid-cols-2 gap-3 text-sm">
              <Box label="Posts" value={data.posts} />
              <Box label="Comments + replies" value={data.comments + data.replies} />
              <Box label="Total people (readable)" value={data.checkable} />
              <Box label="Checked by AI" value={data.checked} tone="ok" />
              <Box label="Not checked yet" value={data.unchecked} tone={data.unchecked > 0 ? "warn" : "ok"} wide />
            </section>
            <p className="text-xs text-muted-foreground">
              “Not checked yet” are the people the AI hasn't read in any query so far, e.g. people from newly scraped posts.
            </p>

            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Queries run on this ({data.runs.length})
              </h3>
              {data.runs.length === 0 ? (
                <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  No query has run on this yet. Start one from the AI Analysis page.
                </p>
              ) : (
                <ul className="space-y-3">
                  {data.runs.map((r) => (
                    <li key={r.id} className="space-y-2 rounded-lg border p-3 text-sm">
                      <p className="font-medium text-foreground">{r.criteria}</p>
                      <div className="flex flex-wrap items-center gap-2">
                        <RunStatusBadge run={r} />
                        <Badge variant="outline" className="tabular">{r.matchesHere} matches from here</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground tabular">
                        {r.checkedHere} people checked · {r.pendingHere} remaining (for this query) · {r.provider === "ollama" ? "Ollama" : "Gemini"} {r.model} · {fmtDate(r.createdAt)}
                      </p>
                      <Button asChild size="sm" variant="outline">
                        <Link to="/analysis/$runId" params={{ runId: r.id }}>View result</Link>
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Box({ label, value, tone, wide }: { label: string; value: number; tone?: "ok" | "warn"; wide?: boolean }) {
  const color = tone === "warn" ? "text-amber-500" : tone === "ok" ? "text-success" : "text-foreground";
  return (
    <div className={`rounded-lg border p-3 ${wide ? "col-span-2" : ""}`}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-xl font-bold tabular ${color}`}>{value}</p>
    </div>
  );
}
