import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider, rootRouteId } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { createDefaultSettings } from "@/lib/seed";
import type { AppState } from "@/lib/types";
import { routeTree } from "@/routeTree.gen";

// The root route's shell renders a literal <html> element, which
// jsdom cannot render inside the test container. Clearing it here
// (test-only, this file never pushes) lets the real app render; the
// shell is irrelevant to the routes under test.
(routeTree as unknown as { options: Record<string, unknown> }).options["shellComponent"] = undefined;

// Match routes without running loaders or rendering: loaders may need a server or
// network the test run lacks, and jsdom never loads the stylesheets React waits on.
describe("App routing", () => {
  it("matches a page for / instead of falling back to not found", () => {
    const router = createRouter({ routeTree, context: { queryClient: new QueryClient() } });

    const matches = router.matchRoutes("/");

    expect(matches.at(-1)?.routeId).not.toBe(rootRouteId);
  });
});

const STORAGE_KEY = "leadhunter:v2";

/** One account + one joined source + one collected post, as the store
 * would persist it. */
function seedState(): AppState {
  return {
    accounts: [{ id: "acc-1", name: "Master", facebookName: "Amir Owaisy", status: "active", createdAt: "2026-11-12T00:00:00.000Z" }],
    sources: [{ id: "src-1", name: "Stocks To Watch", type: "group", url: "https://facebook.com/groups/111", memberCount: 12000, status: "joined", joinedByAccountId: "acc-1", lastScrapedAt: null }],
    posts: [
      {
        id: "post-1",
        sourceId: "src-1",
        accountId: "acc-1",
        postUrl: "https://facebook.com/groups/111/posts/1",
        author: { name: "Poster", url: "https://facebook.com/poster" },
        text: "Planning to put fresh money into PSX before the year ends — banks, cement or fertiliser?",
        comments: [
          { author: { name: "Amit", url: "https://facebook.com/amit" }, text: "nice", postedAt: null, postedAtLabel: "5d", replies: [] },
        ],
        collectedAt: "2026-11-12T00:00:00.000Z",
        lastSyncedAt: null,
      },
    ],
    leads: [],
    activity: [],
    settings: createDefaultSettings(),
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
  // The router must load (match + run beforeLoad) before it renders
  // anything — otherwise RouterProvider renders an empty tree.
  await router.load();
  return { router, ...render(<RouterProvider router={router} />) };
}

describe("Inbox page", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders the Inbox heading and the Messenger-not-connected notice", async () => {
    await renderAt("/inbox");
    expect(await screen.findByRole("heading", { name: "Inbox" })).toBeInTheDocument();
    expect(screen.getByText(/Messenger delivery is not connected yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New chat/ })).toBeInTheDocument();
  });

  it("matches a page for /inbox instead of falling back to not found", () => {
    const router = createRouter({ routeTree, context: { queryClient: new QueryClient() } });
    const matches = router.matchRoutes("/inbox");
    expect(matches.at(-1)?.routeId).not.toBe(rootRouteId);
  });
});

describe("Data Sourcing page", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders Sources only — no Collected Posts section, no Add Post Data button", async () => {
    await renderAt("/data-sourcing");
    // Empty state (no account, no sources) renders without crashing.
    expect(await screen.findByRole("heading", { name: "Data Sourcing" })).toBeInTheDocument();
    expect(screen.getByText("No account yet")).toBeInTheDocument();
    expect(screen.queryByText("Collected Posts")).toBeNull();
    expect(screen.queryByText("Add Post Data")).toBeNull();
  });

  it("clicking the Scraped count opens the per-source posts page, and a post opens its detail", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seedState()));
    const { router } = await renderAt("/data-sourcing");

    // Sources table: one collected post, linked to the per-source page.
    const countLink = await screen.findByRole("link", { name: "1 post" });
    fireEvent.click(countLink);
    await waitFor(() => expect(router.state.location.pathname).toBe("/data-sourcing/src-1"));
    // The posts page REPLACES the sources table — it is not stacked under it.
    expect(await screen.findByRole("heading", { name: "Scraped posts — Stocks To Watch" })).toBeInTheDocument();
    expect(screen.queryByText("Add Source")).toBeNull();

    // Clicking the post opens its detail view.
    const postLink = screen.getByRole("link", { name: /Post Planning to put fresh money/ });
    fireEvent.click(postLink);
    await waitFor(() => expect(router.state.location.pathname).toBe("/data-sourcing/src-1/post-1"));
    expect(await screen.findByRole("heading", { name: /Post Planning to put fresh money/ })).toBeInTheDocument();
    expect(screen.getByText(/1 comments, 0 replies/)).toBeInTheDocument();
  });

  it("opening /data-sourcing/src-1 directly shows the posts page, not the sources table", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seedState()));
    await renderAt("/data-sourcing/src-1");
    expect(await screen.findByRole("heading", { name: "Scraped posts — Stocks To Watch" })).toBeInTheDocument();
    expect(screen.queryByText("Add Source")).toBeNull();
  });
});
