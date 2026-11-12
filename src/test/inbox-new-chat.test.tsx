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

/** One account, no threads yet — a fresh New chat. */
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
    threads: [],
    chatMessages: [],
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

describe("Inbox new chat delivery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seedState()));
  });

  it("sends a fresh New chat's first message to the agent right away", async () => {
    // Regression: the first message was created and the delivery
    // hand-off ran in the same tick, before React re-rendered — the
    // store's ref did not contain the message yet, so the send
    // silently never happened and the message stayed a draft.
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/health")) {
        return jsonResponse({ chat: { watching: false, threads: 0 } });
      }
      if (String(url).endsWith("/chat/threads")) {
        return jsonResponse({ watching: false, threads: [] });
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
    fireEvent.click(await screen.findByRole("button", { name: /New chat/ }));
    fireEvent.change(await screen.findByLabelText("Profile link *"), {
      target: { value: "https://www.facebook.com/sana.mirza" },
    });
    fireEvent.change(await screen.findByLabelText("Name *"), {
      target: { value: "Sana Mirza" },
    });
    fireEvent.change(await screen.findByLabelText("Their comment *"), {
      target: { value: "where do I start?" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Start chat/ }));

    // The hand-off marks the message Sending… while the agent works.
    expect(await screen.findByText(/Sending to Messenger…/)).toBeInTheDocument();

    await waitFor(() => {
      const start = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/chat/start"));
      expect(start).toBeDefined();
    });
    const [, startInit] = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/chat/start"),
    ) as unknown as [string, RequestInit];
    const startBody = JSON.parse(String(startInit.body));
    expect(startBody.profileUrl).toBe("https://www.facebook.com/sana.mirza");
    expect(startBody.profileName).toBe("Sana Mirza");
    expect(startBody.firstMessage).toContain("Sana");
  });
});
