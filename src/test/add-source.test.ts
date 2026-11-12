import { describe, expect, it } from "vitest";

import {
  addLeads,
  addPosts,
  addSource,
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

/** State with the two manual sources added (group + page). */
function withSources(): AppState {
  let state = withAccount();
  const g = addSource(
    state,
    { id: "src-a", name: "Stocks To Watch", url: "https://facebook.com/groups/111", memberCount: 12000 },
    "acc-1",
    NOW,
  );
  if (!g.ok) throw new Error(`fixture group failed: ${g.error}`);
  state = g.value;
  const p = addSource(
    state,
    { id: "src-b", name: "Stock Page", url: "https://facebook.com/stockpage", memberCount: 0 },
    "acc-1",
    NOW,
  );
  if (!p.ok) throw new Error(`fixture page failed: ${p.error}`);
  return p.value;
}

describe("empty initial state", () => {
  it("starts with no accounts, sources, posts, leads or activity", () => {
    const s = createSeedState();
    expect(s.accounts).toEqual([]);
    expect(s.sources).toEqual([]);
    expect(s.posts).toEqual([]);
    expect(s.leads).toEqual([]);
    expect(s.activity).toEqual([]);
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

describe("addSource (manual)", () => {
  it("adds a group from a /groups/ link, joined by the account, status joined", () => {
    const r = addSource(
      withAccount(),
      { id: "src-a", name: "Stocks To Watch", url: "https://facebook.com/groups/111", memberCount: 12000 },
      "acc-1",
      NOW,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.value.sources.find((x) => x.id === "src-a")!;
    expect(s.type).toBe("group");
    expect(s.status).toBe("joined");
    expect(s.joinedByAccountId).toBe("acc-1");
    expect(s.memberCount).toBe(12000);
    expect(s.lastScrapedAt).toBeNull();
  });

  it("derives Page from a link without /groups/", () => {
    const r = addSource(
      withAccount(),
      { id: "src-b", name: "Stock Page", url: "https://facebook.com/stockpage", memberCount: 500 },
      "acc-1",
      NOW,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sources[0]?.type).toBe("page");
  });

  it("accepts a protocol-less link and still derives the type", () => {
    const r = addSource(
      withAccount(),
      { id: "src-a", name: "Stocks To Watch", url: "www.facebook.com/groups/111", memberCount: 12000 },
      "acc-1",
      NOW,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sources[0]?.type).toBe("group");
    expect(r.value.sources[0]?.url).toBe("https://www.facebook.com/groups/111");
  });

  it("rejects a URL already joined by any account, even with a different case/www prefix/trailing slash", () => {
    const state = withSources();
    const again = addSource(
      state,
      { id: "src-c", name: "Stocks To Watch", url: "https://www.facebook.com/groups/111/", memberCount: 12000 },
      "acc-1",
      NOW,
    );
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error).toContain("Already joined by Master");
    expect(state.sources).toHaveLength(2);
  });

  it("rejects the same URL from a second account, naming the first account", () => {
    let state = withSources();
    const acc2 = createAccount(state, { name: "Second", facebookName: "Second Person" }, "acc-2", NOW);
    if (!acc2.ok) throw new Error("fixture second account failed");
    state = acc2.value;
    const r = addSource(
      state,
      { id: "src-c", name: "Stocks To Watch", url: "https://facebook.com/groups/111", memberCount: 12000 },
      "acc-2",
      NOW,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("Already joined by Master");
  });

  it("rejects a non-Facebook link", () => {
    const r = addSource(
      withAccount(),
      { id: "src-a", name: "Not Facebook", url: "https://example.com/groups/111", memberCount: 10 },
      "acc-1",
      NOW,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("facebook.com");
  });

  it("rejects an empty name", () => {
    const r = addSource(
      withAccount(),
      { id: "src-a", name: "   ", url: "https://facebook.com/groups/111", memberCount: 10 },
      "acc-1",
      NOW,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("name");
  });

  it("rejects a negative or non-whole member count", () => {
    const neg = addSource(
      withAccount(),
      { id: "src-a", name: "X", url: "https://facebook.com/groups/111", memberCount: -1 },
      "acc-1",
      NOW,
    );
    expect(neg.ok).toBe(false);
    const frac = addSource(
      withAccount(),
      { id: "src-a", name: "X", url: "https://facebook.com/groups/111", memberCount: 1.5 },
      "acc-1",
      NOW,
    );
    expect(frac.ok).toBe(false);
    // 0 is fine — a member count the user does not know yet.
    const zero = addSource(
      withAccount(),
      { id: "src-a", name: "X", url: "https://facebook.com/groups/111", memberCount: 0 },
      "acc-1",
      NOW,
    );
    expect(zero.ok).toBe(true);
  });

  it("rejects an unknown account", () => {
    const r = addSource(
      withAccount(),
      { id: "src-a", name: "X", url: "https://facebook.com/groups/111", memberCount: 10 },
      "no-such-account",
      NOW,
    );
    expect(r.ok).toBe(false);
  });
});

describe("deleteSource", () => {
  it("removes the source, its posts and leads derived from them", () => {
    let state = withSources();
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
