import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDefaultSettings, createSeedState } from "@/lib/seed";
import { routeTree } from "@/routeTree.gen";
import type { AppState } from "@/lib/types";

// Same harness as inbox-retry.test.tsx: the root route's shell
// renders a literal <html> element, which jsdom cannot render
// inside the test container.
(routeTree as unknown as { options: Record<string, unknown> }).options["shellComponent"] =
  undefined;

const STORAGE_KEY = "leadhunter:v2";
const ZAINAB_FIRST = `Hi Zainab! I read your comment where you said "I'm new in Stock Market and Trading."`;
const ZAINAB_REPLY = "Hello, I am interested!";
const OWN_TEXT = "Hi Zainab, this is Amir — happy to answer any question first.";

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
      {
        id: "thread-2",
        accountId: "acc-1",
        profileUrl: "https://www.facebook.com/sana.mirza",
        profileName: "Sana Mirza",
        sourceType: "comment",
        sourceText: "where do I start?",
        sourceUrl: "",
        shortlistNote: "Rich Beginner",
        status: "active",
        createdAt: "2026-11-13T02:20:00.000Z",
      },
    ],
    chatMessages: [
      {
        id: "msg-1",
        threadId: "thread-1",
        role: "agent",
        text: ZAINAB_FIRST,
        createdAt: "2026-11-13T02:19:00.000Z",
        delivery: "in-app",
      },
      {
        id: "msg-2",
        threadId: "thread-1",
        role: "candidate",
        text: ZAINAB_REPLY,
        createdAt: "2026-11-13T02:20:00.000Z",
        delivery: "in-app",
      },
      {
        id: "msg-3",
        threadId: "thread-2",
        role: "agent",
        text: "Hi Sana! I read your comment about starting.",
        createdAt: "2026-11-13T02:20:00.000Z",
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

const agentUpFetch = () =>
  vi.fn(async (url: string) => {
    if (String(url).endsWith("/health")) {
      return jsonResponse({ chat: { watching: true, threads: 0 } });
    }
    if (String(url).endsWith("/chat/threads")) {
      return jsonResponse({ watching: true, threads: [] });
    }
    if (String(url).endsWith("/chat/forget")) {
      return jsonResponse({ forgotten: true, sendStopped: true });
    }
    if (String(url).endsWith("/chat/start")) {
      return jsonResponse({ threadId: "thread-1", status: "starting" }, 202);
    }
    if (String(url).endsWith("/chat/watch")) {
      return jsonResponse({ watching: true, threads: 1 });
    }
    return jsonResponse({}, 404);
  });

describe("Inbox chat deletion", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seedState()));
  });

  it("needs two clicks: the first arms, the second deletes the open thread", async () => {
    const fetchMock = agentUpFetch();
    vi.stubGlobal("fetch", fetchMock);

    await renderAt("/inbox");
    fireEvent.click(await screen.findByText("Zainab"));
    const deleteButton = await screen.findByRole("button", { name: "Delete" });

    fireEvent.click(deleteButton);
    // Armed — the thread is still there (list row + header link),
    // and the button now asks.
    expect(await screen.findByRole("button", { name: "Confirm delete?" })).toBeInTheDocument();
    expect(screen.getAllByText("Zainab")).toHaveLength(2);

    fireEvent.click(await screen.findByRole("button", { name: "Confirm delete?" }));
    // The thread + its messages are gone; the other thread stays.
    await waitFor(() => {
      expect(screen.queryByText("Zainab")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Sana Mirza")).toBeInTheDocument();
    expect(screen.getByText("Pick a chat, or start a new one")).toBeInTheDocument();

    // The agent was told to forget the thread too.
    await waitFor(() => {
      const forget = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/chat/forget"));
      expect(forget).toBeDefined();
    });
    const [, forgetInit] = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/chat/forget"),
    ) as unknown as [string, RequestInit];
    expect(JSON.parse(String(forgetInit.body)).threadId).toBe("thread-1");
  });

  it("deletes from the Chats list and leaves the other thread untouched", async () => {
    const fetchMock = agentUpFetch();
    vi.stubGlobal("fetch", fetchMock);

    await renderAt("/inbox");
    const rowDelete = await screen.findByRole("button", { name: "Delete chat with Zainab" });
    fireEvent.click(rowDelete);
    // Armed — first click only.
    expect(
      await screen.findByRole("button", { name: "Confirm delete chat with Zainab" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Zainab")).toBeInTheDocument();

    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm delete chat with Zainab" }),
    );
    await waitFor(() => {
      expect(screen.queryByText("Zainab")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Sana Mirza")).toBeInTheDocument();
    // The row preview shows the last message ("You: Hi Sana!…").
    expect(screen.getByText(/Hi Sana! I read your comment about starting/)).toBeInTheDocument();
  });

  it("still deletes locally when the agent is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    await renderAt("/inbox");
    fireEvent.click(await screen.findByText("Zainab"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm delete?" }));
    await waitFor(() => {
      expect(screen.queryByText("Zainab")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Sana Mirza")).toBeInTheDocument();
  });
});

describe("Inbox message as yourself", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seedState()));
  });

  it("renders a manual own message on your side (orange, like the first message)", async () => {
    const fetchMock = agentUpFetch();
    vi.stubGlobal("fetch", fetchMock);

    await renderAt("/inbox");
    fireEvent.click(await screen.findByText("Zainab"));
    const box = await screen.findByLabelText("Type a message as yourself");
    fireEvent.change(box, { target: { value: OWN_TEXT } });
    fireEvent.click(await screen.findByRole("button", { name: /Send as yourself/ }));

    const bubble = await screen.findByText(OWN_TEXT);
    expect(bubble.closest("div")).toHaveClass("bg-primary");
    expect(bubble.parentElement?.parentElement).toHaveClass("justify-end");

    // The agent got the exact text through the same send path.
    await waitFor(() => {
      const start = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/chat/start"));
      expect(start).toBeDefined();
    });
    const [, startInit] = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/chat/start"),
    ) as unknown as [string, RequestInit];
    const startBody = JSON.parse(String(startInit.body));
    expect(startBody.threadId).toBe("thread-1");
    expect(startBody.firstMessage).toBe(OWN_TEXT);
  });

  it("keeps a pasted candidate reply on the candidate side (grey)", async () => {
    vi.stubGlobal("fetch", agentUpFetch());
    await renderAt("/inbox");
    fireEvent.click(await screen.findByText("Zainab"));

    const reply = await screen.findByText(ZAINAB_REPLY);
    expect(reply.closest("div")).toHaveClass("bg-muted");
    expect(reply.parentElement?.parentElement).toHaveClass("justify-start");

    // And the first message is on your side too.
    const first = screen.getByText(ZAINAB_FIRST);
    expect(first.closest("div")).toHaveClass("bg-primary");
    expect(first.parentElement?.parentElement).toHaveClass("justify-end");
  });

  it("keeps a manual message as a draft with a retry when the agent is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    await renderAt("/inbox");
    fireEvent.click(await screen.findByText("Zainab"));
    const box = await screen.findByLabelText("Type a message as yourself");
    fireEvent.change(box, { target: { value: OWN_TEXT } });
    fireEvent.click(await screen.findByRole("button", { name: /Send as yourself/ }));

    // Stored on your side, marked a draft, with the retry button.
    // Both own messages are drafts now (the first message + the new one).
    const bubble = await screen.findByText(OWN_TEXT);
    expect(bubble.closest("div")).toHaveClass("bg-primary");
    const drafts = await screen.findAllByText(/Agent draft · In-app only/);
    expect(drafts).toHaveLength(2);
    const retries = await screen.findAllByRole("button", { name: /Send to Messenger now/ });
    expect(retries).toHaveLength(2);

    // Nothing reached the agent (there is no agent to reach).
    expect(
      await screen.findByText(/In-app only — Messenger delivery is not connected/),
    ).toBeInTheDocument();
  });
});
