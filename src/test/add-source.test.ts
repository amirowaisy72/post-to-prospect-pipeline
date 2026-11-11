import { describe, expect, it } from "vitest";

import { addSource } from "@/lib/leadhunter-service";
import { createSeedState } from "@/lib/seed";

describe("addSource by number", () => {
  it("saves the number and lists the source as joined by the adding account", () => {
    const r = addSource(createSeedState(), { name: "Karachi Traders", type: "group", quantity: 12 }, "acc-1", "src-x", "2026-11-11T00:00:00.000Z");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.value.sources.find((x) => x.id === "src-x")!;
    expect(s.quantity).toBe(12);
    expect(s.url).toBe("");
    expect(s.joinedByAccountId).toBe("acc-1");
    expect(s.status).toBe("joined");
  });

  it("rejects a number below 1 or not whole", () => {
    const state = createSeedState();
    expect(addSource(state, { name: "A", type: "page", quantity: 0 }, "acc-1", "a", "t").ok).toBe(false);
    expect(addSource(state, { name: "A", type: "page", quantity: 2.5 }, "acc-1", "a", "t").ok).toBe(false);
  });
});
