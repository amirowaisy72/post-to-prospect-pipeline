import { describe, expect, it } from "vitest";

import { addSource, createAccount, markSourceScraped } from "@/lib/leadhunter-service";
import { createSeedState } from "@/lib/seed";
import type { AppState } from "@/lib/types";

const NOW = "2026-11-12T00:00:00.000Z";
const LATER = "2026-11-12T04:30:00.000Z";

/** One account + one joined source, built only through the service. */
const fixtureState = (): AppState => {
  let state = createSeedState();
  const acc = createAccount(state, { name: "Master", facebookName: "Amir Owaisy" }, "acc-1", NOW);
  if (!acc.ok) throw new Error("fixture account failed");
  state = acc.value;
  const added = addSource(
    state,
    {
      id: "src-1",
      name: "Stock Market Traders.",
      url: "https://facebook.com/groups/833569388896239",
      memberCount: 780000,
    },
    "acc-1",
    NOW,
  );
  if (!added.ok) throw new Error("fixture source failed");
  return added.value;
};

describe("markSourceScraped", () => {
  it("advances Last scraped for the source even with 0 new posts", () => {
    const state = fixtureState();
    expect(state.sources[0]?.lastScrapedAt).toBeNull();
    const next = markSourceScraped(state, "src-1", LATER).state;
    expect(next.sources[0]?.lastScrapedAt).toBe(LATER);
  });

  it("leaves other sources untouched and ignores an unknown id", () => {
    const state = fixtureState();
    const next = markSourceScraped(state, "no-such-source", LATER).state;
    expect(next.sources).toEqual(state.sources);
  });
});
