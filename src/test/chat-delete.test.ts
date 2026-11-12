import { describe, expect, it } from "vitest";

import {
  addChatMessage,
  createAccount,
  createChatThread,
  deleteChatThread,
} from "@/lib/leadhunter-service";
import { createSeedState } from "@/lib/seed";
import type { AppState } from "@/lib/types";

const NOW = "2026-11-13T00:00:00.000Z";

function withAccount(): AppState {
  const r = createAccount(
    createSeedState(),
    { name: "Master", facebookName: "Amir Owaisy", facebookCreatedAt: "2020-01-01" },
    "acc-1",
    NOW,
  );
  if (!r.ok) throw new Error("fixture account failed");
  return r.value;
}

const INPUT = (id: string, profileUrl: string, profileName: string) => ({
  id,
  profileUrl,
  profileName,
  sourceType: "comment" as const,
  sourceText: "I have 20 lakh saved and never invested, where do I start?",
  sourceUrl: "https://www.facebook.com/groups/111/posts/1",
  shortlistNote: "Rich Beginner",
});

function withTwoThreads(): AppState {
  let s = withAccount();
  for (const [id, url, name] of [
    ["thread-1", "https://www.facebook.com/sana.mirza", "Sana Mirza"],
    ["thread-2", "https://www.facebook.com/zainab.khan", "Zainab Khan"],
  ] as const) {
    const r = createChatThread(s, INPUT(id, url, name), "acc-1", `msg-${id}`, NOW);
    if (!r.ok) throw new Error("fixture thread failed");
    s = r.value.state;
  }
  // A candidate reply on thread-1, so deletion must remove more
  // than the first message.
  const reply = addChatMessage(s, { threadId: "thread-1", role: "candidate", text: "Hello!", id: "msg-reply-1", now: NOW });
  if (!reply.ok) throw new Error("fixture reply failed");
  return reply.value;
}

describe("deleteChatThread", () => {
  it("removes the thread and ALL its messages", () => {
    const state = withTwoThreads();
    expect(state.threads).toHaveLength(2);
    expect(state.chatMessages).toHaveLength(3);
    const r = deleteChatThread(state, "thread-1", NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.threads.map((t) => t.id)).toEqual(["thread-2"]);
    expect(r.value.chatMessages.map((m) => m.threadId)).toEqual(["thread-2"]);
  });

  it("leaves other threads untouched", () => {
    const state = withTwoThreads();
    const r = deleteChatThread(state, "thread-2", NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.threads.map((t) => t.id)).toEqual(["thread-1"]);
    expect(r.value.chatMessages).toHaveLength(2);
    expect(r.value.chatMessages[0]!.text).toContain("Sana");
  });

  it("frees the profile so a New chat with the same person is allowed again", () => {
    const state = withTwoThreads();
    const deleted = deleteChatThread(state, "thread-1", NOW);
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    // Before the delete this was blocked ("There is already an
    // active chat with Sana Mirza.").
    const again = createChatThread(
      deleted.value,
      INPUT("thread-3", "https://www.facebook.com/sana.mirza", "Sana Mirza"),
      "acc-1",
      "msg-3",
      NOW,
    );
    expect(again.ok).toBe(true);
  });

  it("keeps the one-active-chat-per-profile rule for threads that still exist", () => {
    const state = withTwoThreads();
    const again = createChatThread(
      state,
      INPUT("thread-3", "https://www.facebook.com/sana.mirza", "Sana Mirza"),
      "acc-1",
      "msg-3",
      NOW,
    );
    expect(again.ok).toBe(false);
  });

  it("fails for an unknown thread", () => {
    expect(deleteChatThread(withTwoThreads(), "thread-nope", NOW).ok).toBe(false);
  });

  it("records a chat-deleted activity entry", () => {
    const state = withTwoThreads();
    const r = deleteChatThread(state, "thread-1", NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.activity[0]!.type).toBe("chat-deleted");
    expect(r.value.activity[0]!.message).toContain("Sana Mirza");
  });
});
