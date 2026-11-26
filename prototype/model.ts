export type Role = "support" | "reviewer" | "viewer";

export type Priority = "normal" | "high";

export type Decision = "allow" | "deny" | "approval";

export type Actor = { id: string; role: Role };

export type Ticket = {
  id: string;
  version: number;
  status: "open" | "resolved";
  priority: Priority;
  openedBy: string;
  watchers: string[];
  resolution: string | null;
  resolvedAt: number | null;
};

export type Model = {
  id: string;
  revision: number;
  policy: Record<Role, Record<Priority, Decision>>;
  resolve: {
    id: string;
    source: string;
    precondition: { status: "open"; summary: "nonempty" };
    set: { status: "resolved"; resolution: "$summary"; resolvedAt: "$clock" };
    activity: { recipients: ("openedBy" | "watchers")[]; channel: "inbox" };
  };
};

export const model: Model = {
  id: "issue-tracker",
  revision: 1,
  policy: {
    support: { normal: "allow", high: "approval" },
    reviewer: { normal: "allow", high: "allow" },
    viewer: { normal: "deny", high: "deny" },
  },
  resolve: {
    id: "Ticket.resolve",
    source: "prototype/model.ts#model.resolve",
    precondition: { status: "open", summary: "nonempty" },
    set: { status: "resolved", resolution: "$summary", resolvedAt: "$clock" },
    activity: { recipients: ["openedBy", "watchers"], channel: "inbox" },
  },
};

export function ticket(): Ticket {
  return {
    id: "ticket-1",
    version: 1,
    status: "open",
    priority: "high",
    openedBy: "user-1",
    watchers: ["user-1", "user-2"],
    resolution: null,
    resolvedAt: null,
  };
}

export const support: Actor = { id: "support-1", role: "support" };
export const reviewer: Actor = { id: "reviewer-1", role: "reviewer" };
