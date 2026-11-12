import { afterEach, describe, expect, it, vi } from "vitest";

import {
  chatHealth,
  chatStart,
  chatStop,
  chatThreads,
  chatWatch,
} from "@/lib/chat-client";
import {
  createAccount,
  createChatThread,
  dailyChatLimit,
  firstUnsentMessage,
  markMessageDelivery,
  mergeLiveThreads,
  setThreadStatus,
  validateSettings,
} from "@/lib/leadhunter-service";
import { createDefaultSettings, createSeedState, DEFAULT_AGENT_URL } from "@/lib/seed";
import type { Account, AppState } from "@/lib/types";

const NOW = "2026-11-12T00:00:00.000Z";

function withAccount(facebookCreatedAt: string | null = "2020-01-01"): AppState {
  const r = createAccount(
    createSeedState(),
    { name: "Master", facebookName: "Amir Owaisy", facebookCreatedAt },
    "acc-1",
    NOW,
  );
  if (!r.ok) throw new Error("fixture account failed");
  return r.value;
}

const INPUT = {
  id: "thread-1",
  profileUrl: "https://www.facebook.com/sana.mirza",
  profileName: "Sana Mirza",
  sourceType: "comment" as const,
  sourceText: "I have 20 lakh saved and never invested, where do I start?",
  sourceUrl: "https://www.facebook.com/groups/111/posts/1",
  shortlistNote: "Rich Beginner",
};

function withThread(): AppState {
  const r = createChatThread(withAccount(), INPUT, "acc-1", "msg-1", NOW);
  if (!r.ok) throw new Error("fixture thread failed");
  return r.value.state;
}

const account = (facebookCreatedAt: string | null, createdAt: string): Account => ({
  id: "acc-1",
  name: "Master",
  facebookName: "Amir Owaisy",
  status: "active",
  createdAt,
  facebookCreatedAt,
});

describe("dailyChatLimit", () => {
  // now = 2026-11-12.
  it("is 0 for a Facebook account under 3 days old", () => {
    expect(dailyChatLimit(account("2026-11-12", NOW), NOW)).toBe(0);
    expect(dailyChatLimit(account("2026-11-10", NOW), NOW)).toBe(0);
  });
  it("is 12 in the first week (days 3–7)", () => {
    expect(dailyChatLimit(account("2026-11-09", NOW), NOW)).toBe(12);
    expect(dailyChatLimit(account("2026-11-05", NOW), NOW)).toBe(12);
  });
  it("is 25 in the second week (days 8–14)", () => {
    expect(dailyChatLimit(account("2026-11-04", NOW), NOW)).toBe(25);
    expect(dailyChatLimit(account("2026-10-29", NOW), NOW)).toBe(25);
  });
  it("is 45 from day 15", () => {
    expect(dailyChatLimit(account("2026-10-28", NOW), NOW)).toBe(45);
    expect(dailyChatLimit(account("2020-01-01", NOW), NOW)).toBe(45);
  });
  it("falls back to the LeadHunter account date when no Facebook date is set", () => {
    // createdAt 2026-11-12 → 0 days old → 0.
    expect(dailyChatLimit(account(null, NOW), NOW)).toBe(0);
    // createdAt 2026-10-01 → 42 days old → 45.
    expect(dailyChatLimit(account(null, "2026-10-01T00:00:00.000Z"), NOW)).toBe(45);
  });
  it("is 0 for an unreadable date", () => {
    expect(dailyChatLimit(account("not-a-date", NOW), NOW)).toBe(0);
  });
});

describe("markMessageDelivery", () => {
  it("updates the delivery and leaves the rest alone", () => {
    const r = markMessageDelivery(withThread(), "msg-1", "sent");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.chatMessages[0]!.delivery).toBe("sent");
    expect(r.value.chatMessages[0]!.text).toContain("Sana");
  });
  it("fails for an unknown message id", () => {
    expect(markMessageDelivery(withThread(), "msg-nope", "sent").ok).toBe(false);
  });
  it("returns the same state when nothing changes", () => {
    const state = withThread();
    const r = markMessageDelivery(state, "msg-1", "in-app");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBe(state);
  });
});

