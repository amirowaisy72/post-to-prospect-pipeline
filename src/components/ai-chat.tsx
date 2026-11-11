import { Check, Copy, MessageSquarePlus, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import hunterMark from "@/assets/hunter-ai-mark.png";
import { PRIORITY_LABEL } from "@/components/badges";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageAction, MessageActions, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { accountName } from "@/lib/leadhunter-service";
import { CHAT_SUGGESTIONS, DEFAULT_MODELS, demoConversation, mockReply, providerLabel, type ChatMessage } from "@/lib/mock-chat";
import { useActiveAccountData, useStore } from "@/lib/store";
import type { AiProvider } from "@/lib/types";

type Status = "ready" | "submitted" | "streaming";

const THINK_MS = 700;
const TICK_MS = 28;

function HunterAvatar({ size = 28 }: { size?: number }) {
  return <img src={hunterMark} alt="" width={size} height={size} className="shrink-0 rounded-md" style={{ width: size, height: size }} />;
}

function CopyAction({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <MessageAction
      tooltip={done ? "Copied" : "Copy"}
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setDone(true);
        window.setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </MessageAction>
  );
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function AiChat() {
  const { state } = useStore();
  const { accountId, posts, leads } = useActiveAccountData();
  const settings = state.settings;

  const [provider, setProvider] = useState<AiProvider>(settings.provider);
  const model = provider === settings.provider ? settings.model : DEFAULT_MODELS[provider];
  const modelLabel = `${providerLabel(provider)} · ${model}`;

  const [messages, setMessages] = useState<ChatMessage[]>(() => demoConversation(`${providerLabel(settings.provider)} · ${settings.model}`));
  const [status, setStatus] = useState<Status>("ready");
  const timers = useRef<number[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const clearTimers = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };
  useEffect(() => clearTimers, []);
  useEffect(() => setProvider(settings.provider), [settings.provider]);

  const ctx = useMemo(
    () => ({
      accountName: accountName(state, accountId),
      postCount: posts.length,
      newLeads: leads.filter((l) => l.status === "new").length,
      shortlisted: leads.filter((l) => l.status === "shortlisted").length,
      topLeads: [...leads]
        .filter((l) => l.status !== "rejected")
        .sort((a, b) => Number(b.priority !== "other") - Number(a.priority !== "other"))
        .map((l) => ({ name: l.name, priority: PRIORITY_LABEL[l.priority], reason: l.reason })),
      defaultLeadsCount: settings.leadRules.defaultLeadsCount,
    }),
    [state, accountId, posts, leads, settings.leadRules.defaultLeadsCount],
  );

  const stop = useCallback(() => {
    clearTimers();
    setStatus("ready");
    textareaRef.current?.focus();
  }, []);

  const send = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text || status !== "ready") return;
      const now = new Date().toISOString();
      setMessages((m) => [...m, { id: crypto.randomUUID(), role: "user", text, at: now }]);
      setStatus("submitted");

      const full = mockReply(text, ctx);
      const id = crypto.randomUUID();
      const label = modelLabel;
      timers.current.push(
        window.setTimeout(() => {
          setStatus("streaming");
          setMessages((m) => [...m, { id, role: "assistant", text: "", model: label, at: new Date().toISOString() }]);
          // Reveal the reply a few characters at a time, like a streamed answer.
          let shown = 0;
          const tick = () => {
            shown = Math.min(full.length, shown + 4 + Math.floor(Math.random() * 6));
            setMessages((m) => m.map((msg) => (msg.id === id ? { ...msg, text: full.slice(0, shown) } : msg)));
            if (shown < full.length) timers.current.push(window.setTimeout(tick, TICK_MS));
            else {
              setStatus("ready");
              textareaRef.current?.focus();
            }
          };
          tick();
        }, THINK_MS),
      );
      textareaRef.current?.focus();
    },
    [status, ctx, modelLabel],
  );

  const onSubmit = (msg: PromptInputMessage) => send(msg.text ?? "");

  const newChat = () => {
    clearTimers();
    setStatus("ready");
    setMessages([]);
    textareaRef.current?.focus();
  };

  const busy = status !== "ready";
  const last = messages.at(-1);

  return (
    <Card className="mt-6 flex h-[640px] flex-col overflow-hidden shadow-card">
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <HunterAvatar size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-bold text-foreground">Hunter AI</p>
            <Badge variant="neutral" className="text-[10px]">Demo replies</Badge>
          </div>
          <p className="truncate text-xs text-muted-foreground">
            Ask about your leads, posts and outreach · {ctx.accountName}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={newChat} disabled={messages.length === 0 && !busy}>
          <MessageSquarePlus /> <span className="hidden sm:inline">New chat</span>
        </Button>
      </div>

      <Conversation className="bg-muted/30">
        <ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 py-6">
          {messages.length === 0 ? (
            <ConversationEmptyState>
              <HunterAvatar size={56} />
              <div className="space-y-1">
                <h3 className="text-base font-bold text-foreground">Kya poochna hai?</h3>
                <p className="max-w-sm text-sm text-muted-foreground">
                  Ask Hunter AI to summarise leads, draft a first message, or explain the lead rules.
                </p>
              </div>
            </ConversationEmptyState>
          ) : (
            messages.map((m) =>
              m.role === "user" ? (
                <Message key={m.id} from="user">
                  <MessageContent className="group-[.is-user]:rounded-2xl group-[.is-user]:rounded-br-sm group-[.is-user]:bg-primary group-[.is-user]:text-primary-foreground">
                    <p className="whitespace-pre-wrap">{m.text}</p>
                  </MessageContent>
                  <span className="ml-auto text-[11px] text-muted-foreground tabular">{timeOf(m.at)}</span>
                </Message>
              ) : (
                <div key={m.id} className="flex gap-3">
                  <HunterAvatar />
                  <Message from="assistant" className="min-w-0 max-w-full">
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="font-semibold text-foreground">Hunter AI</span>
                      {m.model && <span className="font-mono">{m.model}</span>}
                    </div>
                    <MessageContent className="w-full leading-relaxed [&_pre]:whitespace-pre-wrap [&_pre]:break-words">
                      <MessageResponse>{m.text}</MessageResponse>
                    </MessageContent>
                    {!(busy && m.id === last?.id) && m.text && (
                      <MessageActions className="-ml-2 opacity-70 transition-opacity group-hover:opacity-100">
                        <CopyAction text={m.text} />
                        <span className="text-[11px] text-muted-foreground tabular">{timeOf(m.at)}</span>
                      </MessageActions>
                    )}
                  </Message>
                </div>
              ),
            )
          )}
          {status === "submitted" && (
            <div className="flex items-center gap-3">
              <HunterAvatar />
              <Shimmer className="text-sm">{`Thinking with ${modelLabel}…`}</Shimmer>
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="space-y-2 border-t bg-card px-4 py-3">
        {messages.length === 0 && (
          <Suggestions>
            {CHAT_SUGGESTIONS.map((s) => (
              <Suggestion key={s} suggestion={s} onClick={send} disabled={busy} />
            ))}
          </Suggestions>
        )}
        <PromptInput onSubmit={onSubmit} className="mx-auto max-w-3xl">
          <PromptInputTextarea
            ref={textareaRef}
            placeholder="Message Hunter AI…"
          />
          <PromptInputFooter>
            <PromptInputTools>
              <PromptInputSelect value={provider} onValueChange={(v) => setProvider(v as AiProvider)}>
                <PromptInputSelectTrigger aria-label="AI model" className="h-8 text-xs">
                  <PromptInputSelectValue />
                </PromptInputSelectTrigger>
                <PromptInputSelectContent>
                  {(["gemini", "ollama"] as const).map((p) => (
                    <PromptInputSelectItem key={p} value={p}>
                      {providerLabel(p)} · <span className="font-mono">{p === settings.provider ? settings.model : DEFAULT_MODELS[p]}</span>
                    </PromptInputSelectItem>
                  ))}
                </PromptInputSelectContent>
              </PromptInputSelect>
              {messages.length > 0 && last?.role === "assistant" && !busy && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs text-muted-foreground"
                  onClick={() => {
                    const prev = [...messages].reverse().find((m) => m.role === "user");
                    if (!prev) return;
                    setMessages((ms) => ms.slice(0, -1).filter((x) => x.id !== prev.id));
                    window.setTimeout(() => send(prev.text), 0);
                  }}
                >
                  <RotateCcw className="size-3.5" /> Retry
                </Button>
              )}
            </PromptInputTools>
            <PromptInputSubmit status={status} onStop={stop} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </Card>
  );
}
