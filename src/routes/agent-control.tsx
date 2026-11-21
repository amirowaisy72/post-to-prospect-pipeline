import { createFileRoute } from "@tanstack/react-router";
import {
  Ban,
  Bot,
  Eye,
  EyeOff,
  LogIn,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
} from "lucide-react";
import { useEffect, useState } from "react";

import { EmptyState, PageHeader } from "@/components/page-header";
import { AgentHelpCard } from "@/components/agent-help-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  AgentSessionState,
  AgentStatus,
  ChatResult,
  SessionCheckResult,
  SessionDiagnostic,
} from "@/lib/chat-client";
import { fmtAgo } from "@/lib/format";
import {
  dailyChatLimit,
  formatStageAge,
  sendStatusCaption,
} from "@/lib/leadhunter-service";
import { useStore } from "@/lib/store";

export const Route = createFileRoute("/agent-control")({
  component: AgentControl,
});

/**
 * Plain-language verdict for a session state. The two verdicts the
 * user asked for are verbatim ("Session OK" / "Still empty —
 * restart the browser"); the hints say which button fixes it.
 */
function sessionVerdict(state: AgentSessionState): { title: string; hint: string } {
  switch (state) {
    case "ok":
      return { title: "Session OK", hint: "Facebook session is live — messages can be sent." };
    case "empty":
      return {
        title: "Still empty — restart the browser",
        hint: "The Messenger page is coming up blank. Click Relaunch browser, then Re-check session.",
      };
    case "logged_out":
      return {
        title: "Logged out",
        hint: "Click Sign in to Facebook (in Controls above) — a Chrome window will open; sign in yourself, then click Relaunch browser.",
      };
    case "checkpoint":
      return {
        title: "Checkpoint",
        hint: "Facebook asked for verification — check it in your own browser, then click Re-check session.",
      };
    case "blocked":
      return {
        title: "Blocked",
        hint: "Facebook has blocked it — wait a while, then Relaunch browser + Re-check session.",
      };
  }
}

function sessionBadgeVariant(state: AgentSessionState) {
  switch (state) {
    case "ok":
      return "success" as const;
    case "empty":
      return "destructive" as const;
    case "logged_out":
    case "checkpoint":
      return "warning" as const;
    case "blocked":
      return "danger" as const;
  }
}

function DiagnosticRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b py-2 last:border-b-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium text-foreground">{children}</span>
    </div>
  );
}