describe("mergeLiveThreads", () => {
  const live = (over: Partial<Parameters<typeof mergeLiveThreads>[1][number]> = {}) => ({
    threadId: "thread-1",
    status: "active",
    messengerThreadUrl: "https://www.facebook.com/messages/t/123",
    messages: [
      { id: "msg-1", role: "agent" as const, text: "Hi Sana!", delivery: "sent" as const, sentAt: NOW },
    ],
    ...over,
  });

  it("updates delivery of a known message id", () => {
    const merged = mergeLiveThreads(withThread(), [live()]);
    expect(merged.chatMessages[0]!.delivery).toBe("sent");
    expect(merged.chatMessages).toHaveLength(1);
  });
  it("appends unknown message ids (agent replies and candidate replies)", () => {
    const merged = mergeLiveThreads(withThread(), [
      live({
        messages: [
          { id: "msg-1", role: "agent" as const, text: "Hi Sana!", delivery: "sent" as const, sentAt: NOW },
          { id: "msg-2", role: "candidate" as const, text: "Hi, tell me more", delivery: "received" as const, sentAt: NOW },
          { id: "msg-3", role: "agent" as const, text: "Sure — here is how it works", delivery: "sent" as const, sentAt: NOW },
        ],
      }),
    ]);
    expect(merged.chatMessages).toHaveLength(3);
    expect(merged.chatMessages[1]!.delivery).toBe("received");
    expect(merged.chatMessages[1]!.role).toBe("candidate");
  });
  it("ignores live threads the app does not know (deleted here)", () => {
    const merged = mergeLiveThreads(withThread(), [
      live({ threadId: "thread-gone", messages: [
        { id: "msg-9", role: "agent" as const, text: "Hello", delivery: "sent" as const, sentAt: NOW },
      ] }),
    ]);
    expect(merged.chatMessages).toHaveLength(1);
    expect(merged.chatMessages[0]!.id).toBe("msg-1");
  });
  it("returns the same state reference when nothing changed", () => {
    const state = withThread();
    const merged = mergeLiveThreads(state, [
      live({ messages: [
        { id: "msg-1", role: "agent" as const, text: "Hi Sana!", delivery: "in-app" as const, sentAt: NOW },
      ] }),
    ]);
    expect(merged).toBe(state);
  });
  it("skips empty-text live messages", () => {
    const merged = mergeLiveThreads(withThread(), [
      live({ messages: [
        { id: "msg-1", role: "agent" as const, text: "Hi Sana!", delivery: "sent" as const, sentAt: NOW },
        { id: "msg-2", role: "agent" as const, text: "   ", delivery: "sent" as const, sentAt: NOW },
      ] }),
    ]);
    expect(merged.chatMessages).toHaveLength(1);
  });
});

describe("settings agentUrl", () => {
  it("defaults to the local agent", () => {
    expect(createDefaultSettings().agentUrl).toBe(DEFAULT_AGENT_URL);
    expect(DEFAULT_AGENT_URL).toBe("http://127.0.0.1:8001");
  });
  it("rejects a non-http agent URL", () => {
    const r = validateSettings({ ...createDefaultSettings(), agentUrl: "localhost:8001" });
    expect(r.ok).toBe(false);
  });
  it("accepts a valid agent URL", () => {
    const r = validateSettings({ ...createDefaultSettings(), agentUrl: "http://127.0.0.1:8001" });
    expect(r.ok).toBe(true);
  });
});

