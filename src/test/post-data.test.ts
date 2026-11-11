import { describe, expect, it } from "vitest";

import { addCollectedSources, addPosts, createAccount, mergePostActivity, parsePostDataJson, postTitle, requestSourceJobStop, runningJobForSource, scrapedCount, startSourceJob, updateSourceJob } from "@/lib/leadhunter-service";
import { createSeedState } from "@/lib/seed";
import type { AppState } from "@/lib/types";

const NOW = "2026-11-11T00:00:00.000Z";
const POST_URL = "https://facebook.com/groups/psxinvestorspk/posts/7781203344";
const POST_TEXT =
  "Planning to put fresh money into PSX before the year ends. Which sectors are you all watching for 2027 — banks, cement or fertiliser? Share your thinking below.";

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

/** One account + one joined source + one collected post (5 comments,
 * first comment with 2 replies), built only through the service —
 * the seed state itself is empty. */
const fixtureState = (): AppState => {
  let state = createSeedState();
  const acc = createAccount(state, { name: "Ayesha — Main", facebookName: "Ayesha Khan" }, "acc-1", NOW);
  if (!acc.ok) throw new Error("fixture account failed");
  state = acc.value;
  state = addCollectedSources(
    state,
    [{ id: "src-1", name: "PSX Investors Pakistan", type: "group", url: "https://facebook.com/groups/psxinvestorspk", memberCount: 184300, joinedByAccountId: "acc-1" }],
    "acc-1",
    NOW,
  ).state;
  const parsed = parsePostDataJson(
    JSON.stringify(
      makePost({
        postUrl: POST_URL,
        author: { name: "Usman Tariq", url: "https://facebook.com/usman.tariq.pk" },
        text: POST_TEXT,
        comments: [
          {
            author: { name: "Sana Mirza", url: "https://facebook.com/sana.mirza.88" },
            text: "I just sold a plot in DHA and have around 2 crore sitting in my account. Completely new to stocks though — where do I even start?",
            replies: [
              { author: { name: "Usman Tariq", url: "https://facebook.com/usman.tariq.pk" }, text: "Start with a broker account and blue chips, Sana." },
              { author: { name: "Sana Mirza", url: "https://facebook.com/sana.mirza.88" }, text: "Thanks! Is 2 crore too much to put in at once?" },
            ],
          },
          {
            author: { name: "Hamza Qureshi", url: "https://facebook.com/hamza.qureshi.lhr" },
            text: "Been investing in PSX for 6 years, my portfolio is mostly banks and OGDC. Recently exited a textile business so I have extra cash to diversify.",
            replies: [],
          },
          {
            author: { name: "Signals King PK", url: "https://facebook.com/signalskingpk" },
            text: "Join my Telegram channel for daily guaranteed signals 💯 t.me/signalsking",
            replies: [{ author: { name: "Faraz Ali", url: "https://facebook.com/faraz.ali.khi" }, text: "Reported. Stop spamming please." }],
          },
          {
            author: { name: "Nida Hassan", url: "https://facebook.com/nida.hassan.lhr" },
            text: "My husband and I run two pharmacies in Lahore. Never invested before but want our savings working. Is PSX safe for beginners?",
            replies: [{ author: { name: "Kamran Shah", url: "https://facebook.com/kamran.shah.isb" }, text: "I have held mutual funds and stocks for 10 years, PSX is fine if you stay diversified." }],
          },
          {
            author: { name: "Ali Raza", url: "https://facebook.com/ali.raza.2004" },
            text: "Where do I start? Just graduated, total beginner.",
            replies: [],
          },
        ],
      }),
    ),
    state,
  );
  if (parsed.errors.length > 0) throw new Error("fixture post failed: " + JSON.stringify(parsed.errors));
  state = addPosts(state, parsed.drafts, "src-1", "acc-1", () => "post-1", NOW).state;
  return state;
};

