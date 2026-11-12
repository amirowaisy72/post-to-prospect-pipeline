import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDefaultSettings, createSeedState } from "@/lib/seed";
import { routeTree } from "@/routeTree.gen";
import type { AppState } from "@/lib/types";

// Same harness as app-routing.test.tsx: the root route's shell renders
// a literal <html> element, which jsdom cannot render inside the test
// container.
(routeTree as unknown as { options: Record<string, unknown> }).options["shellComponent"] =
  undefined;

const STORAGE_KEY = "leadhunter:v2";
const FIRST_TEXT = `Hi Zainab! I read your comment where you said "I'm new in Stock Market and Trading."`;

/** One account + one active thread whose first message never left the
 * app (created while the agent was down) — the user's live case. */
function seedState(): AppState {
  const base = createSeedState();
  return {
    ...base,
    accounts: [
      {
        id: "acc-1",
        name: "Master",
        facebookName: "Amir Owaisy",
        status: "active",
        createdAt: "2026-11-12T00:00:00.000Z",
        facebookCreatedAt: "2020-01-01",
      },
    ],
    sources: [],
    posts: [],
    leads: [],
    activity: [],
    threads: [
      {
        id: "thread-1",
        accountId: "acc-1",
        profileUrl: "https://www.facebook.com/zainab.ansari",
        profileName: "Zainab",
        sourceType: "comment",
        sourceText: "I'm new in Stock Market and Trading.",
        sourceUrl: "",
        shortlistNote: "Beginner",
        status: "active",
        createdAt: "2026-11-13T02:19:00.000Z",
      },
    ],
    chatMessages: [
      {
        id: "msg-1",
        threadId: "thread-1",
        role: "agent",
        text: FIRST_TEXT,
        createdAt: "2026-11-13T02:19:00.000Z",
        delivery: "in-app",
      },
    ],
    settings: { ...createDefaultSettings(), geminiApiKey: "test-key" },
    activeAccountId: "acc-1",
    defaultAccountId: "acc-1",
  };
}

async function renderAt(path: string) {
  const router = createRouter({
    routeTree,
    context: { queryClient: new QueryClient() },
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  return render(<RouterProvider router={router} />);
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("Inbox first-message retry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seedState()));
  });

  it("re-sends a draft first message via the agent and joins the watcher", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/health")) {
        return jsonResponse({ chat: { watching: true, threads: 0 } });
      }
      if (String(url).endsWith("/chat/threads")) {
        return jsonResponse({ watching: true, threads: [] });
      }
      if (String(url).endsWith("/chat/start")) {
        return jsonResponse({ threadId: "thread-1", status: "starting" }, 202);
      }
      if (String(url).endsWith("/chat/watch")) {
        return jsonResponse({ watching: true, threads: 1 });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderAt("/inbox");
    // Open the thread: the draft caption and the retry action appear.
    fireEvent.click(await screen.findByText("Zainab"));
    expect(await screen.findByText(/Agent draft · In-app only/)).toBeInTheDocument();
    const retry = await screen.findByRole("button", { name: /Send to Messenger now/ });

    fireEvent.click(retry);
    // The hand-off marks the message Sending… while the agent works.
    expect(await screen.findByText(/Sending to Messenger…/)).toBeInTheDocument();

    // The agent got the same first message (same thread + message id).
    await waitFor(() => {
      const start = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/chat/start"));
      expect(start).toBeDefined();
    });
    const [, startInit] = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/chat/start"),
    ) as unknown as [string, RequestInit];
    const startBody = JSON.parse(String(startInit.body));
    expect(startBody.threadId).toBe("thread-1");
    expect(startBody.messageId).toBe("msg-1");
    expect(startBody.firstMessage).toBe(FIRST_TEXT);

    // And the thread joins the watcher like a fresh live chat.
    await waitFor(() => {
      const watch = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/chat/watch"));
      expect(watch).toBeDefined();
    });
    const [, watchInit] = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/chat/watch"),
    ) as unknown as [string, RequestInit];
    const watchBody = JSON.parse(String(watchInit.body));
    expect(watchBody.threads.map((t: { threadId: string }) => t.threadId)).toContain("thread-1");
  });

  it("leaves the draft in place when the agent is down, so it can be retried later", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    await renderAt("/inbox");
    fireEvent.click(await screen.findByText("Zainab"));
    const retry = await screen.findByRole("button", { name: /Send to Messenger now/ });

    fireEvent.click(retry);
    // Still a draft — nothing was claimed as sent.
    expect(await screen.findByText(/Agent draft · In-app only/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Send to Messenger now/ })).toBeInTheDocument();
    expect(retry).toBeInTheDocument();
  });

  it("shows no retry once the first message is sent", async () => {
    const sent = seedState();
    sent.chatMessages = [
      { ...sent.chatMessages[0]!, delivery: "sent" },
    ];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sent));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/health")) {
          return jsonResponse({ chat: { watching: true, threads: 0 } });
        }
        return jsonResponse({ watching: true, threads: [] });
      }),
    );

    await renderAt("/inbox");
    fireEvent.click(await screen.findByText("Zainab"));
    expect(await screen.findByText(/Sent to Messenger/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Send to Messenger now/ })).toBeNull();
  });
});
