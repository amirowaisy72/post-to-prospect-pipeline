import { Link, Outlet, createFileRoute, useChildMatches } from "@tanstack/react-router";

import { EmptyState, PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtDate } from "@/lib/format";
import { countReplies, postTitle, postsForSource } from "@/lib/leadhunter-service";
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

function SourcePostsPage() {
  // Hooks first, always — the child check below returns early, and a
  // return before these hooks would render fewer hooks on the next
  // navigation and crash React ("Rendered fewer hooks than expected").
  const childMatches = useChildMatches();
  const { sourceId } = Route.useParams();
  const { state } = useStore();
  // The post detail page (/data-sourcing/$sourceId/$postId) is a
  // nested route: when it matches, it REPLACES this list instead of
  // rendering underneath it.
  if (childMatches.length > 0) return <Outlet />;

  const source = state.sources.find((s) => s.id === sourceId);
  const posts = postsForSource(state, sourceId);

  if (!source) {
    return (
      <>
        <PageHeader title="Source not found" description="This source is no longer in the list." />
        <Link to="/data-sourcing" className="text-sm font-medium text-primary hover:underline">
          ← Back to Data Sourcing
        </Link>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={`Scraped posts — ${source.name}`}
        description="Every post collected from this source. Open one for the full data and its original URL."
      />
      <div className="mb-4">
        <Link to="/data-sourcing" className="text-sm font-medium text-primary hover:underline">
          ← Back to Data Sourcing
        </Link>
      </div>
      <Card className="shadow-card">
        <CardHeader>
          <CardTitle className="text-base">{posts.length} post{posts.length === 1 ? "" : "s"}</CardTitle>
          <CardDescription>
            Posts collected from this source. Post collection is done by the browser extension (coming soon).
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {posts.length === 0 ? (
            <div className="px-6">
              <EmptyState title="No posts collected from this source yet">
                Posts will appear here once the extension import lands.
              </EmptyState>
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
                  <TableHead className="pr-6">Last synced</TableHead>
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
                        Post {postTitle(p)}
                      </Link>
                      <div className="line-clamp-2 max-w-md text-sm text-muted-foreground">{p.text}</div>
                    </TableCell>
                    <TableCell className="text-sm">{p.author.name}</TableCell>
                    <TableCell className="text-right tabular">{p.comments.length}</TableCell>
                    <TableCell className="text-right tabular">{countReplies(p)}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{fmtDate(p.collectedAt)}</TableCell>
                    <TableCell className="whitespace-nowrap pr-6 text-sm text-muted-foreground">{fmtDate(p.lastSyncedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
