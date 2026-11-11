import { describe, expect, it } from "vitest";

import {
  addCollectedSources,
  agentCurrentTask,
  agentStatus,
  createAccount,
  finishAgentTask,
  finishDueAgentTasks,
  requestSourceJobStop,
  setAccountStatus,
  startAgentTask,
  startSourceJob,
  updateSourceJob,
} from "@/lib/leadhunter-service";
import { createSeedState } from "@/lib/seed";
import type { AppState } from "@/lib/types";

const NOW = "2026-11-11T10:00:00.000Z";
const task = { kind: "scraping" as const, label: "Scraping posts", expectedMs: 60_000 };

/** Two accounts: acc-1 active, acc-2 paused. No demo data — built
 * through the service. */
const freeState = (): AppState => {
  let state = createSeedState();
  const a1 = createAccount(state, { name: "Ayesha — Main", facebookName: "Ayesha Khan" }, "acc-1", NOW);
  if (!a1.ok) throw new Error("fixture account 1 failed");
  state = a1.value;
  const a2 = createAccount(state, { name: "Bilal — Research", facebookName: "Bilal Ahmed" }, "acc-2", NOW);
  if (!a2.ok) throw new Error("fixture account 2 failed");
  state = setAccountStatus(a2.value, "acc-2", "paused");
  return { ...state, agents: [] };
};

describe("account agents", () => {
  it("an active account with no task is free", () => {
    expect(agentStatus(freeState(), "acc-1")).toBe("free");
  });

  it("starting a task makes only that account's agent busy", () => {
    const r = startAgentTask(freeState(), "acc-1", task, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(agentStatus(r.value, "acc-1")).toBe("busy");
    // acc-2 is paused — its own status is unaffected by acc-1.
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

  it("an unknown account's agent is offline", () => {
    expect(agentStatus(freeState(), "acc-9")).toBe("offline");
    expect(agentStatus(createSeedState(), "")).toBe("offline");
  });
});

describe("running backend jobs", () => {
  /** State with one running job for acc-1 (optionally on a source). */
  const jobState = (kind: "collect" | "scrape" | "sync", sourceId: string | null = null): AppState => {
    const r = startSourceJob(freeState(), {
      id: "job-1",
      kind,
      sourceId,
      postId: null,
      accountId: "acc-1",
      startedAt: NOW,
    });
    return r.state;
  };

  /** State with a joined source "Stocks To Watch" (id src-1). */
  const withSource = (state: AppState): AppState =>
    addCollectedSources(
      state,
      [{
        id: "src-1",
        name: "Stocks To Watch",
        type: "group",
        url: "https://www.facebook.com/groups/1",
        memberCount: 12000,
        joinedByAccountId: "acc-1",
      }],
      "acc-1",
      NOW,
    ).state;

  it("a running collect job makes only that account's agent busy", () => {
    const s = jobState("collect");
    expect(agentStatus(s, "acc-1")).toBe("busy");
    expect(agentCurrentTask(s, "acc-1")?.label).toBe("Collecting sources…");
    // A second active account stays free.
    const a3 = createAccount(s, { name: "Carol — Extra", facebookName: "Carol Lee" }, "acc-3", NOW);
    if (!a3.ok) throw new Error("fixture account 3 failed");
    expect(agentStatus(a3.value, "acc-3")).toBe("free");
    expect(agentCurrentTask(a3.value, "acc-3")).toBeNull();
  });

  it("a running scrape job shows the source name", () => {
    const s = jobState("scrape", "src-1");
    expect(agentStatus(withSource(s), "acc-1")).toBe("busy");
    expect(agentCurrentTask(withSource(s), "acc-1")?.label).toBe("Scraping Stocks To Watch…");
  });

  it("a stop-requested job still counts as busy", () => {
    const s = requestSourceJobStop(jobState("sync", "src-1"), "job-1").state;
    expect(agentStatus(s, "acc-1")).toBe("busy");
  });

  it("a finished job frees the agent again", () => {
    const running = jobState("collect");
    expect(agentStatus(running, "acc-1")).toBe("busy");
    const done = updateSourceJob(running, "job-1", { status: "done", finishedAt: NOW }).state;
    expect(agentStatus(done, "acc-1")).toBe("free");
    expect(agentCurrentTask(done, "acc-1")).toBeNull();
    const failed = updateSourceJob(running, "job-1", { status: "failed", finishedAt: NOW }).state;
    expect(agentStatus(failed, "acc-1")).toBe("free");
  });

  it("a paused account is offline even with a running job", () => {
    const s = setAccountStatus(jobState("collect"), "acc-1", "paused");
    expect(agentStatus(s, "acc-1")).toBe("offline");
  });

  it("an analysis task cannot start while a job runs, and wins the label", () => {
    const s = jobState("collect");
    expect(startAgentTask(s, "acc-1", task, NOW).ok).toBe(false);
    const withTask = startAgentTask(freeState(), "acc-1", task, NOW);
    if (!withTask.ok) throw new Error("setup failed");
    const both = startSourceJob(withTask.value, {
      id: "job-1",
      kind: "scrape",
      sourceId: null,
      postId: null,
      accountId: "acc-1",
      startedAt: NOW,
    }).state;
    expect(agentStatus(both, "acc-1")).toBe("busy");
    expect(agentCurrentTask(both, "acc-1")?.label).toBe("Scraping posts");
  });
});
