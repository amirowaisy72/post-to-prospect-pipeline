import { createFileRoute } from "@tanstack/react-router";
import {
  Ban,
  Bot,
  Eye,
  EyeOff,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
} from "lucide-react";
import { useEffect, useState } from "react";

import { EmptyState, PageHeader } from "@/components/page-header";
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
 * user asked for are verbatim ("Session OK" / "Abhi bhi empty —
 * browser restart karein"); the hints say which button fixes it.
 */
function sessionVerdict(state: AgentSessionState): { title: string; hint: string } {
  switch (state) {
    case "ok":
      return { title: "Session OK", hint: "Facebook session live hai — sends ja sakte hain." };
    case "empty":
      return {
        title: "Abhi bhi empty — browser restart karein",
        hint: "Messenger page khaali aa raha hai. Relaunch browser dabayein, phir Re-check session.",
      };
    case "logged_out":
      return {
        title: "Logged out",
        hint: "Apne Chrome profile se Facebook mein khud sign in karein, phir Re-check session dabayein.",
      };
    case "checkpoint":
      return {
        title: "Checkpoint",
        hint: "Facebook ne verification mangi hai — apne browser mein khud check karein, phir Re-check session dabayein.",
      };
    case "blocked":
      return {
        title: "Blocked",
        hint: "Facebook ne rok diya hai — thoda waqt dein, phir Relaunch browser + Re-check session.",
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
          `Browser relaunched (${r.value.browser}). Ab Re-check session dabayein — session dobara check hogi.`,
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
          setActionNote("Watching stopped — current check ke baad koi reply nahi dekha jayega.");
          await refreshAll();
        } else {
          setActionNote(`Stop watching failed: ${r.error}`);
        }
      } else {
        const joined = await sendChatWatch();
        setActionNote(
          joined
            ? "Watching started — agent ab replies ka wait karega."
            : "Nothing to watch — koi active chat nahi hai, ya Gemini key missing hai.",
        );
        await refreshAll();
      }
    });

  const onStopAll = () =>
    run("stop", async () => {
      const ok = await stopAllChatting();
      setActionNote(
        ok ? "All chatting stopped." : "Stop failed — agent running hai ya nahi, upar dekhein.",
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
        description="Agent ki haalat, session, aur browser — sab kuch yahan se. Jo control UI se mumkin nahi, wo neeche saaf likha hai."
      />

      {/* Status */}
      <Card className="shadow-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Bot /> Agent status
          </CardTitle>
          <CardDescription>
            Refreshes every 10 seconds. Status check browser launch nahi karta — sirf haalat batata hai.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {statusError && !status ? (
            <EmptyState title="Agent offline">
              {statusError} Agent window (run-agent.bat) check karein — wo band ho to dobara chalayein.
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
                  "Not checked yet — Re-check session dabayein."
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
            Session-empty ka fix bhi yahin se: pehle Re-check session, phir Relaunch browser, phir dobara Re-check.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
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
            <p className="font-semibold text-foreground">Jo UI se NAHI ho sakta — chhupaya nahi:</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              <li>
                Agent process ko yahan se restart nahi kar sakte — wo alag window mein chalta hai
                (run-agent.bat). Us window mein Ctrl+C dabayein, phir run-agent.bat dobara chalayein.
              </li>
              <li>
                Chrome profile aur headless/headed sirf agent start karte waqt badalte hain
                (LEADHUNTER_CHROME_PROFILE / LEADHUNTER_HEADED) — chalte hue agent par nahi.
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
                Re-check session dabayein — detail yahan aayegi.
              </EmptyState>
            ) : (
              <SessionDetail detail={lastCheck.detail} at={lastCheck.at} />
            )}
          </CardContent>
        </Card>

        <Card className="shadow-card">
          <CardHeader>
            <CardTitle className="text-base">Recent send stages</CardTitle>
            <CardDescription>Apke messages ki aakhri haalat (Inbox wali stages).</CardDescription>
          </CardHeader>
          <CardContent>
            {stagedMessages.length === 0 ? (
              <EmptyState title="No sends with a stage yet">
                Koi message abhi send nahi hua, ya uska stage khatam ho gaya.
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
          <CardDescription>Last ~50 lines (newest last). Poora log agent window mein hai.</CardDescription>
        </CardHeader>
        <CardContent>
          {logs.length === 0 ? (
            <EmptyState title="No log lines yet">
              Agent se koi line nahi aayi — koi control dabayein ya chat bhejein.
            </EmptyState>
          ) : (
            <pre className="max-h-80 overflow-auto rounded-lg bg-muted/60 p-3 font-mono text-xs whitespace-pre-wrap text-foreground">
              {logs.join("\n")}
            </pre>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Play className="size-4" /> Agent start karne ke liye: agent window mein run-agent.bat chalayein
        (LEADHUNTER_CHROME_PROFILE ke saath).
        <Square className="ml-4 size-4" /> Band karne ke liye usi window mein Ctrl+C.
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
        <p className="text-sm text-muted-foreground">Selectors (logged-in page ke nishan):</p>
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
