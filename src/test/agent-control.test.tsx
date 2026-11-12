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

const STATUS = {
  online: true,
  profile: "G:\\Web Apps\\post-to-prospect-pipeline\\agent\\profiles\\acc-1",
  profileExists: true,
  headed: false,
  browser: "alive",
  watching: true,
  watchedThreads: 1,
  chatStartBusy: false,
  lastSessionCheck: {
    state: "ok",
    at: "2026-11-13T03:00:00.000Z",
    detail: {
      url: "https://www.facebook.com/messages",
      title: "Messenger",
      body_len: 12345,
      links_count: 87,
      selectors: { "Your profile": 1, Account: 1, "/me/": 1, Messenger: 1 },
    },
  },
  sendsToday: 3,
  sendsTodayDate: "2026-11-13",
};

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
        text: "Hi Zainab! I read your comment.",
        createdAt: "2026-11-13T02:19:00.000Z",
        delivery: "pending-messenger",
        sendStage: "checking session",
        sendStageSince: new Date(Date.now() - 45000).toISOString(),
        sendStageDetail: null,
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

/** Agent up; session-check outcome is the caller's choice. */
const agentUpFetch = (sessionState = "ok") =>
  vi.fn(async (url: string) => {
    if (String(url).endsWith("/health")) {
      return jsonResponse({ chat: { watching: true, threads: 1 } });
    }
    if (String(url).endsWith("/chat/threads")) {
      return jsonResponse({ watching: true, threads: [] });
    }
    if (String(url).startsWith("http://127.0.0.1:8001/agent/status")) {
      return jsonResponse(STATUS);
    }
    if (String(url).endsWith("/agent/logs")) {
      return jsonResponse({ lines: ["2026-11-13T03:00:00Z session check: ok (url=https://www.facebook.com/messages, body_len=12345)"] });
    }
    if (String(url).endsWith("/agent/signin")) {
      return jsonResponse({
        ok: true,
        accountId: "acc-1",
        profile: "G:\\Web Apps\\post-to-prospect-pipeline\\agent\\profiles\\acc-1",
        detail: "Browser opened — sign in to Facebook yourself in that window, then press Relaunch browser.",
      });
    }
    if (String(url).endsWith("/agent/session-check")) {
      return jsonResponse({
        state: sessionState,
        at: "2026-11-13T03:05:00.000Z",
        detail: {
          url: "https://www.facebook.com/messages",
          title: sessionState === "empty" ? "?" : "Messenger",
          body_len: sessionState === "empty" ? -1 : 12345,
          links_count: sessionState === "empty" ? -1 : 87,
          selectors:
            sessionState === "empty"
              ? { "Your profile": "error", Account: "error", "/me/": "error", Messenger: "error" }
              : { "Your profile": 1, Account: 1, "/me/": 1, Messenger: 1 },
        },
      });
    }
    if (String(url).endsWith("/agent/browser-relaunch")) {
      return jsonResponse({ relaunched: true, browser: "alive", profile: STATUS.profile, headed: false });
    }
    if (String(url).endsWith("/agent/reload")) {
      return jsonResponse({ reloaded: true, state: "ok", at: "2026-11-13T03:05:00.000Z", detail: STATUS.lastSessionCheck.detail });
    }
    if (String(url).endsWith("/agent/unwatch")) {
      return jsonResponse({ watching: false });
    }
    if (String(url).endsWith("/chat/watch")) {
      return jsonResponse({ watching: true, threads: 1 });
    }
    return jsonResponse({}, 404);
  });

