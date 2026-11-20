import { Loader2, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { isJobLive, listJobs, stopJob, type AgentJob } from "@/lib/sourcing-client";
import { useStore } from "@/lib/store";

/**
 * Polls the agent's /jobs. Returns the job that is running now (or
 * null) and the number of jobs that finished since mount, so pages
 * can reload their data when a job ends.
 */
export function useLiveJob(): {
  job: AgentJob | null;
  doneTick: number;
  online: boolean;
  refresh: () => void;
  finished: AgentJob | null;
  clearFinished: () => void;
} {
  const { state } = useStore();
  const agentUrl = state.settings.agentUrl;
  const [job, setJob] = useState<AgentJob | null>(null);
  const [doneTick, setDoneTick] = useState(0);
  const [online, setOnline] = useState(true);
  const [finished, setFinished] = useState<AgentJob | null>(null);
  const lastId = useRef<string | null>(null);

  const poll = useCallback(async () => {
    const r = await listJobs(agentUrl);
    if (!r.ok) {
      setOnline(false);
      return;
    }
    setOnline(true);
    const live = r.value.jobs.find((j) => isJobLive(j)) ?? null;
    if (lastId.current && (!live || live.id !== lastId.current)) {
      setDoneTick((n) => n + 1);
      const ended = r.value.jobs.find((j) => j.id === lastId.current);
      // Kept in page memory only: a refresh clears it on purpose.
      if (ended && ended.kind === "collect") setFinished(ended);
    }
    lastId.current = live ? live.id : null;
    setJob(live);
  }, [agentUrl]);

  useEffect(() => {
    void poll();
    const t = window.setInterval(() => void poll(), 2500);
    return () => window.clearInterval(t);
  }, [poll]);

  return {
    job,
    doneTick,
    online,
    refresh: () => void poll(),
    finished,
    clearFinished: () => setFinished(null),
  };
}

const KIND_LABEL: Record<string, string> = {
  collect: "Naye groups/pages dhoond raha hai",
  scrape: "Posts scrape kar raha hai",
  sync: "Post sync kar raha hai",
};

/** Banner for the running job, with a Stop button. Stop finishes
 * the post in progress first, then stops. */
export function JobBanner({ job }: { job: AgentJob | null }) {
  const { state } = useStore();
  const [busy, setBusy] = useState(false);
  if (!job) return null;
  const stopping = job.status === "stop-requested" || busy;
  const onStop = async () => {
    setBusy(true);
    const r = await stopJob(state.settings.agentUrl, job.id);
    if (!r.ok) {
      toast.error(r.error);
      setBusy(false);
    }
  };
  return (
    <div className="mx-6 mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <Loader2 className="size-4 animate-spin text-primary" />
        <span className="font-medium">{KIND_LABEL[job.kind] ?? "Agent kaam kar raha hai"}</span>
        <span className="text-muted-foreground">
          {job.kind === "collect"
            ? `${job.postsProcessed} check kiye, ${job.newPosts} mile`
            : job.kind === "scrape"
              ? `${job.newPosts} naye posts save hue`
              : ""}
        </span>
        {stopping && (
          <span className="text-amber-600">· current post khatam hone ke baad ruk jayega…</span>
        )}
      </div>
      <Button variant="outline" size="sm" disabled={stopping} onClick={onStop}>
        <Square className="size-3" /> {stopping ? "Stopping…" : "Stop"}
      </Button>
    </div>
  );
}
