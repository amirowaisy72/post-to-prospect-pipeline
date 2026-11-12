import { Link, useRouterState } from "@tanstack/react-router";
import {
  Bot,
  BrainCircuit,
  Crosshair,
  Database,
  Inbox,
  LayoutDashboard,
  Settings,
  Star,
  Users,
  UserSearch,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useActiveAccountData } from "@/lib/store";

const workflow = [
  { title: "Dashboard", url: "/", icon: LayoutDashboard },
  { title: "Accounts", url: "/accounts", icon: Users },
  { title: "Data Sourcing", url: "/data-sourcing", icon: Database },
  { title: "AI Analysis", url: "/analysis", icon: BrainCircuit },
  { title: "Inbox", url: "/inbox", icon: Inbox },
  { title: "Agent Control", url: "/agent-control", icon: Bot },
  { title: "Leads", url: "/leads", icon: UserSearch },
  { title: "Shortlisted", url: "/shortlisted", icon: Star },
] as const;

export function AppSidebar() {
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  const { leads, threads } = useActiveAccountData();
  const newLeads = leads.filter((l) => l.status === "new").length;
  const shortlisted = leads.filter((l) => l.status === "shortlisted").length;
  const activeChats = threads.filter((t) => t.status === "active").length;

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border">
        <Link to="/" className="flex items-center gap-2.5 px-1.5 py-1.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
            <Crosshair className="size-4" strokeWidth={2.5} />
          </span>
          <span className="flex flex-col leading-tight group-data-[collapsible=icon]:hidden">
            <span className="text-sm font-extrabold tracking-tight text-sidebar-accent-foreground">
              LeadHunter
            </span>
            <span className="text-[11px] text-sidebar-muted">Source · Analyse · Shortlist</span>
          </span>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="text-sidebar-muted">Workflow</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {workflow.map((item) => (
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton asChild isActive={pathname === item.url} tooltip={item.title}>
                    <Link to={item.url}>
                      <item.icon />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                  {item.url === "/leads" && newLeads > 0 && (
                    <SidebarMenuBadge>{newLeads}</SidebarMenuBadge>
                  )}
                  {item.url === "/inbox" && activeChats > 0 && (
                    <SidebarMenuBadge>{activeChats}</SidebarMenuBadge>
                  )}
                  {item.url === "/shortlisted" && shortlisted > 0 && (
                    <SidebarMenuBadge>{shortlisted}</SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={pathname === "/configurations"}
              tooltip="Configurations"
            >
              <Link to="/configurations">
                <Settings />
                <span>Configurations</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
