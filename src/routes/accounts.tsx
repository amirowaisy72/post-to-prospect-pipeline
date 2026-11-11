import { createFileRoute } from "@tanstack/react-router";
import { Plus, Star } from "lucide-react";
import { useState } from "react";

import { AgentStatusTag } from "@/components/agent-status";
import { AccountStatusBadge } from "@/components/badges";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { accountStats } from "@/lib/leadhunter-service";
import { fmtDate } from "@/lib/format";
import { useStore } from "@/lib/store";
import type { AccountStatus } from "@/lib/types";

export const Route = createFileRoute("/accounts")({
  head: () => ({
    meta: [
      { title: "Accounts — LeadHunter" },
      { name: "description", content: "Create and manage the Facebook accounts LeadHunter works with." },
      { property: "og:title", content: "Accounts — LeadHunter" },
      { property: "og:description", content: "Create and manage the Facebook accounts LeadHunter works with." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AccountsPage,
});

function AccountsPage() {
  const { state, createAccount, setAccountStatus, setDefaultAccount, setActiveAccount } = useStore();
  const [name, setName] = useState("");
  const [facebookName, setFacebookName] = useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (createAccount({ name, facebookName })) {
      setName("");
      setFacebookName("");
    }
  };

  return (
    <>
      <PageHeader
        title="Accounts"
        description="Each account owns its own sources, collected posts and leads. Switch accounts from the top bar."
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="h-fit shadow-card">
          <CardHeader>
            <CardTitle className="text-base">New account</CardTitle>
            <CardDescription>Add as many as you need.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="acc-name">Account name</Label>
                <Input id="acc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sara — Outreach" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="acc-fb">Facebook profile name</Label>
                <Input id="acc-fb" value={facebookName} onChange={(e) => setFacebookName(e.target.value)} placeholder="e.g. Sara Malik" />
              </div>
              <Button type="submit" className="w-full" disabled={!name.trim() || !facebookName.trim()}>
                <Plus /> Create account
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card className="shadow-card lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">All accounts ({state.accounts.length})</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Account</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead className="text-right">Sources</TableHead>
                  <TableHead className="text-right">Posts</TableHead>
                  <TableHead className="text-right">Leads</TableHead>
                  <TableHead className="pr-6 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.accounts.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="pl-6 py-6 text-sm text-muted-foreground">
                      No accounts yet — create your first account on the left.
                    </TableCell>
                  </TableRow>
                ) : (
                  state.accounts.map((a) => {
                  const s = accountStats(state, a.id);
                  const isDefault = a.id === state.defaultAccountId;
                  const isActive = a.id === state.activeAccountId;
                  return (
                    <TableRow key={a.id} className={isActive ? "bg-accent/50" : undefined}>
                      <TableCell className="pl-6">
                        <div className="flex items-center gap-1.5 font-semibold text-foreground">
                          {a.name}
                          {isDefault && (
                            <span className="inline-flex items-center gap-0.5 text-xs font-semibold text-primary">
                              <Star className="size-3 fill-current" /> Default
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {a.facebookName} · since {fmtDate(a.createdAt).split(",")[0]}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <AccountStatusBadge status={a.status} />
                          <Select value={a.status} onValueChange={(v) => setAccountStatus(a.id, v as AccountStatus)}>
                            <SelectTrigger className="h-7 w-[92px] text-xs" aria-label={`Change status of ${a.name}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="active">Active</SelectItem>
                              <SelectItem value="paused">Paused</SelectItem>
                              <SelectItem value="blocked">Blocked</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </TableCell>
                      <TableCell>
                        <AgentStatusTag accountId={a.id} />
                      </TableCell>
                      <TableCell className="text-right tabular">{s.sources}</TableCell>
                      <TableCell className="text-right tabular">{s.posts}</TableCell>
                      <TableCell className="text-right tabular">{s.leads}</TableCell>
                      <TableCell className="pr-6">
                        <div className="flex justify-end gap-1.5">
                          <Button size="sm" variant={isActive ? "secondary" : "outline"} disabled={isActive} onClick={() => setActiveAccount(a.id)}>
                            {isActive ? "Active" : "Switch"}
                          </Button>
                          <Button size="sm" variant="ghost" disabled={isDefault} onClick={() => setDefaultAccount(a.id)}>
                            Set default
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                  })
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
