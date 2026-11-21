import { Link, Outlet, createFileRoute, useChildMatches } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { EmptyState, PageHeader } from "@/components/page-header";
import { JobBanner, useLiveJob } from "@/components/sourcing-shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtDate } from "@/lib/format";
import { listSourcePosts, startSync, type PostSummary } from "@/lib/sourcing-client";
import { useStore } from "@/lib/store";

export const Route = createFileRoute("/data-sourcing/$sourceId")({
  head: () => ({
    meta: [
      { title: "Scraped Posts — LeadHunter" },
      { name: "description", content: "Posts scraped from one source, with their comments and replies." },
      { property: "og:title", content: "Scraped Posts — LeadHunter" },
    ],
  }),
  component: SourcePostsPage,
});

const PAGE_SIZE = 20;

function SourcePostsPage() {
  // Hooks first, always — the child check returns early.
  const childMatches = useChildMatches();
  const { sourceId } = Route.useParams();
  const { state } = useStore();
  const agentUrl = state.settings.agentUrl;
  const { job, doneTick, refresh } = useLiveJob();
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [posts, setPosts] = useState<PostSummary[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const r = await listSourcePosts(agentUrl, sourceId, page * PAGE_SIZE, PAGE_SIZE);
    if (r.ok) {
      setTotal(r.value.total);
      setPosts(r.value.posts);
    }
    setLoaded(true);
  }, [agentUrl, sourceId, page]);

  useEffect(() => {
    void load();
  }, [load, doneTick]);
  useEffect(() => {
    if (!job) return;
    const t = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(t);
  }, [job, load]);

  if (childMatches.length > 0) return <Outlet />;

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const sync = async (p: PostSummary) => {
    const r = await startSync(agentUrl, {
      accountId: state.activeAccountId,
      postId: p.id,
      postUrl: p.postUrl,
    });
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    toast.success("Sync started");
    refresh();
  };

  return (
    <>
      <PageHeader
        title="Scraped posts"
        description="All scraped posts from this source. Click a post to see the full data and comments."
      />
      <div className="mb-4">
        <Link to="/data-sourcing" className="text-sm font-medium text-primary hover:underline">
          ← Back to Data Sourcing
        </Link>
      </div>
      <Card className="shadow-card">
        <CardHeader>
          <CardTitle className="text-base">{total} post{total === 1 ? "" : "s"}</CardTitle>
          <CardDescription>For new posts, click “Scrap” on the Data Sourcing page.</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <JobBanner job={job} />
          {loaded && posts.length === 0 ? (
            <div className="px-6">
              <EmptyState title="No posts scraped from this source yet" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Post</TableHead>
                  <TableHead>Author</TableHead>
                  <TableHead className="text-right">Comments</TableHead>
                  <TableHead className="text-right">Replies</TableHead>
                  <TableHead>Collected</TableHead>
                  <TableHead>Last synced</TableHead>
                  <TableHead className="pr-6">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {posts.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="pl-6">
                      <Link
                        to="/data-sourcing/$sourceId/$postId"
                        params={{ sourceId, postId: p.id }}
                        className="font-medium text-primary hover:underline"
                      >
                        Open post
                      </Link>
                      <div className="line-clamp-2 max-w-md text-sm text-muted-foreground">{p.text}</div>
                    </TableCell>
                    <TableCell className="text-sm">{p.author.name}</TableCell>
                    <TableCell className="text-right tabular">{p.commentCount}</TableCell>
                    <TableCell className="text-right tabular">{p.replyCount}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{fmtDate(p.collectedAt)}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{fmtDate(p.lastSyncedAt)}</TableCell>
                    <TableCell className="pr-6">
                      <Button size="sm" variant="outline" disabled={!!job} onClick={() => void sync(p)}>
                        Sync
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between px-6 pt-4 text-sm">
              <span className="text-muted-foreground">Page {page + 1} / {pages}</span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((n) => n - 1)}>
                  Previous
                </Button>
                <Button size="sm" variant="outline" disabled={page + 1 >= pages} onClick={() => setPage((n) => n + 1)}>
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
