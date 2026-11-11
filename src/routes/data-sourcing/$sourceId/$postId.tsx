import { Link, createFileRoute } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";

import { EmptyState, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AGENT_NOT_RUNNING_MESSAGE } from "@/lib/agent-client";
import { fmtDate, shortUrl } from "@/lib/format";
import { countReplies, postTitle, runningJobForPost } from "@/lib/leadhunter-service";
import { useStore } from "@/lib/store";
import { useAgentHealth } from "@/lib/use-agent-health";

export const Route = createFileRoute("/data-sourcing/$sourceId/$postId")({
  head: () => ({
    meta: [
      { title: "Post detail — LeadHunter" },
      { name: "description", content: "One scraped Facebook post with its full comments and replies." },
      { property: "og:title", content: "Post detail — LeadHunter" },
    ],
  }),
  component: PostDetailPage,
});

function PostDetailPage() {
  const { sourceId, postId } = Route.useParams();
  const { state, startPostSync, stopJob } = useStore();
  const { reachable } = useAgentHealth();
  const source = state.sources.find((s) => s.id === sourceId);
  const post = state.posts.find((p) => p.id === postId && p.sourceId === sourceId);
  const job = runningJobForPost(state, postId);

  if (!post) {
    return (
      <>
        <PageHeader title="Post not found" description="This post is no longer in the collected data." />
        <Link
          to="/data-sourcing/$sourceId"
          params={{ sourceId }}
          className="text-sm font-medium text-primary hover:underline"
        >
          ← Back to scraped posts
        </Link>
      </>
    );
  }

  const agentDown = reachable === false;
  const totalReplies = countReplies(post);

  return (
    <>
      <PageHeader
        title={`Post ${postTitle(post)}`}
        description={`${post.comments.length} comments, ${totalReplies} replies — collected ${fmtDate(post.collectedAt)}${post.lastSyncedAt ? `, last synced ${fmtDate(post.lastSyncedAt)}` : ""}.`}
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Link
          to="/data-sourcing/$sourceId"
          params={{ sourceId }}
          className="text-sm font-medium text-primary hover:underline"
        >
          ← Back to {source?.name ?? "scraped posts"}
        </Link>
        {job ? (
          <>
            <span className="text-sm text-muted-foreground">
              Syncing… {job.postsProcessed} processed, {job.newPosts} new
            </span>
            <Button variant="outline" size="sm" onClick={() => void stopJob(job.id)}>
              Stop
            </Button>
          </>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={agentDown}
            title={agentDown ? AGENT_NOT_RUNNING_MESSAGE : undefined}
            onClick={() => void startPostSync(postId)}
          >
            Sync this post
          </Button>
        )}
      </div>

      <div className="space-y-6">
        <Card className="shadow-card">
          <CardHeader>
            <CardTitle className="text-base">Post</CardTitle>
            <CardDescription>
              By {post.author.name}
              {post.author.url ? (
                <>
                  {" — "}
                  <a href={post.author.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                    {shortUrl(post.author.url)}
                  </a>
                </>
              ) : null}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{post.text}</p>
            {post.postUrl && (
              <a
                href={post.postUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-primary"
              >
                Original post: {shortUrl(post.postUrl)} <ExternalLink className="size-3" />
              </a>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-card">
          <CardHeader>
            <CardTitle className="text-base">
              Comments ({post.comments.length}) · Replies ({totalReplies})
            </CardTitle>
            <CardDescription>
              Timestamps are the exact time when Facebook exposes it, otherwise the visible label
              computed against collection time (approximate).
            </CardDescription>
          </CardHeader>
          <CardContent>
            {post.comments.length === 0 ? (
              <EmptyState title="No comments collected for this post yet" />
            ) : (
              <div className="space-y-5">
                {post.comments.map((c, ci) => (
                  <div key={`${ci}-${c.author.name}`} className="space-y-2">
                    <div>
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="font-semibold text-foreground">{c.author.name}</span>
                        {c.postedAtLabel && (
                          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                            {c.postedAtLabel}
                          </span>
                        )}
                        {c.postedAt && (
                          <span className="text-xs text-muted-foreground">{fmtDate(c.postedAt)}</span>
                        )}
                        {c.author.url && (
                          <a href={c.author.url} target="_blank" rel="noreferrer" className="font-mono text-xs text-muted-foreground hover:text-primary">
                            {shortUrl(c.author.url)}
                          </a>
                        )}
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">{c.text}</p>
                    </div>
                    {c.replies.map((r, ri) => (
                      <div key={`${ri}-${r.author.name}`} className="ml-6 border-l-2 border-muted pl-4">
                        <div className="flex flex-wrap items-baseline gap-2">
                          <span className="font-semibold text-foreground">{r.author.name}</span>
                          <span className="text-xs text-muted-foreground">Reply</span>
                          {r.postedAtLabel && (
                            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                              {r.postedAtLabel}
                            </span>
                          )}
                          {r.postedAt && (
                            <span className="text-xs text-muted-foreground">{fmtDate(r.postedAt)}</span>
                          )}
                          {r.author.url && (
                            <a href={r.author.url} target="_blank" rel="noreferrer" className="font-mono text-xs text-muted-foreground hover:text-primary">
                              {shortUrl(r.author.url)}
                            </a>
                          )}
                        </div>
                        <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">{r.text}</p>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
