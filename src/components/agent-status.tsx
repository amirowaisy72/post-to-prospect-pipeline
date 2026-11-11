import { Bot, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useNow } from "@/hooks/use-now";
import { agentFor, agentProgress, agentStatus } from "@/lib/leadhunter-service";
import { fmtAgo } from "@/lib/format";
import { useStore } from "@/lib/store";
import type { AgentState, AgentStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

export const AGENT_STATUS_LABEL: Record<AgentStatus, string> = { busy: "Busy", free: "Free", offline: "Offline" };

const fmtElapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
};

/** Live status light: pulsing orange while busy, green when free, grey when offline. */
export function AgentDot({ status, className }: { status: AgentStatus; className?: string }) {
  return (
    <span className={cn("relative inline-flex size-2.5 shrink-0", className)} aria-hidden>
      {status === "busy" && <span className="absolute inset-0 animate-ping rounded-full bg-primary opacity-60" />}
      <span
        className={cn(
          "relative inline-flex size-full rounded-full",
          status === "busy" && "bg-primary",
          status === "free" && "bg-success",
          status === "offline" && "bg-muted-foreground/40",
        )}
      />
    </span>
  );
}

/** Small pill with the status word, for tables. */
export function AgentStatusTag({ accountId }: { accountId: string }) {
  const { state } = useStore();
  const status = agentStatus(state, accountId);
  const task = agentFor(state, accountId).task;
  return (
    <div className="min-w-0">
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-semibold",
          status === "busy" && "border-primary/25 bg-accent text-accent-foreground",
          status === "free" && "border-success/20 bg-success-soft text-success",
          status === "offline" && "border-border bg-muted text-muted-foreground",
        )}
      >
        <AgentDot status={status} className="size-2" />
        {AGENT_STATUS_LABEL[status]}
      </span>
      {status === "busy" && task && <p className="mt-1 max-w-[200px] truncate text-xs text-muted-foreground">{task.label}</p>}
    </div>
  );
}

function AgentRow({ agent, status, name, active, now, onStop }: {
  agent: AgentState;
  status: AgentStatus;
  name: string;
  active: boolean;
  now: number | null;
  onStop: () => void;
}) {
  const task = agent.task;
  const progress = task && now != null ? agentProgress(task, now) : null;
  const initials = name.replace(/[^\p{L}\s]/gu, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

  return (
    <li className={cn("rounded-lg border p-3", active ? "border-primary/40 bg-accent/40" : "bg-card")}>
      <div className="flex items-start gap-3">
        <span className="relative grid size-9 shrink-0 place-items-center rounded-full bg-muted text-xs font-bold text-foreground">
          {initials || <Bot className="size-4" />}
          <AgentDot status={status} className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full ring-2 ring-popover" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-foreground">{name}</span>
            {active && <span className="rounded bg-primary/10 px-1.5 text-[10px] font-bold uppercase tracking-wider text-primary">Current</span>}
          </div>
          {status === "busy" && task ? (
            <>
              <p className="truncate text-xs text-foreground">{task.label}</p>
              {progress != null && (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary transition-[width] duration-1000 ease-linear" style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
              )}
              <p className="mt-1 flex justify-between text-[11px] text-muted-foreground tabular">
                <span>Running {now != null ? fmtElapsed(now - Date.parse(task.startedAt)) : "…"}</span>
                {progress != null && <span>{Math.round(progress * 100)}%</span>}
              </p>
            </>
          ) : status === "offline" ? (
            <p className="text-xs text-muted-foreground">Offline — account is not active</p>
          ) : (
            <p className="truncate text-xs text-muted-foreground">
              Free{agent.lastFinishedAt && now != null ? ` · last task ${fmtAgo(agent.lastFinishedAt)}` : " · ready for work"}
            </p>
          )}
        </div>
        {status === "busy" && (
          <Button variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground hover:text-danger" onClick={onStop} aria-label={`Stop ${name}'s agent task`} title="Stop task">
            <Square className="size-3.5 fill-current" />
          </Button>
        )}
      </div>
    </li>
  );
}

/** Top-bar indicator for the active account's agent, with every account's agent in the popover. */
export function AgentStatusIndicator() {
  const { state, finishAgentTask } = useStore();
  const now = useNow();
  const activeId = state.activeAccountId;
  const status = agentStatus(state, activeId);
  const task = agentFor(state, activeId).task;
  const progress = task && now != null ? agentProgress(task, now) : null;
  const busyCount = state.accounts.filter((a) => agentStatus(state, a.id) === "busy").length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Agent ${AGENT_STATUS_LABEL[status].toLowerCase()}${task ? `: ${task.label}` : ""}`}
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-2 rounded-full border px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            status === "busy" && "border-primary/30 bg-accent text-accent-foreground hover:bg-accent/70",
            status === "free" && "border-success/25 bg-success-soft text-success hover:bg-success-soft/70",
            status === "offline" && "border-border bg-muted text-muted-foreground hover:bg-muted/70",
          )}
        >
          <AgentDot status={status} />
          <span>
            <span className="hidden sm:inline">Agent </span>
            {AGENT_STATUS_LABEL[status].toLowerCase()}
          </span>
          {status === "busy" && task && (
            <span className="hidden max-w-[170px] items-center gap-1.5 border-l border-primary/25 pl-2 font-medium xl:flex">
              <span className="truncate">{task.label}</span>
              {progress != null && <span className="tabular opacity-80">{Math.round(progress * 100)}%</span>}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[340px] max-w-[calc(100vw-1.5rem)] p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <p className="flex items-center gap-1.5 text-sm font-bold text-foreground"><Bot className="size-4 text-primary" /> Account agents</p>
            <p className="text-xs text-muted-foreground">One agent works for each account.</p>
          </div>
          <span className="text-xs font-semibold text-muted-foreground tabular">{busyCount} busy · {state.accounts.length} total</span>
        </div>
        <ul className="max-h-[360px] space-y-2 overflow-y-auto p-3">
          {[...state.accounts]
            .sort((a, b) => (a.id === activeId ? -1 : b.id === activeId ? 1 : 0))
            .map((a) => (
              <AgentRow
                key={a.id}
                agent={agentFor(state, a.id)}
                status={agentStatus(state, a.id)}
                name={a.name}
                active={a.id === activeId}
                now={now}
                onStop={() => finishAgentTask(a.id, { stopped: true })}
              />
            ))}
        </ul>
        <p className="border-t px-4 py-2.5 text-[11px] text-muted-foreground">Demo status — live updates arrive with your agent API.</p>
      </PopoverContent>
    </Popover>
  );
}
