import { describe, expect, it } from "vitest";

import {
  agentStatus,
  finishAgentTask,
  finishDueAgentTasks,
  setAccountStatus,
  startAgentTask,
} from "@/lib/leadhunter-service";
import { createSeedState } from "@/lib/seed";
import type { AppState } from "@/lib/types";

const NOW = "2026-11-11T10:00:00.000Z";
const freeState = (): AppState => ({ ...createSeedState(), agents: [] });
const task = { kind: "scraping" as const, label: "Scraping posts", expectedMs: 60_000 };

describe("account agents", () => {
  it("an active account with no task is free", () => {
    expect(agentStatus(freeState(), "acc-1")).toBe("free");
  });

  it("starting a task makes only that account's agent busy", () => {
    const r = startAgentTask(freeState(), "acc-1", task, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(agentStatus(r.value, "acc-1")).toBe("busy");
    // acc-2 is paused in the demo data — its own status is unaffected by acc-1.
    expect(agentStatus(r.value, "acc-2")).toBe("offline");
  });

  it("a busy agent cannot take a second task", () => {
    const r = startAgentTask(freeState(), "acc-1", task, NOW);
    if (!r.ok) throw new Error("setup failed");
    const second = startAgentTask(r.value, "acc-1", { ...task, label: "Analysing 2 posts" }, NOW);
    expect(second.ok).toBe(false);
  });

  it("a paused account's agent is offline and takes no tasks", () => {
    const s = freeState();
    expect(agentStatus(s, "acc-2")).toBe("offline");
    expect(startAgentTask(s, "acc-2", task, NOW).ok).toBe(false);
  });

  it("pausing an account stops its agent's task", () => {
    const r = startAgentTask(freeState(), "acc-1", task, NOW);
    if (!r.ok) throw new Error("setup failed");
    const paused = setAccountStatus(r.value, "acc-1", "paused");
    const reactivated = setAccountStatus(paused, "acc-1", "active");
    expect(agentStatus(reactivated, "acc-1")).toBe("free");
  });

  it("finishing a task frees the agent and remembers it", () => {
    const r = startAgentTask(freeState(), "acc-1", task, NOW);
    if (!r.ok) throw new Error("setup failed");
    const done = finishAgentTask(r.value, "acc-1", NOW);
    expect(agentStatus(done, "acc-1")).toBe("free");
    expect(done.agents.find((a) => a.accountId === "acc-1")?.lastTaskLabel).toBe("Scraping posts");
  });

  it("simulated tasks finish only after their expected time", () => {
    const r = startAgentTask(freeState(), "acc-1", task, NOW);
    if (!r.ok) throw new Error("setup failed");
    const start = Date.parse(NOW);
    expect(agentStatus(finishDueAgentTasks(r.value, start + 59_000), "acc-1")).toBe("busy");
    expect(agentStatus(finishDueAgentTasks(r.value, start + 60_000), "acc-1")).toBe("free");
  });
});
