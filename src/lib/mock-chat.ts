// Demo chat replies for the AI Analysis chat box. No real model is called yet;
// swap `mockReply` for a server call to Gemini / Ollama when the backend arrives.
import type { AiProvider } from "./types";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Model that wrote an assistant message, e.g. "Gemini · gemini-3.8-flash". */
  model?: string;
  at: string;
}

export interface ChatContext {
  accountName: string;
  postCount: number;
  newLeads: number;
  shortlisted: number;
  topLeads: { name: string; priority: string; reason: string }[];
  defaultLeadsCount: number;
}

export const DEFAULT_MODELS: Record<AiProvider, string> = {
  gemini: "gemini-3.8-flash",
  ollama: "llama3.1:8b",
};

export const providerLabel = (p: AiProvider) => (p === "gemini" ? "Gemini" : "Ollama");

export const CHAT_SUGGESTIONS = [
  "Summarise my best leads",
  "Write a first message for a Rich Beginner",
  "Why are tip sellers rejected?",
  "Which group is the best?",
];

/**
 * Inbox draft seam — the agent's next message in a DM thread.
 *
 * Demo only: no real model is called yet. When the Gemini backend
 * arrives, swap `mockInboxReply` for a server call through Lovable's
 * gateway (never call Gemini from the browser with a key — see
 * AGENTS.md). The prompt the real call will send is built by
 * `inboxPrompt`: script + thread source + full history.
 */
export interface InboxDraftContext {
  profileName: string;
  sourceType: "comment" | "post";
  sourceText: string;
  script: {
    introduction: string;
    tone: string;
    rules: string;
    goal: string;
  };
  history: { role: "agent" | "candidate" | "system"; text: string }[];
}

/** The exact prompt a real Gemini call will receive for the next reply. */
export function inboxPrompt(ctx: InboxDraftContext): string {
  const history =
    ctx.history.length === 0
      ? "(No messages yet — this is the first reply after the opener.)"
      : ctx.history
          .map(
            (m) =>
              `${m.role === "agent" ? "Me" : m.role === "candidate" ? ctx.profileName : "Note"}: ${m.text}`,
          )
          .join("\n");
  return [
    "You are a friendly DM assistant. Follow the script below exactly.",
    "",
    `Goal: ${ctx.script.goal}`,
    `Tone: ${ctx.script.tone}`,
    `Rules:\n${ctx.script.rules}`,
    "",
    `The person (${ctx.profileName}) was shortlisted from this ${ctx.sourceType}: “${ctx.sourceText}”.`,
    `Introduction used: ${ctx.script.introduction}`,
    "",
    "Conversation so far:",
    history,
    "",
    "Write the next short message to send. Keep it under 3 short sentences. Reply with the message text only.",
  ].join("\n");
}

/** Demo draft for the agent's next message — follows the script's tone and goal. */
export function mockInboxReply(ctx: InboxDraftContext): string {
  const lastCandidate = [...ctx.history].reverse().find((m) => m.role === "candidate");
  const firstName = ctx.profileName.split(" ")[0];
  if (!lastCandidate) {
    return [
      `Hi ${firstName}! Just checking in — did my last message make sense for you?`,
      "Happy to share the simple first step whenever you're ready, no pressure at all.",
    ].join(" ");
  }
  const t = lastCandidate.text.toLowerCase();
  if (has(t, ["no", "not interested", "no thanks", "stop", "busy"])) {
    return `No problem at all, ${firstName} — thanks for replying. If investing ever comes up for you later, I'm here. All the best!`;
  }
  if (has(t, ["how", "what", "tell", "more", "plan", "start"])) {
    return [
      `Good question, ${firstName}! The simple start is: a small amount, split across two or three safe options, and we review it together after a month.`,
      "Want me to sketch that first split for you? It takes two minutes.",
    ].join(" ");
  }
  if (has(t, ["yes", "ok", "sure", "interested", "sounds good"])) {
    return [
      `Great, ${firstName}! Let's keep it easy — can we do a short 10-minute call this week so I can show you the first step properly?`,
      "You pick the time, I'll work around it.",
    ].join(" ");
  }
  return [
    `Thanks for sharing that, ${firstName} — that helps me understand where you're coming from.`,
    "The next step is a small, safe one — want me to lay it out in two lines?",
  ].join(" ");
}

