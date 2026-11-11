/**
 * LeadHunter store — the single data layer the UI talks to.
 * State is held in React and persisted to localStorage. All rules live in
 * ./leadhunter-service.ts; replace these actions with REST calls later.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import * as svc from "./leadhunter-service";
import {
  AGENT_NOT_RUNNING_MESSAGE,
  AgentUnreachableError,
  deleteAgentSource,
  getAgentJob,
  startAgentCollect,
  startAgentScrape,
  startAgentSync,
  stopAgentJob,
} from "./agent-client";
import { createDefaultSettings, createSeedState } from "./seed";
import type { AccountStatus, AgentTask, AppState, Lead, LeadStatus, Settings, SourceType } from "./types";

const STORAGE_KEY = "leadhunter:v2";
// v1 stored the demo data — purged on first load so the app starts empty.
const LEGACY_STORAGE_KEY = "leadhunter:v1";

const newId = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
const nowIso = () => new Date().toISOString();

interface StoreValue {
  state: AppState;
  hydrated: boolean;
  activeAccount: AppState["accounts"][number] | undefined;
  setActiveAccount: (id: string) => void;
  setDefaultAccount: (id: string) => void;
  createAccount: (input: { name: string; facebookName: string }) => boolean;
  setAccountStatus: (id: string, status: AccountStatus) => void;
  /** Search Facebook for groups/pages matching a keyword and collect the good ones (agent job). */
  collectSources: (input: { keyword: string; type: SourceType | "both"; maxNew: number }) => Promise<boolean>;
  /** Leave the group/page on Facebook, then remove it from everywhere. False (row kept) when the leave fails. */
  deleteSource: (sourceId: string) => Promise<boolean>;
  runAnalysis: (postIds: string[]) => svc.AnalysisResult;
  saveLeads: (leads: Lead[], postCount: number) => void;
  setLeadStatus: (leadId: string, status: LeadStatus) => void;
  updateSettings: (settings: Settings) => boolean;
  /** Give an account's agent a task; false (with a toast) when it is busy or offline. */
  startAgentTask: (accountId: string, task: Omit<AgentTask, "startedAt">) => boolean;
  /** Finish or stop the agent's current task. */
  finishAgentTask: (accountId: string, opts?: { stopped?: boolean }) => void;
  /** Start a Scrap job for one source (new posts only). False when the agent is unreachable or a job is already running. */
  startScrape: (sourceId: string) => Promise<boolean>;
  /** Start a Sync job for one source (re-visit its collected posts). */
  startSync: (sourceId: string) => Promise<boolean>;
  /** Start a Sync job for one post. */
  startPostSync: (postId: string) => Promise<boolean>;
  /** Graceful stop: the agent finishes the current post, saves it, then terminates. */
  stopJob: (jobId: string) => Promise<void>;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(() => createSeedState());
  const [hydrated, setHydrated] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Load saved data after hydration (browser storage is not available during SSR).
  useEffect(() => {
    try {
      // The old key held the demo data — drop it so the app starts empty.
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as AppState;
        if (saved && typeof saved === "object") {
          const seed = createSeedState();
          const arrays = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
          const accounts = arrays<AppState["accounts"][number]>(saved.accounts);
          const pick = (id: unknown) =>
            typeof id === "string" && accounts.some((a) => a.id === id) ? id : "";
          setState({
            ...seed,
            ...saved,
            accounts,
            sources: arrays(saved.sources),
            posts: arrays(saved.posts),
            leads: arrays(saved.leads),
            activity: arrays(saved.activity),
            jobs: arrays(saved.jobs),
            agents: arrays(saved.agents),
            // Never sit on an account id that no longer exists.
            activeAccountId: pick(saved.activeAccountId) || pick(saved.defaultAccountId) || accounts[0]?.id || "",
            defaultAccountId: pick(saved.defaultAccountId) || accounts[0]?.id || "",
            settings: svc.mergeSettings(createDefaultSettings(), saved.settings),
          });
        }
      }
    } catch {
      /* corrupted storage — fall back to the empty state */
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state, hydrated]);

  // Simulated agents: finish demo tasks once their expected time has passed.
  // The real agent API will push status updates instead.
  useEffect(() => {
    if (!hydrated) return;
    const t = window.setInterval(() => {
      const due = svc.dueAgentTasks(stateRef.current, Date.now());
      if (due.length === 0) return;
      setState((s) => svc.finishDueAgentTasks(s, Date.now()));
      for (const a of due) {
        if (a.task?.kind === "analysing") continue; // the analysis page reports its own result
        toast.success(`${svc.accountName(stateRef.current, a.accountId)}'s agent is free`, { description: `Done: ${a.task?.label}` });
      }
    }, 1000);
    return () => window.clearInterval(t);
  }, [hydrated]);

  // Scrap/Sync jobs: poll the local agent while a job is active, import
  // its results when it finishes, and surface count mismatches plainly.
  const jobPollFailures = useRef<Record<string, number>>({});
  const pollingRef = useRef(false);
  const pollJobs = useCallback(async () => {
    if (pollingRef.current) return;
    const s = stateRef.current;
    const jobs = s.jobs.filter((j) => j.status === "running" || j.status === "stop-requested");
    if (jobs.length === 0) return;
    pollingRef.current = true;
    try {
      for (const job of jobs) {
        let res: Awaited<ReturnType<typeof getAgentJob>>;
        try {
          res = await getAgentJob(s.settings.agentUrl, job.id);
          jobPollFailures.current[job.id] = 0;
        } catch {
          const fails = (jobPollFailures.current[job.id] ?? 0) + 1;
          jobPollFailures.current[job.id] = fails;
          if (fails >= 3) {
            setState((prev) =>
              svc.updateSourceJob(prev, job.id, {
                status: "failed",
                finishedAt: nowIso(),
                error: AGENT_NOT_RUNNING_MESSAGE,
              }).state,
            );
            toast.error(AGENT_NOT_RUNNING_MESSAGE);
          }
          continue;
        }
        const aj = res.job;
        if (aj.status === "done" || aj.status === "stopped" || aj.status === "failed" || aj.status === "incomplete") {
          if (job.kind === "collect") {
            // Collect finished: import the sources the agent joined,
            // then finish the local job.
            const collected = aj.result?.sources ?? [];
            setState((prev) => {
              let next = prev;
              if (aj.status !== "failed" && collected.length > 0) {
                next = svc.addCollectedSources(next, collected, job.accountId, nowIso()).state;
              }
              return svc.updateSourceJob(next, job.id, {
                status: aj.status,
                postsProcessed: aj.postsProcessed,
                newPosts: aj.newPosts,
                finishedAt: aj.finishedAt ?? nowIso(),
                error: aj.error ?? null,
                verification: aj.verification ?? [],
                result: aj.result ?? null,
              }).state;
            });
            if (aj.status === "failed") {
              toast.error(`Collect failed — ${aj.error ?? "unknown error"}`);
            } else if (collected.length > 0) {
              const names = collected.map((s) => s.name).slice(0, 3).join(", ");
              toast.success(
                `Collected ${collected.length} new source${collected.length === 1 ? "" : "s"} — ${names}${collected.length > 3 ? "…" : ""}`,
              );
            } else {
              toast.info(
                aj.message ??
                  "No new sources found — every candidate failed the comments/member gate or was already joined",
              );
            }
          } else {
          // Import the collected posts, then finish the local job.
          const parsed = svc.parsePostDataJson(JSON.stringify({ posts: res.posts }), stateRef.current, {
            allowExisting: job.kind === "sync",
          });
          setState((prev) => {
            let next = prev;
            if (job.kind === "scrape" && job.sourceId) {
              const r = svc.addPosts(next, parsed.drafts, job.sourceId, job.accountId, () => newId("post"), nowIso());
              next = r.state;
            } else {
              for (const draft of parsed.drafts) {
                const existing = next.posts.find((p) => svc.sameUrl(p.postUrl, draft.postUrl));
                if (existing) next = svc.mergePostActivity(next, existing.id, draft, nowIso()).state;
              }
            }
            if (aj.status === "done" || aj.status === "stopped" || aj.status === "incomplete") {
              const name = next.sources.find((x) => x.id === job.sourceId)?.name ?? "source";
              next = svc.logActivity(
                next,
                job.kind === "scrape" ? "source-scraped" : "source-synced",
                job.accountId,
                `${job.kind === "scrape" ? "Scraped" : "Synced"} ${name} — ${aj.newPosts} new post(s), ${aj.postsProcessed} processed`,
                `act-${job.id}`,
                nowIso(),
              );
            }
            return svc.updateSourceJob(next, job.id, {
              status: aj.status,
              postsProcessed: aj.postsProcessed,
              newPosts: aj.newPosts,
              finishedAt: aj.finishedAt ?? nowIso(),
              error: aj.error ?? null,
              verification: aj.verification ?? [],
            }).state;
          });
          const sourceName =
            stateRef.current.sources.find((x) => x.id === job.sourceId)?.name ?? "source";
          const missing = (aj.verification ?? []).filter((v) => !v.complete);
          if (aj.status === "failed") {
            toast.error(`Job failed — ${aj.error ?? "unknown error"}`);
          } else if (aj.status === "incomplete" || missing.length > 0) {
            const detail =
              aj.message ??
              missing
                .map(
                  (v) =>
                    `collected ${v.collectedComments} of ${v.expectedComments ?? "?"} — ${v.missing ?? "?"} missing`,
                )
                .join("; ");
            toast.warning(`Finished with gaps — ${detail}`, {
              description: `${job.kind === "scrape" ? "Scrape" : "Sync"} of ${sourceName}`,
            });
          } else if (aj.status === "stopped") {
            toast(`Stopped — ${aj.postsProcessed} post(s) processed, ${aj.newPosts} new`, {
              description: sourceName,
            });
          } else if (job.kind === "scrape") {
            toast.success(`Scrape finished — ${aj.newPosts} new post(s) from ${sourceName}`);
          } else {
            toast.success(`Sync finished — ${aj.postsProcessed} post(s) re-checked in ${sourceName}`);
          }
          }
        } else {
          setState((prev) =>
            svc.updateSourceJob(prev, job.id, {
              status: aj.status,
              postsProcessed: aj.postsProcessed,
              newPosts: aj.newPosts,
            }).state,
          );
        }
      }
    } finally {
      pollingRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const t = window.setInterval(() => void pollJobs(), 2000);
    return () => window.clearInterval(t);
  }, [hydrated, pollJobs]);

  const apply = useCallback((r: svc.Result<AppState>, success?: string) => {
    if (!r.ok) {
      toast.error(r.error);
      return false;
    }
    setState(r.value);
    if (success) toast.success(success);
    return true;
  }, []);

  const value = useMemo<StoreValue>(() => {
    const activeId = state.activeAccountId;
    return {
      state,
      hydrated,
      activeAccount: state.accounts.find((a) => a.id === activeId),
      setActiveAccount: (id) => setState((s) => ({ ...s, activeAccountId: id })),
      setDefaultAccount: (id) => setState((s) => ({ ...s, defaultAccountId: id })),
      createAccount: (input) =>
        apply(svc.createAccount(stateRef.current, input, newId("acc"), nowIso()), `Account “${input.name.trim()}” created`),
      setAccountStatus: (id, status) => setState((s) => svc.setAccountStatus(s, id, status)),
      collectSources: async (input) => {
        const s = stateRef.current;
        const accountId = s.activeAccountId;
        if (!accountId) {
          toast.error("Create an account first — sources belong to an account");
          return false;
        }
        const keyword = input.keyword.trim();
        if (!keyword) {
          toast.error("Enter a search keyword");
          return false;
        }
        if (s.jobs.some((j) => j.status === "running" || j.status === "stop-requested")) {
          toast.info("A job is already running — wait for it to finish");
          return false;
        }
        let jobId: string;
        try {
          ({ jobId } = await startAgentCollect(s.settings.agentUrl, {
            keyword,
            type: input.type,
            maxNew: input.maxNew,
            accountId,
            minComments: s.settings.sourcing.minComments,
            minMembers: s.settings.sourcing.minMembers,
          }));
        } catch (e) {
          toast.error(e instanceof AgentUnreachableError ? AGENT_NOT_RUNNING_MESSAGE : (e as Error).message);
          return false;
        }
        setState((prev) =>
          svc.startSourceJob(prev, { id: jobId, kind: "collect", sourceId: null, postId: null, accountId, startedAt: nowIso() }).state,
        );
        toast(`Searching Facebook for “${keyword}” — joining groups that pass the comments and member gates`);
        void pollJobs();
        return true;
      },
      deleteSource: async (sourceId) => {
        const s = stateRef.current;
        const source = s.sources.find((x) => x.id === sourceId);
        if (!source) return false;
        try {
          await deleteAgentSource(s.settings.agentUrl, sourceId);
        } catch (e) {
          // The agent throws when the leave fails — the row stays so
          // Delete can be retried.
          toast.error(e instanceof AgentUnreachableError ? AGENT_NOT_RUNNING_MESSAGE : (e as Error).message);
          return false;
        }
        setState((prev) => {
          const r = svc.deleteSource(prev, sourceId, nowIso());
          return r.ok ? r.value : prev;
        });
        toast.success(`Left ${source.name} and removed it from the list`);
        return true;
      },
      runAnalysis: (postIds) => svc.analysePosts(stateRef.current, postIds, activeId, () => newId("lead")),
      saveLeads: (leads, postCount) =>
        setState((s) => svc.addLeads(s, leads, activeId, postCount, nowIso()).state),
      setLeadStatus: (leadId, status) => setState((s) => svc.setLeadStatus(s, leadId, status, nowIso())),
      updateSettings: (settings) => {
        const r = svc.validateSettings(settings);
        if (!r.ok) {
          toast.error(r.error);
          return false;
        }
        setState((s) => ({ ...s, settings: r.value }));
        toast.success("Configurations saved on this device");
        return true;
      },
      startAgentTask: (accountId, task) => apply(svc.startAgentTask(stateRef.current, accountId, task, nowIso())),
      finishAgentTask: (accountId, opts) => {
        const label = svc.agentFor(stateRef.current, accountId).task?.label;
        setState((s) => svc.finishAgentTask(s, accountId, nowIso()));
        if (opts?.stopped && label) toast(`Stopped: ${label}`);
      },
      startScrape: async (sourceId) => {
        const s = stateRef.current;
        const source = s.sources.find((x) => x.id === sourceId);
        if (!source) return false;
        if (svc.runningJobForSource(s, sourceId)) {
          toast.info("A job is already running for this source");
          return false;
        }
        const accountId = source.joinedByAccountId ?? s.activeAccountId;
        let jobId: string;
        try {
          ({ jobId } = await startAgentScrape(s.settings.agentUrl, {
            sourceId,
            sourceUrl: source.url,
            sourceName: source.name,
            accountId,
          }));
        } catch (e) {
          toast.error(e instanceof AgentUnreachableError ? AGENT_NOT_RUNNING_MESSAGE : (e as Error).message);
          return false;
        }
        setState((prev) =>
          svc.startSourceJob(prev, { id: jobId, kind: "scrape", sourceId, postId: null, accountId, startedAt: nowIso() }).state,
        );
        toast(`Scraping ${source.name} — new posts only`);
        void pollJobs();
        return true;
      },
      startSync: async (sourceId) => {
        const s = stateRef.current;
        const source = s.sources.find((x) => x.id === sourceId);
        if (!source) return false;
        if (svc.runningJobForSource(s, sourceId)) {
          toast.info("A job is already running for this source");
          return false;
        }
        if (svc.scrapedCount(s, sourceId) === 0) {
          toast.info("No collected posts to sync yet");
          return false;
        }
        const accountId = source.joinedByAccountId ?? s.activeAccountId;
        let jobId: string;
        try {
          ({ jobId } = await startAgentSync(s.settings.agentUrl, {
            sourceId,
            sourceUrl: source.url,
            accountId,
          }));
        } catch (e) {
          toast.error(e instanceof AgentUnreachableError ? AGENT_NOT_RUNNING_MESSAGE : (e as Error).message);
          return false;
        }
        setState((prev) =>
          svc.startSourceJob(prev, { id: jobId, kind: "sync", sourceId, postId: null, accountId, startedAt: nowIso() }).state,
        );
        toast(`Syncing ${source.name} — re-visiting collected posts`);
        void pollJobs();
        return true;
      },
      startPostSync: async (postId) => {
        const s = stateRef.current;
        const post = s.posts.find((p) => p.id === postId);
        if (!post) return false;
        if (svc.runningJobForPost(s, postId)) {
          toast.info("A job is already running for this post");
          return false;
        }
        let jobId: string;
        try {
          ({ jobId } = await startAgentSync(s.settings.agentUrl, {
            postId,
            postUrl: post.postUrl,
            accountId: post.accountId,
          }));
        } catch (e) {
          toast.error(e instanceof AgentUnreachableError ? AGENT_NOT_RUNNING_MESSAGE : (e as Error).message);
          return false;
        }
        setState((prev) =>
          svc.startSourceJob(prev, {
            id: jobId,
            kind: "sync",
            sourceId: post.sourceId,
            postId,
            accountId: post.accountId,
            startedAt: nowIso(),
          }).state,
        );
        toast("Syncing this post — re-visiting it for new activity");
        void pollJobs();
        return true;
      },
      stopJob: async (jobId) => {
        const s = stateRef.current;
        try {
          await stopAgentJob(s.settings.agentUrl, jobId);
          setState((prev) => svc.requestSourceJobStop(prev, jobId).state);
          toast("Stopping after the current post finishes…");
        } catch (e) {
          toast.error(e instanceof AgentUnreachableError ? AGENT_NOT_RUNNING_MESSAGE : (e as Error).message);
        }
      },
    };
  }, [state, hydrated, apply]);

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used inside StoreProvider");
  return ctx;
}

/** Data scoped to the account picked in the header. */
export function useActiveAccountData() {
  const { state } = useStore();
  const id = state.activeAccountId;
  return useMemo(
    () => ({
      accountId: id,
      posts: state.posts.filter((p) => p.accountId === id),
      leads: state.leads.filter((l) => l.accountId === id),
      joinedSources: state.sources.filter((s) => s.joinedByAccountId === id),
    }),
    [state, id],
  );
}
