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
  "Kaunsa group sab se acha hai?",
];

export function demoConversation(model: string): ChatMessage[] {
  return [
    {
      id: "demo-1",
      role: "user",
      text: "Mujhe batao is hafte ki sab se achi leads kaun si hain?",
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
      text: "Sana ke liye ek short message likh do.",
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
        "Assalam o Alaikum Sana! I saw your comment in PSX Investors Pakistan",
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

  if (has(t, ["message", "likh", "write", "dm", "reach out", "draft"])) {
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

  if (has(t, ["group", "page", "source", "kaunsa", "best group"])) {
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

  if (has(t, ["lead", "summar", "best", "achi", "top"])) {
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