describe("parsePostDataJson", () => {
  it("parses a single PostData object", () => {
    const r = parsePostDataJson(JSON.stringify(makePost()), createSeedState());
    expect(r.errors).toEqual([]);
    expect(r.alreadyCollected).toEqual([]);
    expect(r.drafts).toHaveLength(1);
    expect(r.drafts[0]!.postUrl).toBe("https://facebook.com/groups/psxinvestorspk/posts/111");
    expect(r.drafts[0]!.author.name).toBe("Ayesha Khan");
  });

  it("parses a post with two comments and a nested reply", () => {
    const raw = JSON.stringify({
      postUrl: "https://facebook.com/groups/psxinvestorspk/posts/7790045512",
      author: { name: "Kashif Mehmood", url: "https://facebook.com/kashif.mehmood.pk" },
      text: "Got my bonus this month. Should I go for gold, PSX or a savings certificate?",
      comments: [
        {
          author: { name: "Farah Jamil", url: "https://facebook.com/farah.jamil.khi" },
          text: "We sold my father's factory last month and I'm completely new to this. Where do I start with PSX?",
          replies: [
            {
              author: { name: "Imran Butt", url: "https://facebook.com/imran.butt.isb" },
              text: "Been investing for 8 years, my portfolio is 60% banks. Also own two rental apartments in Bahria.",
            },
          ],
        },
        {
          author: { name: "Quick Profit Club", url: "https://facebook.com/quickprofitclub" },
          text: "Join my WhatsApp for guaranteed 5% weekly profit!!",
          replies: [],
        },
      ],
    });
    const r = parsePostDataJson(raw, createSeedState());
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
    const state = fixtureState();
    const existingUrl = state.posts[0]!.postUrl;
    const r = parsePostDataJson(JSON.stringify(makePost({ postUrl: existingUrl })), state);
    expect(r.drafts).toEqual([]);
    expect(r.alreadyCollected).toHaveLength(1);
    expect(r.alreadyCollected[0]!.postUrl).toBe(existingUrl);
    expect(r.alreadyCollected[0]!.accountName).toBe("Ayesha — Main");
  });

  it("allowExisting returns an already-collected post as a draft (Sync re-import)", () => {
    const state = fixtureState();
    const existingUrl = state.posts[0]!.postUrl;
    const r = parsePostDataJson(JSON.stringify(makePost({ postUrl: existingUrl })), state, { allowExisting: true });
    expect(r.drafts).toHaveLength(1);
    expect(r.alreadyCollected).toEqual([]);
  });
});

describe("addPosts batch import", () => {
  it("imports only the new posts and skips already-collected ones", () => {
    const state = fixtureState();
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
    const state = fixtureState();
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
    const state = fixtureState();
    expect(scrapedCount(state, "src-1")).toBe(1);
    expect(scrapedCount(state, "src-4")).toBe(0);
  });
});

describe("mergePostActivity (Sync)", () => {
  const incoming = (overrides: Record<string, unknown> = {}) => ({
    postUrl: POST_URL,
    author: { name: "Usman Tariq", url: "https://facebook.com/usman.tariq.pk" },
    text: POST_TEXT,
    comments: [],
    sourceId: "src-1",
    ...overrides,
  });

  it("appends new comments and updates lastSyncedAt", () => {
    const state = fixtureState();
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
    const state = fixtureState();
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

  it("a collect job carries the joined sources on its result", () => {
    const state = createSeedState();
    const started = startSourceJob(state, {
      id: "job-collect",
      kind: "collect",
      sourceId: null,
      postId: null,
      accountId: "acc-1",
      startedAt: "2026-11-12T01:00:00.000Z",
    });
    expect(started.state.jobs[0]!.kind).toBe("collect");
    const done = updateSourceJob(started.state, "job-collect", {
      status: "done",
      newPosts: 2,
      result: {
        sources: [
          { id: "src-a", name: "Stocks To Watch", type: "group", url: "https://facebook.com/groups/111", memberCount: 12000, joinedByAccountId: "acc-1" },
        ],
      },
    });
    expect(done.state.jobs[0]!.result?.sources).toHaveLength(1);
    expect(done.state.jobs[0]!.result?.sources[0]!.name).toBe("Stocks To Watch");
  });
});
