/**
 * LeadHunter store — the single data layer the UI talks to.
 * State is held in React and persisted to localStorage. All rules live in
 * ./leadhunter-service.ts; replace these actions with REST calls later.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import * as svc from "./leadhunter-service";
import { createDefaultSettings, createSeedState } from "./seed";
import type { AccountStatus, AgentTask, AppState, Lead, LeadStatus, Settings, SourceType } from "./types";

const STORAGE_KEY = "leadhunter:v1";

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
  addSource: (input: { name: string; type: SourceType; quantity: number }) => boolean;
  joinSource: (sourceId: string) => void;
  addPost: (draft: svc.PostDraft, sourceId: string) => boolean;
  runAnalysis: (postIds: string[]) => svc.AnalysisResult;
  saveLeads: (leads: Lead[], postCount: number) => void;
  setLeadStatus: (leadId: string, status: LeadStatus) => void;
  updateSettings: (settings: Settings) => boolean;
  resetDemoData: () => void;
  /** Give an account's agent a task; false (with a toast) when it is busy or offline. */
  startAgentTask: (accountId: string, task: Omit<AgentTask, "startedAt">) => boolean;
  /** Finish or stop the agent's current task. */
  finishAgentTask: (accountId: string, opts?: { stopped?: boolean }) => void;
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
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as AppState;
        if (saved?.accounts?.length)
          setState({ ...createSeedState(), ...saved, settings: svc.mergeSettings(createDefaultSettings(), saved.settings) });
      }
    } catch {
      /* corrupted storage — fall back to demo data */
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
      addSource: (input) =>
        apply(svc.addSource(stateRef.current, input, activeId, newId("src"), nowIso()), "Source added"),
      joinSource: (sourceId) => {
        const name = stateRef.current.sources.find((s) => s.id === sourceId)?.name;
        apply(svc.joinSource(stateRef.current, sourceId, activeId, nowIso()), `Joined ${name}`);
      },
      addPost: (draft, sourceId) =>
        apply(svc.addPost(stateRef.current, draft, sourceId, activeId, newId("post"), nowIso()), "Post data saved"),
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
      resetDemoData: () => {
        setState(createSeedState());
        toast.success("Demo data restored");
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