function AgentControl() {
  const {
    state,
    refreshAgentStatus,
    runAgentSessionCheck,
    relaunchAgentBrowser,
    reloadAgentMessenger,
    signInAgent,
    unwatchAgent,
    refreshAgentLogs,
    refreshChatLive,
    sendChatWatch,
    stopAllChatting,
  } = useStore();

  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [checkResult, setCheckResult] = useState<ChatResult<SessionCheckResult> | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const account = state.accounts.find((a) => a.id === state.activeAccountId) ?? null;
  const cap = account ? dailyChatLimit(account, new Date().toISOString()) : 0;

  // Recent send stages: own messages that carry a stage trail.
  const stagedMessages = state.chatMessages
    .filter((m) => m.role === "agent" && m.sendStage)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 8);

  const refreshAll = async () => {
    const s = await refreshAgentStatus();
    if (s.ok) {
      setStatus(s.value);
      setStatusError(null);
    } else {
      setStatus(null);
      setStatusError(s.error);
    }
    const l = await refreshAgentLogs();
    if (l.ok) setLogs(l.value.lines);
    await refreshChatLive();
  };

  useEffect(() => {
    let cancelled = false;
    void refreshAll();
    const timer = window.setInterval(() => {
      if (!cancelled) void refreshAll();
    }, 10000);
    const clock = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.clearInterval(clock);
    };
    // Mount + 10 s poll, like the Inbox live poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (key: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    setActionNote(null);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  const onSignin = () =>
    run("signin", async () => {
      const r = await signInAgent();
      if (r.ok) {
        setActionNote(
          "Chrome window opened — sign in to Facebook yourself, then click Relaunch browser.",
        );
        await refreshAll();
      } else {
        setActionNote(`Sign-in window did not open: ${r.error}`);
      }
    });

  const onSessionCheck = () =>
    run("check", async () => {
      const r = await runAgentSessionCheck();
      setCheckResult(r);
      if (r.ok) {
        await refreshAll();
      } else {
        setActionNote(`Session check failed: ${r.error}`);
      }
    });

  const onReload = () =>
    run("reload", async () => {
      const r = await reloadAgentMessenger();
      if (r.ok) {
        setCheckResult({ ok: true, value: r.value });
        setActionNote(
          r.value.reloaded
            ? "Messenger page reloaded."
            : "Messenger page did not load — see the session verdict below.",
        );
        await refreshAll();
      } else {
        setActionNote(`Reload failed: ${r.error}`);
      }
    });

  const onRelaunch = () =>
    run("relaunch", async () => {
      const r = await relaunchAgentBrowser();
      if (r.ok) {
        setActionNote(
          `Browser relaunched (${r.value.browser}). Now click Re-check session — the session will be checked again.`,
        );
        await refreshAll();
      } else {
        setActionNote(`Relaunch failed: ${r.error}`);
      }
    });

  const onWatchToggle = () =>
    run("watch", async () => {
      if (status?.watching) {
        const r = await unwatchAgent();
        if (r.ok) {
          setActionNote("Watching stopped — no replies will be watched after the current check.");
          await refreshAll();
        } else {
          setActionNote(`Stop watching failed: ${r.error}`);
        }
      } else {
        const joined = await sendChatWatch();
        setActionNote(
          joined
            ? "Watching started — the agent will now wait for replies."
            : "Nothing to watch — there is no active chat, or the Gemini key is missing.",
        );
        await refreshAll();
      }
    });

  const onStopAll = () =>
    run("stop", async () => {
      const ok = await stopAllChatting();
      setActionNote(
        ok ? "All chatting stopped." : "Stop failed — check above whether the agent is running.",
      );
      await refreshAll();
    });

  const lastCheck = checkResult?.ok
    ? { state: checkResult.value.state, at: checkResult.value.at, detail: checkResult.value.detail }
    : status?.lastSessionCheck ?? null;
  const verdict = lastCheck ? sessionVerdict(lastCheck.state) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Agent Control"
        description="The agent's status, session, and browser — everything from here. Anything the controls can't do is written clearly below."
      />

      <AgentHelpCard />

      {/* Status */}
      <Card className="shadow-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Bot /> Agent status
          </CardTitle>
          <CardDescription>
            Refreshes every 10 seconds. The status check does not launch a browser — it only reports the status.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {statusError && !status ? (
            <EmptyState title="Agent offline">
              {statusError} Check the agent window (run-agent.bat) — if it is closed, start it again.
            </EmptyState>
          ) : !status ? (
            <EmptyState title="Checking agent…" />
          ) : (
            <div>
              <DiagnosticRow label="Agent">
                <Badge variant="success">Online</Badge>
              </DiagnosticRow>
              <DiagnosticRow label="Chrome profile">
                <span className="font-mono text-xs break-all">{status.profile}</span>{" "}
                <Badge variant={status.profileExists ? "success" : "destructive"}>
                  {status.profileExists ? "exists" : "missing"}
                </Badge>
              </DiagnosticRow>
              <DiagnosticRow label="Browser window">
                {status.headed ? "Headed (visible window)" : "Headless (silent)"} ·{" "}
                <Badge
                  variant={
                    status.browser === "alive"
                      ? "success"
                      : status.browser === "dead"
                        ? "destructive"
                        : "neutral"
                  }
                >
                  {status.browser === "alive"
                    ? "Alive"
                    : status.browser === "dead"
                      ? "Dead"
                      : "Not started yet"}
                </Badge>
              </DiagnosticRow>
              <DiagnosticRow label="Watching">
                {status.watching ? (
                  <>
                    <Badge variant="success">On</Badge> · {status.watchedThreads} thread
                    {status.watchedThreads === 1 ? "" : "s"}
                  </>
                ) : (
                  <Badge variant="neutral">Off</Badge>
                )}
              </DiagnosticRow>
              <DiagnosticRow label="Send in flight">
                {status.chatStartBusy ? "Yes — a message is sending" : "No"}
              </DiagnosticRow>
              <DiagnosticRow label="Session">
                {lastCheck ? (
                  <>
                    <Badge variant={sessionBadgeVariant(lastCheck.state)}>
                      {lastCheck.state === "ok"
                        ? "Session OK"
                        : lastCheck.state === "empty"
                          ? "Empty"
                          : lastCheck.state === "logged_out"
                            ? "Logged out"
                            : lastCheck.state === "checkpoint"
                              ? "Checkpoint"
                              : "Blocked"}
                    </Badge>{" "}
                    <span className="text-xs text-muted-foreground">
                      last check {fmtAgo(lastCheck.at)}
                    </span>
                  </>
                ) : (
                  "Not checked yet — click Re-check session."
                )}
              </DiagnosticRow>
              <DiagnosticRow label="Sends today">
                {account
                  ? `${status.sendsToday} / ${cap} (cap, ${status.sendsTodayDate})`
                  : `${status.sendsToday} sent — no account selected, so no cap to show.`}
              </DiagnosticRow>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Controls */}
      <Card className="shadow-card">
        <CardHeader>
          <CardTitle className="text-base">Controls</CardTitle>
          <CardDescription>
            Fix an empty session here too: first Re-check session, then Relaunch browser, then Re-check again.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button onClick={onSignin} disabled={busy !== null}>
              <LogIn /> {busy === "signin" ? "Opening…" : "Sign in to Facebook"}
            </Button>
            <Button onClick={onSessionCheck} disabled={busy !== null}>
              <RefreshCw /> {busy === "check" ? "Checking…" : "Re-check session"}
            </Button>
            <Button variant="outline" onClick={onReload} disabled={busy !== null}>
              <RotateCcw /> {busy === "reload" ? "Reloading…" : "Reload Messenger page"}
            </Button>
            <Button variant="outline" onClick={onRelaunch} disabled={busy !== null}>
              <Bot /> {busy === "relaunch" ? "Relaunching…" : "Relaunch browser"}
            </Button>
            <Button variant="outline" onClick={onWatchToggle} disabled={busy !== null || !account}>
              {status?.watching ? <EyeOff /> : <Eye />}{" "}
              {busy === "watch" ? "Working…" : status?.watching ? "Stop watching" : "Start watching"}
            </Button>
            <Button variant="destructive" onClick={onStopAll} disabled={busy !== null}>
              <Ban /> {busy === "stop" ? "Stopping…" : "Stop all chatting"}
            </Button>
          </div>

          {checkResult && !checkResult.ok && (
            <p className="text-sm text-destructive">Session check failed: {checkResult.error}</p>
          )}
          {verdict && (
            <div className="rounded-lg border p-3">
              <p className="text-sm font-semibold text-foreground">{verdict.title}</p>
              <p className="mt-0.5 text-sm text-muted-foreground">{verdict.hint}</p>
            </div>
          )}
          {actionNote && <p className="text-sm text-muted-foreground">{actionNote}</p>}

          <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
            <p className="font-semibold text-foreground">What the UI can NOT do — nothing hidden:</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              <li>
                You can't restart the agent process from here — it runs in a separate window
                (run-agent.bat). Press Ctrl+C in that window, then run run-agent.bat again.
              </li>
              <li>
                Sign in only once: click "Sign in to Facebook" — a Chrome window will open,
                sign in yourself. The session is saved in the agent's own profile (agent\profiles);
                no other app's profile is used.
              </li>
            </ul>
          </div>
        </CardContent>
      </Card>

      {/* Diagnostics */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="shadow-card">
          <CardHeader>
            <CardTitle className="text-base">Last session check</CardTitle>
            <CardDescription>Detail — url, body_len, selectors.</CardDescription>
          </CardHeader>
          <CardContent>
            {!lastCheck ? (
              <EmptyState title="No session check yet">
                Click Re-check session — the detail will appear here.
              </EmptyState>
            ) : (
              <SessionDetail detail={lastCheck.detail} at={lastCheck.at} />
            )}
          </CardContent>
        </Card>

        <Card className="shadow-card">
          <CardHeader>
            <CardTitle className="text-base">Recent send stages</CardTitle>
            <CardDescription>The latest status of your messages (the Inbox stages).</CardDescription>
          </CardHeader>
          <CardContent>
            {stagedMessages.length === 0 ? (
              <EmptyState title="No sends with a stage yet">
                No message has been sent yet, or its stage has ended.
              </EmptyState>
            ) : (
              <ul className="space-y-2">
                {stagedMessages.map((m) => (
                  <li key={m.id} className="rounded-lg border px-3 py-2">
                    <p className="line-clamp-1 text-sm text-foreground">{m.text}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {sendStatusCaption(m, nowMs)}
                      {m.sendStageSince && formatStageAge(m.sendStageSince, nowMs)
                        ? ` · ${formatStageAge(m.sendStageSince, nowMs)}`
                        : ""}
                      {m.sendStageDetail ? ` — ${m.sendStageDetail}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-card">
        <CardHeader>
          <CardTitle className="text-base">Agent logs</CardTitle>
          <CardDescription>Last ~50 lines (newest last). The full log is in the agent window.</CardDescription>
        </CardHeader>
        <CardContent>
          {logs.length === 0 ? (
            <EmptyState title="No log lines yet">
              No lines from the agent yet — press a control or send a chat.
            </EmptyState>
          ) : (
            <pre className="max-h-80 overflow-auto rounded-lg bg-muted/60 p-3 font-mono text-xs whitespace-pre-wrap text-foreground">
              {logs.join("\n")}
            </pre>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Play className="size-4" /> To start the agent: run run-agent.bat in the agent window.
        <Square className="ml-4 size-4" /> To stop it, press Ctrl+C in the same window.
      </div>
    </div>
  );
}

function SessionDetail({ detail, at }: { detail: SessionDiagnostic; at: string }) {
  return (
    <div>
      <DiagnosticRow label="Checked">
        {fmtAgo(at)} · <span className="font-mono text-xs">{at}</span>
      </DiagnosticRow>
      <DiagnosticRow label="URL">
        <span className="font-mono text-xs break-all">{detail.url}</span>
      </DiagnosticRow>
      <DiagnosticRow label="Title">{detail.title || "—"}</DiagnosticRow>
      <DiagnosticRow label="Body length">{detail.body_len}</DiagnosticRow>
      <DiagnosticRow label="Links">{detail.links_count}</DiagnosticRow>
      <div className="pt-2">
        <p className="text-sm text-muted-foreground">Selectors (signs of a logged-in page):</p>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {Object.entries(detail.selectors).map(([label, count]) => (
            <Badge key={label} variant={count === 0 || count === "error" ? "destructive" : "success"}>
              {label}={String(count)}
            </Badge>
          ))}
        </div>
      </div>
    </div>
  );
}