export function demoConversation(model: string): ChatMessage[] {
  return [
    {
      id: "demo-1",
      role: "user",
      text: "Tell me which are the best leads this week?",
      at: "2026-11-11T09:00:00.000Z",
    },
    {
      id: "demo-2",
      role: "assistant",
      model,
      at: "2026-11-11T09:00:04.000Z",
      text: [
        "Here are your strongest leads this week:",
        "",
        "1. **Sana Mirza** — *Rich Beginner*. Shows real wealth and has never invested. Perfect first conversation.",
        "2. **Hamza Qureshi** — *Rich Experienced*. Already investing and has spare cash to grow.",
        "",
        "> Tip: reach out to Rich Beginners first — they ask for guidance and reply faster.",
      ].join("\n"),
    },
    {
      id: "demo-3",
      role: "user",
      text: "Write a short message for Sana.",
      at: "2026-11-11T09:01:00.000Z",
    },
    {
      id: "demo-4",
      role: "assistant",
      model,
      at: "2026-11-11T09:01:03.000Z",
      text: [
        "Sure — friendly and short, no hard selling:",
        "",
        "```text",
        "Hello Sana! I saw your comment in PSX Investors Pakistan",
        "about getting started with investing. Happy to share how beginners",
        "usually split their first investment — no pressure at all. 🙂",
        "```",
      ].join("\n"),
    },
  ];
}

const has = (t: string, words: string[]) => words.some((w) => t.includes(w));

/** Pick a demo reply that fits the question and the account's real numbers. */
export function mockReply(prompt: string, ctx: ChatContext): string {
  const t = prompt.toLowerCase();

  if (has(t, ["message", "write", "dm", "reach out", "draft"])) {
    const lead = ctx.topLeads[0]?.name.split(" ")[0] ?? "there";
    return [
      "Here's a short opener you can send:",
      "",
      "```text",
      `Hi ${lead}! I noticed your comment about investing and wanted to say`,
      "it's a great time to plan. I help people take their first steps safely —",
      "happy to share a simple plan if you're interested.",
      "```",
      "",
      "Keep it personal: mention the **exact post** they commented on.",
    ].join("\n");
  }

  if (has(t, ["reject", "spam", "tip", "telegram", "course", "seller"])) {
    return [
      "LeadHunter rejects these profiles because they **sell to the group** rather than buy:",
      "",
      "- **Tip sellers** — share stock tips for a fee",
      "- **Telegram / WhatsApp promoters** — push people to paid channels",
      "- **Group or course sellers** — advertise their own courses",
      "- **Spam profiles** — copy-paste comments, no real interest",
      "",
      "You can edit this list on the **Configurations** page.",
    ].join("\n");
  }

  if (has(t, ["group", "page", "source", "best group"])) {
    return [
      "Based on your collected posts, **PSX Investors Pakistan** gives the most leads per post.",
      "",
      "| Source | Why it works |",
      "| --- | --- |",
      "| PSX Investors Pakistan | Many first-time investors asking where to start |",
      "| Karachi Business Owners Network | Wealthy owners with spare cash |",
      "",
      "Stick to groups that meet your sourcing rules before joining new ones.",
    ].join("\n");
  }

  if (has(t, ["lead", "summar", "best", "top"])) {
    if (ctx.topLeads.length === 0) {
      return `No leads yet for **${ctx.accountName}**. Pick posts above and click **Analyse** — I'll summarise them for you after.`;
    }
    const lines = ctx.topLeads
      .slice(0, ctx.defaultLeadsCount)
      .map((l, i) => `${i + 1}. **${l.name}** — *${l.priority}*. ${l.reason}`);
    return [
      `**${ctx.accountName}** has **${ctx.newLeads} new** and **${ctx.shortlisted} shortlisted** leads. The top ones:`,
      "",
      ...lines,
    ].join("\n");
  }

  return [
    `I can help you work through the **${ctx.postCount} collected posts** for ${ctx.accountName}. Try asking me to:`,
    "",
    "- summarise your best leads",
    "- write a first message for a lead",
    "- explain why someone was rejected",
    "",
    "_Demo reply — real AI answers arrive with the backend._",
  ].join("\n");
}