describe("Agent Control page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seedState()));
  });

  it("shows the agent status: profile, headless, browser, watching, session, sends today", async () => {
    vi.stubGlobal("fetch", agentUpFetch());
    await renderAt("/agent-control");

    expect(await screen.findByRole("heading", { name: "Agent Control" })).toBeInTheDocument();
    expect(await screen.findByText(/G:\\Web Apps\\post-to-prospect-pipeline\\agent\\profiles\\acc-1/)).toBeInTheDocument();
    expect(await screen.findByText(/Headless \(silent\)/)).toBeInTheDocument();
    expect(await screen.findByText("Alive")).toBeInTheDocument();
    expect(await screen.findByText(/3 \/ 45/)).toBeInTheDocument();
    // Session from the last check — badge in the status card + the
    // verdict box below the controls.
    expect((await screen.findAllByText("Session OK")).length).toBe(2);
    expect(await screen.findByText(/Checking session/)).toBeInTheDocument();
    expect(await screen.findByText(/session check: ok/)).toBeInTheDocument();
  });

  it("re-checks the session and shows Session OK", async () => {
    const fetchMock = agentUpFetch("ok");
    vi.stubGlobal("fetch", fetchMock);
    await renderAt("/agent-control");
    fireEvent.click(await screen.findByRole("button", { name: /Re-check session/ }));

    await waitFor(() => {
      const check = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/agent/session-check"));
      expect(check).toBeDefined();
    });
    expect((await screen.findAllByText("Session OK")).length).toBe(2);
    // body_len 12345 in the session detail + in the log line.
    expect((await screen.findAllByText(/12345/)).length).toBe(2);
  });

  it("shows the empty verdict with the browser-restart fix when the session is still empty", async () => {
    const fetchMock = agentUpFetch("empty");
    vi.stubGlobal("fetch", fetchMock);
    await renderAt("/agent-control");
    fireEvent.click(await screen.findByRole("button", { name: /Re-check session/ }));

    expect(await screen.findByText("Abhi bhi empty — browser restart karein")).toBeInTheDocument();
    expect(await screen.findByText(/Relaunch browser dabayein/)).toBeInTheDocument();
    // The empty detail is visible too (body_len -1 and links_count -1).
    expect((await screen.findAllByText("-1")).length).toBe(2);
  });

  it("relaunches the browser and tells the user to re-check the session", async () => {
    const fetchMock = agentUpFetch();
    vi.stubGlobal("fetch", fetchMock);
    await renderAt("/agent-control");
    fireEvent.click(await screen.findByRole("button", { name: /Relaunch browser/ }));

    await waitFor(() => {
      const relaunch = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/agent/browser-relaunch"));
      expect(relaunch).toBeDefined();
    });
    expect(await screen.findByText(/Browser relaunched \(alive\)/)).toBeInTheDocument();
    expect(await screen.findByText(/Ab Re-check session dabayein/)).toBeInTheDocument();
  });

  it("reloads the Messenger page and re-checks the session", async () => {
    const fetchMock = agentUpFetch();
    vi.stubGlobal("fetch", fetchMock);
    await renderAt("/agent-control");
    fireEvent.click(await screen.findByRole("button", { name: /Reload Messenger page/ }));

    await waitFor(() => {
      const reload = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/agent/reload"));
      expect(reload).toBeDefined();
    });
    expect(await screen.findByText(/Messenger page reloaded/)).toBeInTheDocument();
  });

  it("stops watching via the unwatch endpoint", async () => {
    const fetchMock = agentUpFetch();
    vi.stubGlobal("fetch", fetchMock);
    await renderAt("/agent-control");
    fireEvent.click(await screen.findByRole("button", { name: /Stop watching/ }));

    await waitFor(() => {
      const unwatch = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/agent/unwatch"));
      expect(unwatch).toBeDefined();
    });
    expect(await screen.findByText(/Watching stopped/)).toBeInTheDocument();
  });

  it("says plainly when the agent is down — and what cannot be done from the UI", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await renderAt("/agent-control");

    expect(await screen.findByText("Agent offline")).toBeInTheDocument();
    expect(await screen.findByText(/Agent window \(run-agent\.bat\) check karein/)).toBeInTheDocument();
    // The honest limits box is always visible, agent up or down.
    expect(await screen.findByText(/Jo UI se NAHI ho sakta/)).toBeInTheDocument();
    expect(await screen.findByText(/Us window mein Ctrl\+C dabayein/)).toBeInTheDocument();
    expect(await screen.findByText(/Sign-in sirf ek baar/)).toBeInTheDocument();
  });

  it("opens the sign-in window and tells the user to sign in himself", async () => {
    const fetchMock = agentUpFetch();
    vi.stubGlobal("fetch", fetchMock);
    await renderAt("/agent-control");
    fireEvent.click(await screen.findByRole("button", { name: /Sign in to Facebook/ }));

    await waitFor(() => {
      const signin = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/agent/signin"));
      expect(signin).toBeDefined();
      // The agent opens the window for the ACTIVE account — no
      // password, no other app's profile.
      const init = (signin as unknown as [string, RequestInit | undefined])[1];
      expect(JSON.parse(String(init?.body ?? "{}"))).toEqual({ accountId: "acc-1" });
    });
    expect(await screen.findByText(/Chrome window khul gayi/)).toBeInTheDocument();
    expect(await screen.findByText(/Relaunch browser dabayein/)).toBeInTheDocument();
  });
});
