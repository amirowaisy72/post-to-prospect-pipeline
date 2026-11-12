import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { dailyChatLimit, setFacebookCreatedAt } from "@/lib/leadhunter-service";
import { createDefaultSettings, createSeedState } from "@/lib/seed";
import { routeTree } from "@/routeTree.gen";
import type { AppState } from "@/lib/types";

// Same harness as agent-control.test.tsx: the root route's shell
// renders a literal <html> element, which jsdom cannot render
// inside the test container.
(routeTree as unknown as { options: Record<string, unknown> }).options["shellComponent"] =
  undefined;

const STORAGE_KEY = "leadhunter:v2";

/** The live case: Master, added 2026-11-12, Facebook date never set. */
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
        facebookCreatedAt: null,
      },
    ],
    sources: [],
    posts: [],
    leads: [],
    activity: [],
    threads: [],
    chatMessages: [],
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
  await router.load();
  return render(<RouterProvider router={router} />);
}

function savedAccount() {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  const saved = JSON.parse(raw ?? "{}") as AppState;
  const account = saved.accounts[0];
  if (!account) throw new Error("no account saved");
  return account;
}

function seedAccount() {
  const account = seedState().accounts[0];
  if (!account) throw new Error("no seed account");
  return account;
}

describe("Accounts page — edit an existing account's Facebook created date", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seedState()));
  });

  it("saves the date, shows 'FB since <date>' on the row, and the daily cap becomes 45", async () => {
    const { container } = await renderAt("/accounts");
    expect(await screen.findByRole("heading", { name: "Accounts" })).toBeInTheDocument();
    expect(screen.queryByText(/FB since/)).not.toBeInTheDocument();
    // Without the date the cap falls back to the LeadHunter-created
    // date (2026-11-12) — 1 day old on 2026-11-13, so 0/day.
    expect(dailyChatLimit(seedAccount(), "2026-11-13T04:00:00.000Z")).toBe(0);

    fireEvent.click(
      await screen.findByRole("button", { name: "Edit Facebook created date for Master" }),
    );
    const input = container.querySelector("#edit-fb-created-acc-1") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "2019-05-20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save date" }));

    expect(await screen.findByText(/FB since 2019-05-20/)).toBeInTheDocument();
    await waitFor(() => {
      expect(savedAccount().facebookCreatedAt).toBe("2019-05-20");
    });
    // The cap reads the saved date at once — an old account is 45/day.
    expect(dailyChatLimit(savedAccount(), "2026-11-13T04:00:00.000Z")).toBe(45);
  });

  it("cancel leaves the date unchanged", async () => {
    const { container } = await renderAt("/accounts");
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit Facebook created date for Master" }),
    );
    const input = container.querySelector("#edit-fb-created-acc-1") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2019-05-20" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText(/FB since/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save date" })).not.toBeInTheDocument();
    expect(savedAccount().facebookCreatedAt).toBeNull();
  });

  it("prefills the existing date when one is already set", async () => {
    const seeded = seedState();
    const seededAccount = seeded.accounts[0];
    if (!seededAccount) throw new Error("no seed account");
    seededAccount.facebookCreatedAt = "2020-01-01";
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));
    const { container } = await renderAt("/accounts");
    expect(await screen.findByText(/FB since 2020-01-01/)).toBeInTheDocument();

    fireEvent.click(
      await screen.findByRole("button", { name: "Edit Facebook created date for Master" }),
    );
    const input = container.querySelector("#edit-fb-created-acc-1") as HTMLInputElement;
    expect(input.value).toBe("2020-01-01");
  });

  it("leaves the New account form untouched", async () => {
    const { container } = await renderAt("/accounts");
    // CardTitle is a div, not a heading.
    expect(await screen.findByText("New account")).toBeInTheDocument();
    const formInput = container.querySelector("#acc-fb-created") as HTMLInputElement;
    expect(formInput).not.toBeNull();
    expect(formInput.value).toBe("");
    expect(screen.getByRole("button", { name: /Create account/ })).toBeInTheDocument();
  });
});

describe("setFacebookCreatedAt (service)", () => {
  it("rejects a bad format and leaves the account unchanged", () => {
    const state = seedState();
    const account = state.accounts[0];
    if (!account) throw new Error("no seed account");
    const r = setFacebookCreatedAt(state, "acc-1", "20-05-2019");
    expect(r.ok).toBe(false);
    expect(account.facebookCreatedAt).toBeNull();
  });

  it("rejects an unknown account", () => {
    const r = setFacebookCreatedAt(seedState(), "acc-nope", "2019-05-20");
    expect(r.ok).toBe(false);
  });

  it("empty clears the date back to null", () => {
    const state = seedState();
    const account = state.accounts[0];
    if (!account) throw new Error("no seed account");
    account.facebookCreatedAt = "2020-01-01";
    const r = setFacebookCreatedAt(state, "acc-1", "");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const updated = r.value.accounts[0];
      if (!updated) throw new Error("no account");
      expect(updated.facebookCreatedAt).toBeNull();
    }
  });
});
