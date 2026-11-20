import { Link, createFileRoute } from "@tanstack/react-router";
import { Download, ExternalLink } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { EmptyState, PageHeader } from "@/components/page-header";
import { JobBanner, useLiveJob } from "@/components/sourcing-shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtDate, shortUrl } from "@/lib/format";
import { getAgentPost, startSync, type FullPost } from "@/lib/sourcing-client";
import { useStore } from "@/lib/store";

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
  const { state } = useStore();
  const agentUrl = state.settings.agentUrl;
  const { job, doneTick, refresh } = useLiveJob();
  const [post, setPost] = useState<FullPost | null>(null);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    const r = await getAgentPost(agentUrl, postId);
    if (r.ok) {
      setPost(r.value.post);
      setMissing(false);
    } else if (r.error.includes("unknown post")) setMissing(true);
  }, [agentUrl, postId]);

  useEffect(() => {
    void load();
  }, [load, doneTick]);

  const back = (
    <Link to="/data-sourcing/$sourceId" params={{ sourceId }} className="text-sm font-medium text-primary hover:underline">
      ← Back to scraped posts
    </Link>
  );

  if (!post) {
    return (
      <>
        <PageHeader
          title={missing ? "Post not found" : "Loading…"}
          description={missing ? "Ye post ab data mein nahi hai." : "Agent se post la raha hoon."}
        />
        {back}
      </>
    );
  }

  const totalReplies = post.comments.reduce((n, c) => n + c.replies.length, 0);

  const sync = async () => {
    const r = await startSync(agentUrl, { accountId: state.activeAccountId, postId: post.id, postUrl: post.postUrl });
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    toast.success("Sync shuru ho gaya");
    refresh();
  };

  const downloadJson = () => {
    const blob = new Blob([JSON.stringify(post, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `post-${post.id}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <PageHeader
        title="Post detail"
        description={`${post.comments.length} comments, ${totalReplies} replies — collected ${fmtDate(post.collectedAt)}${post.lastSyncedAt ? `, last synced ${fmtDate(post.lastSyncedAt)}` : ""}.`}
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {back}
        <Button size="sm" variant="outline" disabled={!!job} onClick={() => void sync()}>Sync</Button>
        <Button size="sm" variant="outline" onClick={downloadJson}>
          <Download /> JSON
        </Button>
      </div>
      <JobBanner job={job} />

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
              <a href={post.postUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-primary">
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
              Facebook jis tarteeb mein dikhata hai usi tarteeb mein. Waqt exact hai jab Facebook deta hai, warna label (jaise 5d) approximate.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {post.comments.length === 0 ? (
              <EmptyState title="Is post ke comments abhi collect nahi hue" />
            ) : (
              <div className="space-y-5">
                {post.comments.map((c, ci) => (
                  <div key={`${ci}-${c.author.name}`} className="space-y-2">
                    <div>
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="font-semibold text-foreground">{c.author.name}</span>
                        {c.postedAtLabel && (
                          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">{c.postedAtLabel}</span>
                        )}
                        {c.postedAt && <span className="text-xs text-muted-foreground">{fmtDate(c.postedAt)}</span>}
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
                            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">{r.postedAtLabel}</span>
                          )}
                          {r.postedAt && <span className="text-xs text-muted-foreground">{fmtDate(r.postedAt)}</span>}
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
