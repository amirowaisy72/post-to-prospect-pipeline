/**
 * LeadHunter store — the single data layer the UI talks to.
 * State is held in React and persisted to localStorage. All rules live in
 * ./leadhunter-service.ts; replace these actions with REST calls later.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import { chatHealth, chatStart, chatStop, chatThreads, chatWatch } from "./chat-client";
import * as svc from "./leadhunter-service";
import { createDefaultSettings, createSeedState } from "./seed";
import type {
  AccountStatus,
  AppState,
  ChatScript,
  ChatThread,
  ChatThreadStatus,
  InboxSourceType,
  Lead,
  LeadStatus,
  Settings,
} from "./types";

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
  createAccount: (input: {
    name: string;
    facebookName: string;
    facebookCreatedAt?: string | null;
  }) => boolean;
  setAccountStatus: (id: string, status: AccountStatus) => void;
  /** Add one source by hand (name, Facebook link, member count). Type is derived from the link. */
  addSource: (input: { name: string; url: string; memberCount: number }) => boolean;
  /** Remove a source from LeadHunter only (its posts and derived leads go too). It stays joined on Facebook. */
  deleteSource: (sourceId: string) => boolean;
  runAnalysis: (postIds: string[]) => svc.AnalysisResult;
  saveLeads: (leads: Lead[], postCount: number) => void;
  setLeadStatus: (leadId: string, status: LeadStatus) => void;
  updateSettings: (settings: Settings) => boolean;
  /** Start a chat thread; the agent's first message is composed from the script. */
  createChatThread: (input: {
    profileUrl: string;
    profileName: string;
    sourceType: InboxSourceType;
    sourceText: string;
    sourceUrl: string;
    shortlistNote: string;
  }) => { thread: ChatThread; firstMessageId: string } | null;
  /** Append a message to a thread (agent draft or a pasted candidate reply). */
  addChatMessage: (threadId: string, role: "agent" | "candidate", text: string) => boolean;
  setThreadStatus: (threadId: string, status: ChatThreadStatus) => void;
  updateChatScript: (script: ChatScript) => boolean;
  /** Hand a new thread's first message to the chat agent for live
   * Messenger delivery. Marks it "pending-messenger" while the agent
   * sends it; the poll reports "sent" or "failed" against the same id. */
  startChatDelivery: (thread: ChatThread, firstMessageId: string) => Promise<boolean>;
  /** Poll the agent for live thread states and merge them in.
   * Returns whether the agent is reachable and watching. */
  refreshChatLive: () => Promise<{ online: boolean; watching: boolean }>;
  /** (Re)send the approved-thread watch list + script + key to the
   * agent, so it watches Messenger for replies. No-op when there is
   * nothing active to watch. */
  sendChatWatch: () => Promise<boolean>;
  /** Stop ALL chatting immediately (agent watcher + in-flight sends). */
  stopAllChatting: () => Promise<boolean>;
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
            threads: arrays(saved.threads),
            chatMessages: arrays(saved.chatMessages),
            chatScript: svc.mergeChatScript(saved.chatScript),
            // Never sit on an account id that no longer exists.
            activeAccountId:
              pick(saved.activeAccountId) || pick(saved.defaultAccountId) || accounts[0]?.id || "",
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
        apply(
          svc.createAccount(stateRef.current, input, newId("acc"), nowIso()),
          `Account “${input.name.trim()}” created`,
        ),
      setAccountStatus: (id, status) => setState((s) => svc.setAccountStatus(s, id, status)),
      addSource: (input) => {
        const s = stateRef.current;
        const accountId = s.activeAccountId;
        if (!accountId) {
          toast.error("Create an account first — sources belong to an account");
          return false;
        }
        const r = svc.addSource(s, { ...input, id: newId("src") }, accountId, nowIso());
        if (!r.ok) {
          toast.error(r.error);
          return false;
        }
        setState(r.value);
        toast.success(`Source “${input.name.trim()}” added`);
        return true;
      },
      deleteSource: (sourceId) => {
        const s = stateRef.current;
        const source = s.sources.find((x) => x.id === sourceId);
        if (!source) return false;
        const r = svc.deleteSource(s, sourceId, nowIso());
        if (!r.ok) {
          toast.error(r.error);
          return false;
        }
        setState(r.value);
        toast.success(`Removed ${source.name} from LeadHunter`);
        return true;
      },
      runAnalysis: (postIds) =>
        svc.analysePosts(stateRef.current, postIds, activeId, () => newId("lead")),
      saveLeads: (leads, postCount) =>
        setState((s) => svc.addLeads(s, leads, activeId, postCount, nowIso()).state),
      setLeadStatus: (leadId, status) =>
        setState((s) => svc.setLeadStatus(s, leadId, status, nowIso())),
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
      createChatThread: (input) => {
        const s = stateRef.current;
        const accountId = s.activeAccountId;
        if (!accountId) {
          toast.error("Create an account first — chats belong to an account");
          return null;
        }
        const firstMessageId = newId("msg");
        const r = svc.createChatThread(
          s,
          { ...input, id: newId("thread") },
          accountId,
          firstMessageId,
          nowIso(),
        );
        if (!r.ok) {
          toast.error(r.error);
          return null;
        }
        setState(r.value.state);
        toast.success(`Chat started with ${r.value.thread.profileName}`);
        return { thread: r.value.thread, firstMessageId };
      },
      addChatMessage: (threadId, role, text) => {
        const r = svc.addChatMessage(stateRef.current, {
          threadId,
          role,
          text,
          id: newId("msg"),
          now: nowIso(),
        });
        if (!r.ok) {
          toast.error(r.error);
          return false;
        }
        setState(r.value);
        return true;
      },
      setThreadStatus: (threadId, status) =>
        setState((s) => svc.setThreadStatus(s, threadId, status)),
      updateChatScript: (script) => {
        const r = svc.updateChatScript(stateRef.current, script);
        if (!r.ok) {
          toast.error(r.error);
          return false;
        }
        setState(r.value);
        toast.success("Chat script saved on this device");
        return true;
      },
      startChatDelivery: async (thread, firstMessageId) => {
        const s = stateRef.current;
        const account = s.accounts.find((a) => a.id === thread.accountId);
        if (!account) return false;
        const firstMessage = svc
          .messagesForThread(s, thread.id)
          .find((m) => m.id === firstMessageId);
        if (!firstMessage) return false;
        const r = await chatStart(s.settings.agentUrl, {
          accountId: thread.accountId,
          threadId: thread.id,
          messageId: firstMessageId,
          profileUrl: thread.profileUrl,
          profileName: thread.profileName,
          sourceType: thread.sourceType,
          sourceText: thread.sourceText,
          firstMessage: firstMessage.text,
          dailyCap: svc.dailyChatLimit(account, nowIso()),
        });
        if (!r.ok) {
          toast.error(`Messenger send failed: ${r.error}`);
          return false;
        }
        const marked = svc.markMessageDelivery(
          stateRef.current,
          firstMessageId,
          "pending-messenger",
        );
        if (marked.ok) setState(marked.value);
        return true;
      },
      refreshChatLive: async () => {
        const s = stateRef.current;
        const health = await chatHealth(s.settings.agentUrl);
        if (!health.ok) return { online: false, watching: false };
        const threads = await chatThreads(s.settings.agentUrl);
        if (threads.ok) {
          setState((prev) => svc.mergeLiveThreads(prev, threads.value.threads));
        }
        return { online: true, watching: threads.ok ? threads.value.watching : health.value.watching };
      },
      sendChatWatch: async () => {
        const s = stateRef.current;
        const accountId = s.activeAccountId;
        const account = s.accounts.find((a) => a.id === accountId);
        if (!accountId || !account) return false;
        const active = svc
          .threadsForAccount(s, accountId)
          .filter((t) => t.status === "active");
        if (active.length === 0) return true; // nothing to watch
        if (!s.settings.geminiApiKey.trim()) {
          toast.error("Add your Gemini API key in Configurations first — the agent cannot draft replies without it.");
          return false;
        }
        const r = await chatWatch(s.settings.agentUrl, {
          accountId,
          threads: active.map((t) => ({
            threadId: t.id,
            profileUrl: t.profileUrl,
            profileName: t.profileName,
            sourceType: t.sourceType,
            sourceText: t.sourceText,
          })),
          script: s.chatScript,
          geminiKey: s.settings.geminiApiKey.trim(),
          model: s.settings.model,
          dailyCap: svc.dailyChatLimit(account, nowIso()),
        });
        if (!r.ok) {
          toast.error(`Chat watcher failed: ${r.error}`);
          return false;
        }
        return true;
      },
      stopAllChatting: async () => {
        const r = await chatStop(stateRef.current.settings.agentUrl);
        if (!r.ok) {
          toast.error(`Stop failed: ${r.error}`);
          return false;
        }
        toast.success("All chatting stopped");
        return true;
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
      threads: state.threads.filter((t) => t.accountId === id),
    }),
    [state, id],
  );
}
