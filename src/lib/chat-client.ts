/**
 * Chat agent client — the Inbox talks to the local Python agent
 * (run-agent.bat, http://127.0.0.1:8001) for live Messenger delivery.
 * Chat-only: it never touches scraping. Every call returns a result
 * object and never throws; an unreachable agent is a plain error the
 * UI shows honestly. The Gemini key travels in POST bodies over
 * localhost only — never in a URL.
 */
import type { LiveChatThread } from "./leadhunter-service";
import type { ChatScript } from "./types";

export interface ChatAgentThread extends LiveChatThread {
  accountId: string;
  profileUrl: string;
  profileName: string;
  lastError?: string | null;
}

export type ChatResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ChatHealth {
  watching: boolean;
  threads: number;
}

export interface ChatStartInput {
  accountId: string;
  threadId: string;
  messageId: string;
  profileUrl: string;
  profileName: string;
  sourceType: "comment" | "post";
  sourceText: string;
  firstMessage: string;
  dailyCap: number;
}

export interface ChatWatchThread {
  threadId: string;
  profileUrl: string;
  profileName: string;
  sourceType: "comment" | "post";
  sourceText: string;
}

export interface ChatWatchInput {
  accountId: string;
  threads: ChatWatchThread[];
  script: ChatScript;
  geminiKey: string;
  model: string;
  dailyCap: number;
}

const AGENT_DOWN = "Chat agent is not running — start it with run-agent.bat.";

async function call<T>(
  agentUrl: string,
  path: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<ChatResult<T>> {
  const base = agentUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
      ...init,
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const detail =
        data && typeof data["detail"] === "string" ? data["detail"] : `Agent error ${res.status}`;
      return { ok: false, error: detail };
    }
    return { ok: true, value: data as T };
  } catch {
    return { ok: false, error: AGENT_DOWN };
  } finally {
    window.clearTimeout(timer);
  }
}

/** Is the agent up, and is the watcher running? */
export async function chatHealth(agentUrl: string): Promise<ChatResult<ChatHealth>> {
  const r = await call<{ chat?: { watching?: boolean; threads?: number } }>(
    agentUrl,
    "/health",
    undefined,
    8000,
  );
  if (!r.ok) return r;
  return {
    ok: true,
    value: {
      watching: r.value.chat?.watching ?? false,
      threads: r.value.chat?.threads ?? 0,
    },
  };
}

/** Send the first message to a newly approved candidate (202 = started). */
export async function chatStart(
  agentUrl: string,
  input: ChatStartInput,
): Promise<ChatResult<{ threadId: string; status: string }>> {
  return call(agentUrl, "/chat/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }, 20000);
}

/** (Re)start the watcher with the approved threads + script + key. */
export async function chatWatch(
  agentUrl: string,
  input: ChatWatchInput,
): Promise<ChatResult<{ watching: boolean; threads: number }>> {
  return call(agentUrl, "/chat/watch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }, 20000);
}

/** Live thread states for the app to poll. */
export async function chatThreads(
  agentUrl: string,
): Promise<ChatResult<{ threads: ChatAgentThread[]; watching: boolean }>> {
  return call(agentUrl, "/chat/threads", undefined, 8000);
}

/** Stop ALL chatting immediately. */
export async function chatStop(
  agentUrl: string,
): Promise<ChatResult<{ watching: boolean }>> {
  return call(agentUrl, "/chat/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  }, 20000);
}

/** Forget a deleted chat thread on the agent: stops its in-flight
 * send, drops it from the watch list, and deletes its rows + stage
 * trail. The app calls this before deleting locally. Never touches
 * Facebook. Best-effort: when the agent is down there is nothing to
 * forget, and the next watch sync already drops the thread. */
export async function chatForget(
  agentUrl: string,
  threadId: string,
): Promise<ChatResult<{ forgotten: boolean; sendStopped: boolean }>> {
  return call(agentUrl, "/chat/forget", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadId }),
  }, 20000);
}

// ----------------------------------------------------------------------
// Agent Control page (src/routes/agent-control.tsx)
// ----------------------------------------------------------------------

export type AgentSessionState = "ok" | "logged_out" | "checkpoint" | "blocked" | "empty";

/** Structured detail of one session check: what the page actually
 * looked like (selectors are per logged-in selector counts, or
 * "error" when the read itself threw). */
export interface SessionDiagnostic {
  url: string;
  title: string;
  body_len: number;
  links_count: number;
  selectors: Record<string, number | string>;
}

export interface SessionCheckRecord {
  state: AgentSessionState;
  at: string;
  detail: SessionDiagnostic;
}

export interface AgentStatus {
  online: boolean;
  profile: string;
  profileExists: boolean;
  headed: boolean;
  browser: "alive" | "dead" | "not-started";
  watching: boolean;
  watchedThreads: number;
  chatStartBusy: boolean;
  lastSessionCheck: SessionCheckRecord | null;
  sendsToday: number;
  sendsTodayDate: string;
}

export interface SessionCheckResult {
  state: AgentSessionState;
  at: string;
  detail: SessionDiagnostic;
}

export interface AgentReloadResult extends SessionCheckResult {
  reloaded: boolean;
}

/** Agent Control status. Never launches a browser — the browser
 * field only reports the cached page. */
export async function agentStatus(
  agentUrl: string,
  accountId: string,
): Promise<ChatResult<AgentStatus>> {
  const q = accountId ? `?accountId=${encodeURIComponent(accountId)}` : "";
  return call(agentUrl, `/agent/status${q}`, undefined, 8000);
}

/** Re-check the Facebook session on the Messenger page. Can take a
 * while (page loads + retries) — long timeout on purpose. */
export async function agentSessionCheck(
  agentUrl: string,
): Promise<ChatResult<SessionCheckResult>> {
  return call(agentUrl, "/agent/session-check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  }, 120000);
}

/** Close the Chromium browser and launch it fresh from the same
 * profile. Restarts the BROWSER only, never the agent process. */
export async function agentBrowserRelaunch(
  agentUrl: string,
): Promise<ChatResult<{ relaunched: boolean; browser: string; profile: string; headed: boolean }>> {
  return call(agentUrl, "/agent/browser-relaunch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  }, 120000);
}

/** Load the Messenger page fresh and re-check the session. */
export async function agentReloadMessenger(
  agentUrl: string,
): Promise<ChatResult<AgentReloadResult>> {
  return call(agentUrl, "/agent/reload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  }, 120000);
}

/** Stop watching only — in-flight sends are NOT stopped. */
export async function agentUnwatch(
  agentUrl: string,
): Promise<ChatResult<{ watching: boolean }>> {
  return call(agentUrl, "/agent/unwatch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  }, 20000);
}

/** Last ~50 agent log lines (newest last). */
export async function agentLogs(
  agentUrl: string,
): Promise<ChatResult<{ lines: string[] }>> {
  return call(agentUrl, "/agent/logs", undefined, 8000);
}
