import { describe, expect, it } from "vitest";

import {
  addChatMessage,
  composeFirstMessage,
  createAccount,
  createChatThread,
  isFacebookProfileUrl,
  messagesForThread,
  setThreadStatus,
  updateChatScript,
} from "@/lib/leadhunter-service";
import { mockInboxReply } from "@/lib/mock-chat";
import { createSeedState } from "@/lib/seed";
import type { AppState } from "@/lib/types";

const NOW = "2026-11-12T00:00:00.000Z";

/** Empty state + one account (acc-1, "Master"). */
function withAccount(): AppState {
  const r = createAccount(
    createSeedState(),
    { name: "Master", facebookName: "Amir Owaisy" },
    "acc-1",
    NOW,
  );
  if (!r.ok) throw new Error("fixture account failed");
  return r.value;
}

const INPUT = {
  id: "thread-1",
  profileUrl: "https://www.facebook.com/sana.mirza",
  profileName: "Sana Mirza",
  sourceType: "comment" as const,
  sourceText: "I have 20 lakh saved and never invested, where do I start?",
  sourceUrl: "https://www.facebook.com/groups/111/posts/1",
  shortlistNote: "Rich Beginner",
};

describe("isFacebookProfileUrl", () => {
  it("accepts profile links with or without https:// and www.", () => {
    expect(isFacebookProfileUrl("https://www.facebook.com/sana.mirza")).toBe(true);
    expect(isFacebookProfileUrl("facebook.com/sana.mirza")).toBe(true);
    expect(isFacebookProfileUrl("https://www.facebook.com/profile.php?id=123")).toBe(true);
  });

  it("rejects non-Facebook links, bare facebook.com, and groups/pages", () => {
    expect(isFacebookProfileUrl("https://example.com/sana")).toBe(false);
    expect(isFacebookProfileUrl("https://www.facebook.com/")).toBe(false);
    expect(isFacebookProfileUrl("https://www.facebook.com/groups/111")).toBe(false);
    expect(isFacebookProfileUrl("not a url")).toBe(false);
  });
});

describe("createChatThread", () => {
  it("creates the thread and composes the first message from the script", () => {
    const r = createChatThread(withAccount(), INPUT, "acc-1", "msg-1", NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.thread.profileName).toBe("Sana Mirza");
    expect(r.value.thread.status).toBe("active");
    expect(r.value.firstMessage.role).toBe("agent");
    // The opener references their exact comment and introduces the agent.
    expect(r.value.firstMessage.text).toContain("I have 20 lakh saved and never invested");
    expect(r.value.firstMessage.text).toContain("Sana");
    expect(r.value.firstMessage.text).toContain("comment");
    // Honesty: v1 never claims the message went to Messenger.
    expect(r.value.firstMessage.delivery).toBe("in-app");
    expect(r.value.state.threads).toHaveLength(1);
    expect(r.value.state.chatMessages).toHaveLength(1);
  });

  it("rejects a bad profile link, a missing name, and a missing source text", () => {
    const state = withAccount();
    expect(
      createChatThread(
        state,
        { ...INPUT, profileUrl: "https://example.com/sana" },
        "acc-1",
        "msg-1",
        NOW,
      ).ok,
    ).toBe(false);
    expect(createChatThread(state, { ...INPUT, profileName: "  " }, "acc-1", "msg-1", NOW).ok).toBe(
      false,
    );
    expect(createChatThread(state, { ...INPUT, sourceText: "" }, "acc-1", "msg-1", NOW).ok).toBe(
      false,
    );
  });

  it("blocks a second active thread for the same profile", () => {
    const first = createChatThread(withAccount(), INPUT, "acc-1", "msg-1", NOW);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = createChatThread(
      first.value.state,
      { ...INPUT, id: "thread-2" },
      "acc-1",
      "msg-2",
      NOW,
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/already an active chat/);
  });

  it("allows a new thread after the old one is marked done", () => {
    const first = createChatThread(withAccount(), INPUT, "acc-1", "msg-1", NOW);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const done = setThreadStatus(first.value.state, "thread-1", "done");
    const second = createChatThread(done, { ...INPUT, id: "thread-2" }, "acc-1", "msg-2", NOW);
    expect(second.ok).toBe(true);
  });
});

