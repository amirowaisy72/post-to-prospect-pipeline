import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_NOT_RUNNING_MESSAGE,
  AgentUnreachableError,
  deleteAgentSource,
  getAgentHealth,
  startAgentCollect,
  startAgentScrape,
} from "@/lib/agent-client";

const okJson = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

describe("agent client", () => {
  const mockFetch = vi.fn();
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads health from /health", async () => {
    mockFetch.mockResolvedValue(okJson({ ok: true, service: "leadhunter-agent", facebook: "unknown" }));
    const health = await getAgentHealth("http://127.0.0.1:8001");
    expect(health.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8001/health",
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it("throws AgentUnreachableError when the agent is down", async () => {
    mockFetch.mockRejectedValue(new TypeError("fetch failed"));
    await expect(getAgentHealth("http://127.0.0.1:8001")).rejects.toThrow(AgentUnreachableError);
    await expect(getAgentHealth("http://127.0.0.1:8001")).rejects.toThrow(AGENT_NOT_RUNNING_MESSAGE);
  });

  it("starts a scrape with the source details and returns the job id", async () => {
    mockFetch.mockResolvedValue(okJson({ jobId: "job-1" }, 202));
    const r = await startAgentScrape("http://127.0.0.1:8001/", {
      sourceId: "src-1",
      sourceUrl: "https://facebook.com/groups/psxinvestorspk",
      sourceName: "PSX Investors Pakistan",
      accountId: "acc-1",
    });
    expect(r.jobId).toBe("job-1");
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8001/scrape");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toMatchObject({ sourceId: "src-1", accountId: "acc-1" });
  });

  it("surfaces the agent's error detail on a failed start", async () => {
    mockFetch.mockResolvedValue(okJson({ detail: "Another job is already running" }, 409));
    await expect(
      startAgentScrape("http://127.0.0.1:8001", {
        sourceId: "src-1",
        sourceUrl: "https://facebook.com/groups/psxinvestorspk",
        accountId: "acc-1",
      }),
    ).rejects.toThrow("Another job is already running");
  });

  it("starts a collect with keyword, type, gates and maxNew", async () => {
    mockFetch.mockResolvedValue(okJson({ jobId: "job-collect" }, 202));
    const r = await startAgentCollect("http://127.0.0.1:8001", {
      keyword: "stocks",
      type: "group",
      maxNew: 10,
      accountId: "acc-1",
      minComments: 3,
      minMembers: 100,
    });
    expect(r.jobId).toBe("job-collect");
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8001/collect-sources");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toMatchObject({
      keyword: "stocks",
      type: "group",
      maxNew: 10,
      accountId: "acc-1",
      minComments: 3,
      minMembers: 100,
    });
  });

  it("deletes a source and reports the leave result", async () => {
    mockFetch.mockResolvedValue(
      okJson({ ok: true, left: true, detail: "Left the group and removed it from the list." }),
    );
    const r = await deleteAgentSource("http://127.0.0.1:8001", "src-1");
    expect(r.ok).toBe(true);
    expect(r.left).toBe(true);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8001/sources/src-1/delete");
    expect(init.method).toBe("POST");
  });

  it("a failed leave surfaces the agent's detail as an error", async () => {
    mockFetch.mockResolvedValue(
      okJson({ ok: false, left: false, detail: "Could not leave the group on Facebook — it is still in the list, try Delete again." }, 502),
    );
    await expect(deleteAgentSource("http://127.0.0.1:8001", "src-1")).rejects.toThrow(
      "Could not leave the group on Facebook",
    );
  });
});
