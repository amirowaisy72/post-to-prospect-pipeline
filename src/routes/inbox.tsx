import { createFileRoute, Link } from "@tanstack/react-router";
import {
  CheckCircle2,
  ExternalLink,
  Inbox as InboxIcon,
  MessageSquarePlus,
  Send,
  Sparkles,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, PageHeader } from "@/components/page-header";
import { messagesForThread, threadsForAccount } from "@/lib/leadhunter-service";
import { mockInboxReply } from "@/lib/mock-chat";
import { useActiveAccountData, useStore } from "@/lib/store";
import type { ChatScript, InboxSourceType } from "@/lib/types";

export const Route = createFileRoute("/inbox")({
  head: () => ({
    meta: [
      { title: "Inbox — LeadHunter" },
      {
        name: "description",
        content:
          "Chat with shortlisted candidates. The agent opens with their comment or post, then follows your script.",
      },
      { property: "og:title", content: "Inbox — LeadHunter" },
      {
        property: "og:description",
        content:
          "Chat with shortlisted candidates. The agent opens with their comment or post, then follows your script.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: InboxPage,
});

const timeOf = (iso: string) =>
  new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

function InboxPage() {
  const { state, createChatThread, addChatMessage, setThreadStatus, updateChatScript } = useStore();
  const { accountId } = useActiveAccountData();
  const account = state.accounts.find((a) => a.id === accountId);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [profileUrl, setProfileUrl] = useState("");
  const [profileName, setProfileName] = useState("");
  const [sourceType, setSourceType] = useState<InboxSourceType>("comment");
  const [sourceText, setSourceText] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [shortlistNote, setShortlistNote] = useState("");
  const [formError, setFormError] = useState("");
  const [replyText, setReplyText] = useState("");
  const [draft, setDraft] = useState<ChatScript>(state.chatScript);

  // Switching account resets the page.
  useEffect(() => {
    setSelectedId(null);
    setShowForm(false);
  }, [accountId]);
  // Keep the script editor in sync when the saved script changes elsewhere.
  useEffect(() => setDraft(state.chatScript), [state.chatScript]);

  const sortedThreads = threadsForAccount(state, accountId);
  const selected = sortedThreads.find((t) => t.id === selectedId) ?? null;
  const messages = selected ? messagesForThread(state, selected.id) : [];
  const lastMessage = (threadId: string) => messagesForThread(state, threadId).at(-1);

  const startChat = () => {
    setFormError("");
    if (!accountId) {
      setFormError("Create an account first — chats belong to an account.");
      return;
    }
    const thread = createChatThread({
      profileUrl,
      profileName,
      sourceType,
      sourceText,
      sourceUrl,
      shortlistNote,
    });
    if (!thread) return; // the store already showed the validation error
    setProfileUrl("");
    setProfileName("");
    setSourceType("comment");
    setSourceText("");
    setSourceUrl("");
    setShortlistNote("");
    setShowForm(false);
    setSelectedId(thread.id);
  };

  const addReply = () => {
    if (!selected || !replyText.trim()) return;
    if (addChatMessage(selected.id, "candidate", replyText)) setReplyText("");
  };

  const generateReply = () => {
    if (!selected) return;
    const text = mockInboxReply({
      profileName: selected.profileName,
      sourceType: selected.sourceType,
      sourceText: selected.sourceText,
      script: state.chatScript,
      history: messages.map((m) => ({ role: m.role, text: m.text })),
    });
    addChatMessage(selected.id, "agent", text);
  };

  const saveScript = () => {
    updateChatScript(draft);
  };

  return (
    <>
      <PageHeader
        title="Inbox"
        description="Chat with shortlisted candidates. Start a chat, and the agent opens by referencing their comment or post, introduces itself, then follows your script — the goal is to convince the client and push them to a call."
        actions={
          <Button onClick={() => setShowForm((s) => !s)} disabled={!account}>
            <MessageSquarePlus /> New chat
          </Button>
        }
      />

      <div className="mb-6 flex items-start gap-3 rounded-lg border border-dashed border-primary/40 bg-accent/60 p-4">
        <InboxIcon className="mt-0.5 size-5 shrink-0 text-primary" />
        <div>
          <p className="text-sm font-semibold text-accent-foreground">
            In-app only — Messenger delivery is not connected yet.
          </p>
          <p className="text-sm text-muted-foreground">
            Agent messages below are drafts stored in LeadHunter; they have <strong>not</strong>{" "}
            been sent to Facebook Messenger. Paste the candidate&apos;s real replies from Messenger
            here, generate the next draft, and send it yourself until live delivery arrives.
          </p>
        </div>
      </div>

      {!account ? (
        <EmptyState title="No account yet">
          Create an account on the{" "}
          <Link to="/accounts" className="font-semibold text-primary">
            Accounts
          </Link>{" "}
          page first.
        </EmptyState>
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[340px_1fr]">
          {/* Left: new-chat form + thread list */}
          <div className="space-y-6">
            {showForm && (
              <Card className="shadow-card">
                <CardHeader>
                  <CardTitle className="text-base">New chat</CardTitle>
                  <CardDescription>
                    Who are you chatting with, and what were they shortlisted from?
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="profile-url">Profile link *</Label>
                    <Input
                      id="profile-url"
                      value={profileUrl}
                      onChange={(e) => setProfileUrl(e.target.value)}
                      placeholder="https://www.facebook.com/someone"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="profile-name">Name *</Label>
                    <Input
                      id="profile-name"
                      value={profileName}
                      onChange={(e) => setProfileName(e.target.value)}
                      placeholder="e.g. Sana Mirza"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Shortlisted from</Label>
                    <Select
                      value={sourceType}
                      onValueChange={(v) => setSourceType(v as InboxSourceType)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="comment">A comment</SelectItem>
                        <SelectItem value="post">A post</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="source-text">
                      {sourceType === "comment" ? "Their comment *" : "Their post *"}
                    </Label>
                    <Textarea
                      id="source-text"
                      value={sourceText}
                      onChange={(e) => setSourceText(e.target.value)}
                      placeholder="Paste the exact comment or post text…"
                      rows={3}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="source-url">Link to that comment / post</Label>
                    <Input
                      id="source-url"
                      value={sourceUrl}
                      onChange={(e) => setSourceUrl(e.target.value)}
                      placeholder="https://www.facebook.com/groups/…/posts/…"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="shortlist-note">Note (optional)</Label>
                    <Input
                      id="shortlist-note"
                      value={shortlistNote}
                      onChange={(e) => setShortlistNote(e.target.value)}
                      placeholder="Why this person? e.g. Rich Beginner, asked where to start"
                    />
                  </div>
                  {formError && <p className="text-sm text-destructive">{formError}</p>}
                  <Button className="w-full" onClick={startChat}>
                    <Send /> Start chat
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Starting a chat composes the first message from your script right away.
                  </p>
                </CardContent>
              </Card>
            )}

            <Card className="shadow-card">
              <CardHeader>
                <CardTitle className="text-base">Chats</CardTitle>
                <CardDescription>
                  {sortedThreads.length} chat{sortedThreads.length === 1 ? "" : "s"} for{" "}
                  {account.name}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {sortedThreads.length === 0 ? (
                  <EmptyState title="No chats yet">
                    Start your first chat with a shortlisted candidate.
                  </EmptyState>
                ) : (
                  sortedThreads.map((t) => {
                    const last = lastMessage(t.id);
                    const on = t.id === selectedId;
                    return (
                      <button
                        key={t.id}
                        onClick={() => setSelectedId(t.id)}
                        className={`w-full rounded-lg border p-3 text-left transition-colors ${
                          on ? "border-primary bg-accent/60" : "hover:bg-muted/50"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-semibold text-foreground">
                            {t.profileName}
                          </span>
                          <Badge variant={t.status === "active" ? "success" : "neutral"}>
                            {t.status === "active" ? "Active" : "Done"}
                          </Badge>
                        </div>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {t.sourceType === "comment" ? "From a comment" : "From a post"}
                          {t.shortlistNote ? ` · ${t.shortlistNote}` : ""}
                        </p>
                        {last && (
                          <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                            {last.role === "agent" ? "You: " : `${t.profileName.split(" ")[0]}: `}
                            {last.text}
                          </p>
                        )}
                      </button>
                    );
                  })
                )}
              </CardContent>
            </Card>
          </div>

          {/* Right: conversation + script */}
          <div className="space-y-6">
            {!selected ? (
              <Card className="shadow-card">
                <CardContent className="p-10">
                  <EmptyState title="Pick a chat, or start a new one">
                    Click a thread on the left to see the full conversation.
                  </EmptyState>
                </CardContent>
              </Card>
            ) : (
              <Card className="shadow-card">
                <CardHeader className="flex flex-row items-start justify-between space-y-0">
                  <div>
                    <CardTitle className="text-base">
                      <a
                        href={selected.profileUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 hover:text-primary"
                      >
                        {selected.profileName} <ExternalLink className="size-3.5" />
                      </a>
                    </CardTitle>
                    <CardDescription>
                      Shortlisted from a {selected.sourceType}
                      {selected.sourceUrl ? (
                        <>
                          {" · "}
                          <a
                            href={selected.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="underline hover:text-primary"
                          >
                            open source
                          </a>
                        </>
                      ) : (
                        ""
                      )}
                    </CardDescription>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setThreadStatus(selected.id, selected.status === "active" ? "done" : "active")
                    }
                  >
                    <CheckCircle2 />
                    {selected.status === "active" ? "Mark done" : "Reopen"}
                  </Button>
                </CardHeader>
                <CardContent className="space-y-4">
                  <blockquote className="rounded-lg border-l-2 border-primary bg-muted/40 p-3 text-sm italic text-muted-foreground">
                    Shortlisted from: “{selected.sourceText}”
                  </blockquote>

                  <div className="space-y-3">
                    {messages.length === 0 ? (
                      <EmptyState title="No messages yet" />
                    ) : (
                      messages.map((m) => (
                        <div
                          key={m.id}
                          className={`flex ${m.role === "agent" ? "justify-end" : "justify-start"}`}
                        >
                          <div
                            className={`max-w-[80%] space-y-1 ${m.role === "agent" ? "text-right" : ""}`}
                          >
                            <div
                              className={`inline-block rounded-2xl px-3.5 py-2.5 text-sm whitespace-pre-wrap ${
                                m.role === "agent"
                                  ? "rounded-br-sm bg-primary text-primary-foreground"
                                  : "rounded-bl-sm bg-muted text-foreground"
                              }`}
                            >
                              {m.text}
                            </div>
                            <p className="text-[11px] text-muted-foreground tabular">
                              {m.role === "agent"
                                ? "Agent draft · In-app only — not sent to Messenger"
                                : "Reply recorded in-app"}{" "}
                              · {timeOf(m.createdAt)}
                            </p>
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  {selected.status === "active" && (
                    <div className="space-y-3 border-t pt-4">
                      <div className="space-y-1.5">
                        <Label htmlFor="candidate-reply">
                          Paste the candidate&apos;s reply from Messenger
                        </Label>
                        <Textarea
                          id="candidate-reply"
                          value={replyText}
                          onChange={(e) => setReplyText(e.target.value)}
                          placeholder="Paste what they actually replied…"
                          rows={2}
                        />
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button onClick={addReply} disabled={!replyText.trim()}>
                          <Send /> Add reply
                        </Button>
                        <Button variant="outline" onClick={generateReply}>
                          <Sparkles /> Generate agent reply
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Demo draft for now — Gemini answers arrive with the backend, through the
                        same reply seam.
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            <Card className="shadow-card">
              <CardHeader>
                <CardTitle className="text-base">Chat script</CardTitle>
                <CardDescription>
                  The agent follows this in every chat. Your real script has not been added yet —
                  edit this default before real outreach. Use {"{name}"}, {"{sourceKind}"} and{" "}
                  {"{sourceText}"} in the first message.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="script-first">First message template</Label>
                  <Textarea
                    id="script-first"
                    value={draft.firstMessageTemplate}
                    onChange={(e) => setDraft({ ...draft, firstMessageTemplate: e.target.value })}
                    rows={3}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="script-intro">Self-introduction</Label>
                  <Textarea
                    id="script-intro"
                    value={draft.introduction}
                    onChange={(e) => setDraft({ ...draft, introduction: e.target.value })}
                    rows={2}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="script-tone">Tone</Label>
                  <Textarea
                    id="script-tone"
                    value={draft.tone}
                    onChange={(e) => setDraft({ ...draft, tone: e.target.value })}
                    rows={2}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="script-rules">Rules</Label>
                  <Textarea
                    id="script-rules"
                    value={draft.rules}
                    onChange={(e) => setDraft({ ...draft, rules: e.target.value })}
                    rows={4}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="script-goal">Goal</Label>
                  <Textarea
                    id="script-goal"
                    value={draft.goal}
                    onChange={(e) => setDraft({ ...draft, goal: e.target.value })}
                    rows={2}
                  />
                </div>
                <div className="flex gap-2">
                  <Button onClick={saveScript}>Save script</Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        firstMessageTemplate: state.chatScript.firstMessageTemplate,
                        introduction: state.chatScript.introduction,
                        tone: state.chatScript.tone,
                        rules: state.chatScript.rules,
                        goal: state.chatScript.goal,
                      })
                    }
                  >
                    Discard changes
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