describe("composeFirstMessage", () => {
  it("fills {name}, {sourceKind} and {sourceText} from the thread", () => {
    const state = withAccount();
    const text = composeFirstMessage(state.chatScript, {
      id: "thread-1",
      accountId: "acc-1",
      profileUrl: INPUT.profileUrl,
      profileName: "Hamza",
      sourceType: "post",
      sourceText: "Looking to invest 50 lakh this year.",
      sourceUrl: "",
      shortlistNote: "",
      status: "active",
      createdAt: NOW,
    });
    expect(text).toContain("Hamza");
    expect(text).toContain("post");
    expect(text).toContain("Looking to invest 50 lakh this year.");
  });
});

describe("addChatMessage", () => {
  it("appends candidate replies and agent drafts, oldest first", () => {
    const first = createChatThread(withAccount(), INPUT, "acc-1", "msg-1", NOW);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    let state = first.value.state;
    const r1 = addChatMessage(state, {
      threadId: "thread-1",
      role: "candidate",
      text: "Hi, tell me more",
      id: "msg-2",
      now: NOW,
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    state = r1.value;
    const r2 = addChatMessage(state, {
      threadId: "thread-1",
      role: "agent",
      text: "Sure — here is the simple start.",
      id: "msg-3",
      now: NOW,
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const msgs = messagesForThread(r2.value, "thread-1");
    expect(msgs.map((m) => m.role)).toEqual(["agent", "candidate", "agent"]);
    expect(msgs.every((m) => m.delivery === "in-app")).toBe(true);
  });

  it("rejects an empty message and an unknown thread", () => {
    const first = createChatThread(withAccount(), INPUT, "acc-1", "msg-1", NOW);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(
      addChatMessage(first.value.state, {
        threadId: "thread-1",
        role: "candidate",
        text: "  ",
        id: "msg-2",
        now: NOW,
      }).ok,
    ).toBe(false);
    expect(
      addChatMessage(first.value.state, {
        threadId: "nope",
        role: "candidate",
        text: "hi",
        id: "msg-2",
        now: NOW,
      }).ok,
    ).toBe(false);
  });
});

describe("updateChatScript", () => {
  it("saves an edited script and rejects an empty template or goal", () => {
    const state = withAccount();
    const ok = updateChatScript(state, {
      ...state.chatScript,
      goal: "Push them to a call this week.",
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.chatScript.goal).toBe("Push them to a call this week.");
    expect(updateChatScript(state, { ...state.chatScript, firstMessageTemplate: "" }).ok).toBe(
      false,
    );
    expect(updateChatScript(state, { ...state.chatScript, goal: "  " }).ok).toBe(false);
  });
});

describe("mockInboxReply (Gemini draft seam)", () => {
  it("drafts a follow-up that references the candidate's last reply", () => {
    const state = withAccount();
    const draft = mockInboxReply({
      profileName: "Sana Mirza",
      sourceType: "comment",
      sourceText: INPUT.sourceText,
      script: state.chatScript,
      history: [
        { role: "agent", text: "Hi Sana!" },
        { role: "candidate", text: "How do I start with 20 lakh?" },
      ],
    });
    expect(draft.length).toBeGreaterThan(0);
    expect(draft).toContain("Sana");
  });

  it("backs off politely when the candidate says no", () => {
    const state = withAccount();
    const draft = mockInboxReply({
      profileName: "Sana Mirza",
      sourceType: "comment",
      sourceText: INPUT.sourceText,
      script: state.chatScript,
      history: [{ role: "candidate", text: "Not interested, thanks" }],
    });
    expect(draft.toLowerCase()).toContain("no problem");
  });
});
