import { describe, expect, it } from "vitest";

import { addPosts, parsePostDataJson, SAMPLE_POST_JSON } from "@/lib/leadhunter-service";
import { createSeedState } from "@/lib/seed";

const makePost = (overrides: Record<string, unknown> = {}) => ({
  postUrl: "https://facebook.com/groups/psxinvestorspk/posts/111",
  author: { name: "Ayesha Khan", url: "https://facebook.com/ayesha.khan" },
  text: "Should I start investing in PSX?",
  comments: [
    {
      author: { name: "Bilal Ahmed", url: "https://facebook.com/bilal.ahmed" },
      text: "I am new to this too.",
      replies: [],
    },
  ],
  ...overrides,
});

describe("parsePostDataJson", () => {
  it("parses a single PostData object", () => {
    const r = parsePostDataJson(JSON.stringify(makePost()), createSeedState());
    expect(r.errors).toEqual([]);
    expect(r.alreadyCollected).toEqual([]);
    expect(r.drafts).toHaveLength(1);
    expect(r.drafts[0]!.postUrl).toBe("https://facebook.com/groups/psxinvestorspk/posts/111");
    expect(r.drafts[0]!.author.name).toBe("Ayesha Khan");
  });

  it("parses the sample JSON", () => {
    const r = parsePostDataJson(SAMPLE_POST_JSON, createSeedState());
    expect(r.errors).toEqual([]);
    expect(r.drafts).toHaveLength(1);
    expect(r.drafts[0]!.comments).toHaveLength(2);
  });

  it("parses a {\"posts\": [...]} wrapper", () => {
    const raw = JSON.stringify({
      posts: [
        makePost(),
        makePost({ postUrl: "https://facebook.com/groups/psxinvestorspk/posts/222" }),
      ],
    });
    const r = parsePostDataJson(raw, createSeedState());
    expect(r.errors).toEqual([]);
    expect(r.drafts).toHaveLength(2);
    expect(r.drafts.map((d) => d.postUrl)).toEqual([
      "https://facebook.com/groups/psxinvestorspk/posts/111",
      "https://facebook.com/groups/psxinvestorspk/posts/222",
    ]);
  });

  it("parses a bare array of posts", () => {
    const r = parsePostDataJson(JSON.stringify([makePost()]), createSeedState());
    expect(r.errors).toEqual([]);
    expect(r.drafts).toHaveLength(1);
  });

  it("accepts a null author/commenter URL as empty string (anonymous)", () => {
    const raw = JSON.stringify(
      makePost({
        author: { name: "Anonymous participant", url: null },
        comments: [
          {
            author: { name: "Anonymous participant", url: null },
            text: "Keep it for long term.",
            replies: [],
          },
        ],
      }),
    );
    const r = parsePostDataJson(raw, createSeedState());
    expect(r.errors).toEqual([]);
    expect(r.drafts).toHaveLength(1);
    expect(r.drafts[0]!.author.url).toBe("");
    expect(r.drafts[0]!.comments[0]!.author.url).toBe("");
  });

  it("reports invalid JSON instead of throwing", () => {
    const r = parsePostDataJson("{not json", createSeedState());
    expect(r.drafts).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.reason).toMatch(/Invalid JSON/);
  });

  it("reports a post that fails validation, with which post and why", () => {
    const raw = JSON.stringify([makePost(), makePost({ postUrl: "   " })]);
    const r = parsePostDataJson(raw, createSeedState());
    expect(r.drafts).toHaveLength(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.label).toBe("Post 2");
    expect(r.errors[0]!.reason).toMatch(/postUrl is required/);
  });

  it("detects a duplicate postUrl as already collected", () => {
    const state = createSeedState();
    const existingUrl = state.posts[0]!.postUrl;
    const r = parsePostDataJson(JSON.stringify(makePost({ postUrl: existingUrl })), state);
    expect(r.drafts).toEqual([]);
    expect(r.alreadyCollected).toHaveLength(1);
    expect(r.alreadyCollected[0]!.postUrl).toBe(existingUrl);
    expect(r.alreadyCollected[0]!.accountName).toBe("Ayesha — Main");
  });
});

describe("addPosts batch import", () => {
  it("imports only the new posts and skips already-collected ones", () => {
    const state = createSeedState();
    const existingUrl = state.posts[0]!.postUrl;
    const parsed = parsePostDataJson(
      JSON.stringify([makePost(), makePost({ postUrl: existingUrl })]),
      state,
    );
    expect(parsed.drafts).toHaveLength(1);
    const r = addPosts(state, parsed.drafts, "src-1", "acc-1", () => "post-new", "2026-11-12T00:00:00.000Z");
    expect(r.added).toBe(1);
    expect(r.skipped).toBe(0);
    expect(r.state.posts).toHaveLength(state.posts.length + 1);
    expect(r.state.posts[0]!.postUrl).toBe("https://facebook.com/groups/psxinvestorspk/posts/111");
  });

  it("skips a draft whose URL was already collected, even inside one batch", () => {
    const state = createSeedState();
    const parsed = parsePostDataJson(
      JSON.stringify([makePost(), makePost()]),
      state,
    );
    const r = addPosts(state, parsed.drafts, "src-1", "acc-1", () => "post-new", "2026-11-12T00:00:00.000Z");
    expect(r.added).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.alreadyCollected).toHaveLength(1);
    expect(r.alreadyCollected[0]!.accountName).toBe("Ayesha — Main");
  });
});
