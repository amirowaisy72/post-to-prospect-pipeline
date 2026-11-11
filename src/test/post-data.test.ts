import { describe, expect, it } from "vitest";

import { addPosts, mergePostActivity, parsePostDataJson, postTitle, requestSourceJobStop, runningJobForSource, scrapedCount, startSourceJob, updateSourceJob, SAMPLE_POST_JSON } from "@/lib/leadhunter-service";
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

  it("allowExisting returns an already-collected post as a draft (Sync re-import)", () => {
    const state = createSeedState();
    const existingUrl = state.posts[0]!.postUrl;
    const r = parsePostDataJson(JSON.stringify(makePost({ postUrl: existingUrl })), state, { allowExisting: true });
    expect(r.drafts).toHaveLength(1);
    expect(r.alreadyCollected).toEqual([]);
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

describe("parser timestamps", () => {
  it("keeps postedAt/postedAtLabel on comments and replies", () => {
    const raw = JSON.stringify(
      makePost({
        comments: [
          {
            author: { name: "Bilal Ahmed", url: "https://facebook.com/bilal.ahmed" },
            text: "I am new to this too.",
            postedAt: "2026-11-06T09:10:00.000Z",
            postedAtLabel: "5d",
            replies: [
              {
                author: { name: "Ayesha Khan", url: "https://facebook.com/ayesha.khan" },
                text: "Welcome!",
                postedAt: "2026-11-11T05:43:00.000Z",
                postedAtLabel: "19h",
              },
            ],
          },
        ],
      }),
    );
    const r = parsePostDataJson(raw, createSeedState());
    expect(r.errors).toEqual([]);
    const c = r.drafts[0]!.comments[0]!;
    expect(c.postedAt).toBe("2026-11-06T09:10:00.000Z");
    expect(c.postedAtLabel).toBe("5d");
    expect(c.replies[0]!.postedAt).toBe("2026-11-11T05:43:00.000Z");
    expect(c.replies[0]!.postedAtLabel).toBe("19h");
  });

  it("defaults missing timestamps to null / empty label", () => {
    const r = parsePostDataJson(JSON.stringify(makePost()), createSeedState());
    const c = r.drafts[0]!.comments[0]!;
    expect(c.postedAt).toBeNull();
    expect(c.postedAtLabel).toBe("");
  });
});

describe("postTitle", () => {
  it("returns short text unchanged", () => {
    expect(postTitle({ text: "Should I start investing?" })).toBe("Should I start investing?");
  });

  it("truncates long text to ~60 chars with an ellipsis", () => {
    const text =
      "Planning to put fresh money into PSX before the year ends. Which sectors are you all watching for 2027?";
    const title = postTitle({ text });
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith("…")).toBe(true);
    expect(text.startsWith(title.slice(0, 60))).toBe(true);
  });
});

describe("scrapedCount", () => {
  it("counts collected posts per source", () => {
    const state = createSeedState();
    expect(scrapedCount(state, "src-1")).toBe(1);
    expect(scrapedCount(state, "src-4")).toBe(0);
  });
});

describe("mergePostActivity (Sync)", () => {
  const incoming = (overrides: Record<string, unknown> = {}) => ({
    postUrl: "https://facebook.com/groups/psxinvestorspk/posts/7781203344",
    author: { name: "Usman Tariq", url: "https://facebook.com/usman.tariq.pk" },
    text: "Planning to put fresh money into PSX before the year ends. Which sectors are you all watching for 2027 — banks, cement or fertiliser? Share your thinking below.",
    comments: [],
    sourceId: "src-1",
    ...overrides,
  });

  it("appends new comments and updates lastSyncedAt", () => {
    const state = createSeedState();
    const draft = incoming({
      comments: [
        {
          author: { name: "New Person", url: "" },
          text: "Fresh comment",
          postedAt: null,
          postedAtLabel: "2h",
          replies: [],
        },
      ],
    });
    const r = mergePostActivity(state, "post-1", draft, "2026-11-12T01:00:00.000Z");
    expect(r.addedComments).toBe(1);
    expect(r.addedReplies).toBe(0);
    expect(r.changed).toBe(true);
    const post = r.state.posts.find((p) => p.id === "post-1")!;
    expect(post.comments).toHaveLength(6);
    expect(post.lastSyncedAt).toBe("2026-11-12T01:00:00.000Z");
  });

  it("never duplicates a comment already present, but merges its new replies", () => {
    const state = createSeedState();
    const existing = state.posts.find((p) => p.id === "post-1")!.comments[0]!;
    const draft = incoming({
      comments: [
        {
          ...existing,
          replies: [
            ...existing.replies,
            { author: { name: "Someone Else", url: "" }, text: "New reply", postedAt: null, postedAtLabel: "1h" },
          ],
        },
      ],
    });
    const r = mergePostActivity(state, "post-1", draft, "2026-11-12T01:00:00.000Z");
    expect(r.addedComments).toBe(0);
    expect(r.addedReplies).toBe(1);
    // Re-merging the same data adds nothing.
    const r2 = mergePostActivity(r.state, "post-1", draft, "2026-11-12T01:05:00.000Z");
    expect(r2.addedComments).toBe(0);
    expect(r2.addedReplies).toBe(0);
    expect(r2.changed).toBe(false);
  });
});

describe("source jobs", () => {
  it("starts running, accepts a graceful stop flag, and finishes", () => {
    const state = createSeedState();
    expect(state.jobs).toEqual([]);
    const started = startSourceJob(state, {
      id: "job-1",
      kind: "scrape",
      sourceId: "src-1",
      postId: null,
      accountId: "acc-1",
      startedAt: "2026-11-12T01:00:00.000Z",
    });
    expect(started.state.jobs[0]!.status).toBe("running");
    expect(runningJobForSource(started.state, "src-1")?.id).toBe("job-1");
    // Stop is graceful: the flag is set, the job keeps running until the agent finishes the current post.
    const stopped = requestSourceJobStop(started.state, "job-1");
    expect(stopped.state.jobs[0]!.status).toBe("stop-requested");
    expect(runningJobForSource(stopped.state, "src-1")?.id).toBe("job-1");
    const done = updateSourceJob(stopped.state, "job-1", {
      status: "done",
      postsProcessed: 3,
      newPosts: 2,
      finishedAt: "2026-11-12T01:05:00.000Z",
    });
    expect(done.state.jobs[0]!.status).toBe("done");
    expect(runningJobForSource(done.state, "src-1")).toBeUndefined();
  });
});
