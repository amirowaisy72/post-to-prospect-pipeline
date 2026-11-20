import { Outlet, createFileRoute, useChildMatches } from "@tanstack/react-router";

import { PageHeader } from "@/components/page-header";
import { SourcesPanel } from "@/components/sourcing-panel";

export const Route = createFileRoute("/data-sourcing")({
  head: () => ({
    meta: [
      { title: "Data Sourcing — LeadHunter" },
      { name: "description", content: "Find Facebook groups and pages, and the posts collected from them." },
      { property: "og:title", content: "Data Sourcing — LeadHunter" },
      { property: "og:description", content: "Find Facebook groups and pages, and the posts collected from them." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DataSourcingPage,
});

function DataSourcingPage() {
  // The per-source posts page and the post detail page are nested
  // routes: when one matches, it REPLACES the sources table.
  const childMatches = useChildMatches();
  if (childMatches.length > 0) return <Outlet />;

  return (
    <>
      <PageHeader
        title="Data Sourcing"
        description="Groups and pages found by the agent, and the posts scraped from them."
      />
      <div className="space-y-6">
        <SourcesPanel />
      </div>
    </>
  );
}
