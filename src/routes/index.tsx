import { createFileRoute, Link } from "@tanstack/react-router";
import { BrainCircuit, Database, Download, FileText, MessageSquare, RefreshCw, Send, Star, UserPlus, UserSearch, Users, X } from "lucide-react";

import { AccountStatusBadge } from "@/components/badges";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { accountName, accountStats, totals } from "@/lib/leadhunter-service";
import { fmtAgo } from "@/lib/format";
import { useStore } from "@/lib/store";
import type { ActivityType } from "@/lib/types";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Dashboard — LeadHunter" },
      { name: "description", content: "Totals across all accounts: sources, collected posts, leads and shortlisted candidates." },
      { property: "og:title", content: "Dashboard — LeadHunter" },
      { property: "og:description", content: "Totals across all accounts: sources, collected posts, leads and shortlisted candidates." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Dashboard,
});

const ACTIVITY_ICON: Record<ActivityType, typeof Users> = {
  "account-created": UserPlus,
  "source-added": Database,
  "source-collected": Database,
  "source-deleted": X,
  "source-joined": Database,
  "post-collected": FileText,
  "analysis-finished": BrainCircuit,
  "lead-shortlisted": Star,
  "lead-rejected": X,
  "source-scraped": Download,
  "source-synced": RefreshCw,
  "chat-started": Send,
  "chat-reply": MessageSquare,
};

function Dashboard() {
  const { state, setActiveAccount } = useStore();
  const t = totals(state);
  const kpis = [
    { label: "Accounts", value: t.accounts, icon: Users, to: "/accounts" },
    { label: "Sources", value: t.sources, icon: Database, to: "/data-sourcing" },
    { label: "Collected Posts", value: t.posts, icon: FileText, to: "/data-sourcing" },
    { label: "Leads", value: t.leads, icon: UserSearch, to: "/leads" },
    { label: "Shortlisted", value: t.shortlisted, icon: Star, to: "/shortlisted" },
  ] as const;

  return (
    <>
      <PageHeader title="Dashboard" description="Totals across all accounts. Other pages show only the account picked at the top." />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {kpis.map((k, i) => (
          <Link key={k.label} to={k.to} className="group">
            <Card className="h-full shadow-card transition-shadow group-hover:shadow-raised">
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{k.label}</span>
                  <k.icon className={i === 4 ? "size-4 text-primary" : "size-4 text-muted-foreground"} />
                </div>
                <div className="mt-3 text-3xl font-extrabold tabular text-foreground">{k.value}</div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-5">
        <Card className="shadow-card lg:col-span-3">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Per-account summary</CardTitle>
          </CardHeader>
          <CardContent className="px-0 pb-2">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Account</TableHead>
                  <TableHead className="text-right">Sources</TableHead>
                  <TableHead className="text-right">Posts</TableHead>
                  <TableHead className="text-right">Leads</TableHead>
                  <TableHead className="pr-6 text-right">Shortlisted</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.accounts.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="pl-6 py-6 text-sm text-muted-foreground">
                      No accounts yet — <Link to="/accounts" className="font-medium text-primary hover:underline">create your first account</Link>, then add sources.
                    </TableCell>
                  </TableRow>
                ) : (
                  state.accounts.map((a) => {
                  const s = accountStats(state, a.id);
                  return (
                    <TableRow key={a.id}>
                      <TableCell className="pl-6">
                        <button
                          type="button"
                          onClick={() => setActiveAccount(a.id)}
                          className="text-left font-semibold text-foreground hover:text-primary"
                          title="Switch to this account"
                        >
                          {a.name}
                        </button>
                        <div className="mt-1 flex items-center gap-2">
                          <AccountStatusBadge status={a.status} />
                          {a.id === state.activeAccountId && <span className="text-xs text-primary">● Active</span>}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular">{s.sources}</TableCell>
                      <TableCell className="text-right tabular">{s.posts}</TableCell>
                      <TableCell className="text-right tabular">{s.leads}</TableCell>
                      <TableCell className="pr-6 text-right tabular font-semibold">{s.shortlisted}</TableCell>
                    </TableRow>
                  );
                  })
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="shadow-card lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Recent activity</CardTitle>
          </CardHeader>
          <CardContent>
            {state.activity.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing yet — activity appears here as you work.</p>
            ) : (
              <ol className="relative space-y-4 border-l pl-5">
              {state.activity.slice(0, 8).map((e) => {
                const Icon = ACTIVITY_ICON[e.type];
                return (
                  <li key={e.id} className="relative">
                    <span className="absolute -left-[31px] grid size-5 place-items-center rounded-full border bg-card">
                      <Icon className="size-3 text-primary" />
                    </span>
                    <p className="text-sm font-medium text-foreground">{e.message}</p>
                    <p className="text-xs text-muted-foreground">
                      {accountName(state, e.accountId)} · {fmtAgo(e.at)}
                    </p>
                  </li>
                );
              })}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
