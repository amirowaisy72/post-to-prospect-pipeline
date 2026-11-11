import { Link } from "@tanstack/react-router";
import { Star } from "lucide-react";

import { AgentDot, AgentStatusIndicator } from "@/components/agent-status";
import { AccountStatusBadge } from "@/components/badges";
import { ThemeToggle } from "@/components/theme-toggle";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { agentStatus } from "@/lib/leadhunter-service";
import { useStore } from "@/lib/store";

export function AppHeader() {
  const { state, activeAccount, setActiveAccount } = useStore();

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b bg-card/90 px-3 backdrop-blur sm:px-5">
      <SidebarTrigger />
      <div className="h-5 w-px bg-border" />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="hidden text-xs font-semibold uppercase tracking-wider text-muted-foreground lg:inline">
          Working as
        </span>
        <Select value={state.activeAccountId} onValueChange={setActiveAccount}>
          <SelectTrigger className="h-9 w-[210px] min-w-0 max-w-full bg-card font-semibold" aria-label="Active account">
            <SelectValue placeholder="Pick account" />
          </SelectTrigger>
          <SelectContent>
            {state.accounts.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                <span className="flex items-center gap-2">
                  <AgentDot status={agentStatus(state, a.id)} className="size-2" />
                  {a.name}
                  {a.id === state.defaultAccountId && <Star className="size-3 fill-current text-primary" />}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {activeAccount && (
          <span className="hidden items-center gap-2 2xl:flex">
            <AccountStatusBadge status={activeAccount.status} />
            <span className="text-xs text-muted-foreground">as {activeAccount.facebookName}</span>
          </span>
        )}
        <AgentStatusIndicator />
      </div>
      <Link to="/accounts" className="hidden text-xs font-semibold text-primary hover:underline md:inline">
        Manage accounts
      </Link>
      <ThemeToggle />
    </header>
  );
}
