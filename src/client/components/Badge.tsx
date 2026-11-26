interface BadgeProps {
  variant: "running" | "stopped" | "originator" | "role" | "warning" | "pending";
  children: React.ReactNode;
}

const classes: Record<string, string> = {
  running: "badge badge-running",
  stopped: "badge badge-stopped",
  originator: "badge badge-originator",
  role: "badge badge-role",
  warning: "badge badge-warning",
  pending: "badge badge-warning",
};

export function Badge({ variant, children }: BadgeProps) {
  return <span className={classes[variant] || "badge"}>{children}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "running":
    case "active":
    case "approved":
      return <Badge variant="running">{status}</Badge>;
    case "revoked":
    case "rejected":
      return <Badge variant="stopped">{status}</Badge>;
    case "provisioning":
    case "pending":
      return <Badge variant="warning">{status}</Badge>;
    default:
      return <Badge variant="role">{status}</Badge>;
  }
}