describe("chat-client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  it("health reports watching + thread count from the agent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: true, chat: { watching: true, threads: 2 } })),
    );
    const r = await chatHealth(DEFAULT_AGENT_URL);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ watching: true, threads: 2 });
  });

  it("start posts the first message and returns the thread state", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ threadId: "thread-1", status: "sent", messageRequests: false }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await chatStart(DEFAULT_AGENT_URL, {
      accountId: "acc-1",
      threadId: "thread-1",
      messageId: "msg-1",
      profileUrl: "https://www.facebook.com/sana.mirza",
      profileName: "Sana Mirza",
      sourceType: "comment",
      sourceText: "hello",
      firstMessage: "Hi Sana!",
      dailyCap: 45,
    });
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${DEFAULT_AGENT_URL}/chat/start`);
    expect(JSON.parse(String(init.body)).firstMessage).toBe("Hi Sana!");
  });

  it("watch posts the approved threads, script and key; stop posts empty", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ watching: true, threads: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await chatWatch(DEFAULT_AGENT_URL, {
      accountId: "acc-1",
      threads: [
        { threadId: "thread-1", profileUrl: "https://www.facebook.com/sana.mirza", profileName: "Sana", sourceType: "comment", sourceText: "hi" },
      ],
      script: createSeedState().chatScript,
      geminiKey: "secret-key",
      model: "gemini-3.8-flash",
      dailyCap: 45,
    });
    expect(r.ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.geminiKey).toBe("secret-key");
    expect(body.threads).toHaveLength(1);

    let stopUrl = "";
    const stopMock = vi.fn(async (url: string) => {
      stopUrl = url;
      return jsonResponse({ watching: false });
    });
    vi.stubGlobal("fetch", stopMock);
    const stopped = await chatStop(DEFAULT_AGENT_URL);
    expect(stopped.ok).toBe(true);
    expect(stopUrl).toBe(`${DEFAULT_AGENT_URL}/chat/stop`);
  });

  it("threads returns the live thread list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          watching: true,
          threads: [{ threadId: "thread-1", status: "active", messages: [] }],
        }),
      ),
    );
    const r = await chatThreads(DEFAULT_AGENT_URL);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.threads).toHaveLength(1);
  });

  it("an unreachable agent is a plain error, never a throw", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    const r = await chatHealth(DEFAULT_AGENT_URL);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not running");
  });

  it("an agent error surfaces its detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ detail: "Gemini key is required" }, 400)),
    );
    const r = await chatWatch(DEFAULT_AGENT_URL, {
      accountId: "acc-1",
      threads: [],
      script: createSeedState().chatScript,
      geminiKey: "",
      model: "gemini-3.8-flash",
      dailyCap: 45,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("Gemini key is required");
  });
});

describe("createChatThread duplicate block", () => {
  it("rejects a second active chat for the same profile", () => {
    const r = createChatThread(withThread(), { ...INPUT, id: "thread-2" }, "acc-1", "msg-2", NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("already an active chat");
  });

  it("allows a different profile, and a new chat once the first is done", () => {
    const state = withThread();
    const other = createChatThread(
      state,
      { ...INPUT, id: "thread-2", profileUrl: "https://www.facebook.com/ayesha.khan", profileName: "Ayesha Khan" },
      "acc-1",
      "msg-2",
      NOW,
    );
    expect(other.ok).toBe(true);
    const done = setThreadStatus(state, "thread-1", "done");
    const again = createChatThread(done, { ...INPUT, id: "thread-3" }, "acc-1", "msg-3", NOW);
    expect(again.ok).toBe(true);
  });
});

describe("firstUnsentMessage", () => {
  it("returns the draft first message", () => {
    expect(firstUnsentMessage(withThread(), "thread-1")?.id).toBe("msg-1");
  });

  it("returns null once the first message is sent or in flight", () => {
    const sent = markMessageDelivery(withThread(), "msg-1", "sent");
    expect(sent.ok && firstUnsentMessage(sent.value, "thread-1")).toBeNull();
    const pending = markMessageDelivery(withThread(), "msg-1", "pending-messenger");
    expect(pending.ok && firstUnsentMessage(pending.value, "thread-1")).toBeNull();
  });

  it("returns the first message again after the agent reports it failed", () => {
    const failed = markMessageDelivery(withThread(), "msg-1", "failed");
    expect(failed.ok && firstUnsentMessage(failed.value, "thread-1")?.id).toBe("msg-1");
  });

  it("returns null for an unknown thread", () => {
    expect(firstUnsentMessage(withThread(), "nope")).toBeNull();
  });
});

describe("mergeLiveThreads first-message delivery", () => {
  const live = (delivery: "sent" | "failed") => ({
    threadId: "thread-1",
    status: "active",
    messengerThreadUrl: "https://www.facebook.com/messages/t/123",
    messages: [
      { id: "msg-1", role: "agent" as const, text: "Hi Sana!", delivery, sentAt: NOW },
    ],
  });

  it("flips a pending first message to sent when the agent reports sent", () => {
    const pending = markMessageDelivery(withThread(), "msg-1", "pending-messenger");
    if (!pending.ok) throw new Error("fixture failed");
    const merged = mergeLiveThreads(pending.value, [live("sent")]);
    expect(merged.chatMessages.find((m) => m.id === "msg-1")?.delivery).toBe("sent");
  });

  it("flips a pending first message to failed — never to sent — when the agent reports failed", () => {
    const pending = markMessageDelivery(withThread(), "msg-1", "pending-messenger");
    if (!pending.ok) throw new Error("fixture failed");
    const merged = mergeLiveThreads(pending.value, [live("failed")]);
    const delivery = merged.chatMessages.find((m) => m.id === "msg-1")?.delivery;
    expect(delivery).toBe("failed");
    expect(delivery).not.toBe("sent");
  });
});
