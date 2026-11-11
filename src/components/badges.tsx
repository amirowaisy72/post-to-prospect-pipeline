import { Badge } from "@/components/ui/badge";
import type { AccountStatus, LeadPriority, LeadStatus, SourceStatus } from "@/lib/types";

export const PRIORITY_LABEL: Record<LeadPriority, string> = {
  "rich-beginner": "Rich Beginner",
  "rich-experienced": "Rich Experienced",
  other: "Other",
};

export function PriorityBadge({ priority }: { priority: LeadPriority }) {
  const variant = priority === "rich-beginner" ? "success" : priority === "rich-experienced" ? "info" : "neutral";
  return <Badge variant={variant}>{PRIORITY_LABEL[priority]}</Badge>;
}

export function AccountStatusBadge({ status }: { status: AccountStatus }) {
  const variant = status === "active" ? "success" : status === "paused" ? "warning" : "danger";
  return (
    <Badge variant={variant} className="capitalize">
      <span className="size-1.5 rounded-full bg-current" />
      {status}
    </Badge>
  );
}

export function SourceStatusBadge({ status }: { status: SourceStatus }) {
  return status === "joined" ? <Badge variant="success">Joined</Badge> : <Badge variant="neutral">Not joined</Badge>;
}

export function LeadStatusBadge({ status }: { status: LeadStatus }) {
  const variant = status === "shortlisted" ? "accent" : status === "rejected" ? "danger" : "outline";
  return (
    <Badge variant={variant} className="capitalize">
      {status}
    </Badge>
  );
}
