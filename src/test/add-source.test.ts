import { describe, expect, it } from "vitest";

import {
  addCollectedSources,
  addLeads,
  addPosts,
  createAccount,
  deleteSource,
  parsePostDataJson,
} from "@/lib/leadhunter-service";
import { createSeedState } from "@/lib/seed";
import type { AppState } from "@/lib/types";

const NOW = "2026-11-12T00:00:00.000Z";

/** Empty state + one account (acc-1, "Master"). */
function withAccount(): AppState {
  const r = createAccount(createSeedState(), { name: "Master", facebookName: "Amir Owaisy" }, "acc-1", NOW);
  if (!r.ok) throw new Error("fixture account failed");
  return r.value;
}

const COLLECTED = [
  {
    id: "src-a",
    name: "Stocks To Watch",
    type: "group" as const,
    url: "https://facebook.com/groups/111",
    memberCount: 12000,
    joinedByAccountId: "acc-1",
  },
  {
    id: "src-b",
    name: "Stock Page",
    type: "page" as const,
    url: "https://facebook.com/stockpage",
    memberCount: null,
    joinedByAccountId: "acc-1",
  },
];

describe("empty initial state", () => {
  it("starts with no accounts, sources, posts, leads or activity", () => {
    const s = createSeedState();
    expect(s.accounts).toEqual([]);
    expect(s.sources).toEqual([]);
    expect(s.posts).toEqual([]);
    expect(s.leads).toEqual([]);
    expect(s.activity).toEqual([]);
    expect(s.jobs).toEqual([]);
    expect(s.activeAccountId).toBe("");
    expect(s.defaultAccountId).toBe("");
  });

  it("the first account becomes the active and default account", () => {
    const r = createAccount(createSeedState(), { name: "Master", facebookName: "Amir Owaisy" }, "acc-1", NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.activeAccountId).toBe("acc-1");
    expect(r.value.defaultAccountId).toBe("acc-1");
    // A second account does not steal the active/default slot.
    const r2 = createAccount(r.value, { name: "Second", facebookName: "Second Person" }, "acc-2", NOW);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.activeAccountId).toBe("acc-1");
    expect(r2.value.defaultAccountId).toBe("acc-1");
  });
});

describe("addCollectedSources", () => {
  it("adds joined sources; an unknown member count becomes 0, never a block", () => {
    const r = addCollectedSources(withAccount(), COLLECTED, "acc-1", NOW);
    expect(r.added).toBe(2);
    expect(r.skipped).toBe(0);
    expect(r.state.sources).toHaveLength(2);
    const group = r.state.sources.find((s) => s.id === "src-a")!;
    expect(group.status).toBe("joined");
    expect(group.joinedByAccountId).toBe("acc-1");
    expect(group.memberCount).toBe(12000);
    // Unknown count is stored as 0 — the run was not blocked by it.
    expect(r.state.sources.find((s) => s.id === "src-b")!.memberCount).toBe(0);
  });

  it("skips a URL already joined by any account, even with a different case/www prefix", () => {
    const first = addCollectedSources(withAccount(), COLLECTED, "acc-1", NOW);
    const again = addCollectedSources(first.state, [
      {
        id: "src-c",
        name: "Stocks To Watch",
        type: "group" as const,
        url: "https://www.facebook.com/groups/111/",
        memberCount: 12000,
        joinedByAccountId: "acc-2",
      },
    ], "acc-2", NOW);
    expect(again.added).toBe(0);
    expect(again.skipped).toBe(1);
    expect(again.state.sources).toHaveLength(2);
  });

  it("skips duplicates inside one batch", () => {
    const r = addCollectedSources(withAccount(), [COLLECTED[0]!, COLLECTED[0]!], "acc-1", NOW);
    expect(r.added).toBe(1);
    expect(r.skipped).toBe(1);
  });
});

describe("deleteSource", () => {
  it("removes the source, its posts and leads derived from them", () => {
    let state = withAccount();
    state = addCollectedSources(state, COLLECTED, "acc-1", NOW).state;
    const parsed = parsePostDataJson(
      JSON.stringify({
        postUrl: "https://facebook.com/groups/111/posts/1",
        author: { name: "Poster", url: "https://facebook.com/poster" },
        text: "Hello",
        comments: [],
      }),
      state,
    );
    state = addPosts(state, parsed.drafts, "src-a", "acc-1", () => "post-1", NOW).state;
    expect(state.posts).toHaveLength(1);
    state = addLeads(
      state,
      [
        {
          id: "lead-1",
          name: "Someone",
          profileUrl: "https://facebook.com/someone",
          priority: "other",
          reason: "r",
          quotedComment: "q",
          sourcePostId: "post-1",
          accountId: "acc-1",
          status: "new",
        },
      ],
      "acc-1",
      1,
      NOW,
    ).state;
    expect(state.leads).toHaveLength(1);

    const r = deleteSource(state, "src-a", NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sources.find((s) => s.id === "src-a")).toBeUndefined();
    expect(r.value.sources).toHaveLength(1); // the page stays
    expect(r.value.posts).toEqual([]);
    expect(r.value.leads).toEqual([]);
  });

  it("returns an error for an unknown source", () => {
    expect(deleteSource(createSeedState(), "nope", NOW).ok).toBe(false);
  });
});
