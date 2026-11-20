import { useApp } from "../hooks/useAppState";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { Loading } from "../components/Loading";
import { Badge } from "../components/Badge";
import { useConfirm } from "../components/ConfirmDialog";
import { useTenantData } from "../hooks/useTenantData";
import { useTenantMutation } from "../hooks/useMutation";
import type { RouteData, RouteEntry } from "../lib/types";

const ROUTES_FALLBACK: RouteData = { exitNodes: [], subnets: [] };

export function RoutesTab() {
  const { hasPerm } = useApp();
  const { data: routes, loading, reload } = useTenantData<RouteData>(
    "/routes",
    ROUTES_FALLBACK,
  );
  const { mutate, busy } = useTenantMutation({
    onError: "Route operation failed",
    reload,
  });

  const canManage = hasPerm("manage_devices");
  const confirm = useConfirm();

  const handleToggle = async (routeId: string, currentlyEnabled: boolean) => {
    const action = currentlyEnabled ? "disable" : "enable";
    await mutate(
      `/routes/${routeId}/${action}`,
      { method: "POST" },
      { successMsg: `Route ${action}d` },
    );
  };

  const handleDelete = async (routeId: string) => {
    if (!(await confirm({
      title: "Delete this route?",
      message: "This withdraws the route's approval.",
      confirmLabel: "Delete route",
      danger: true,
    }))) return;
    await mutate(
      `/routes/${routeId}`,
      { method: "DELETE" },
      { successMsg: "Route deleted" },
    );
  };

  if (loading) return <Loading />;

  return (
    <div className="tab-content">
      <Card title="Exit nodes">
        {routes.exitNodes.length > 0 ? (
          <RouteList
            entries={routes.exitNodes}
            onToggle={handleToggle}
            onDelete={handleDelete}
            busy={busy}
            canManage={canManage}
          />
        ) : (
          <EmptyState>
            No exit nodes advertised. Devices can advertise as exit nodes with{" "}
            <code>tailscale up --advertise-exit-node</code>.
          </EmptyState>
        )}
      </Card>

      <Card title="Subnet routers">
        {routes.subnets.length > 0 ? (
          <RouteList
            entries={routes.subnets}
            onToggle={handleToggle}
            onDelete={handleDelete}
            busy={busy}
            canManage={canManage}
          />
        ) : (
          <EmptyState>
            No subnet routes advertised. Devices can advertise subnets with{" "}
            <code>tailscale up --advertise-routes=192.168.1.0/24</code>.
          </EmptyState>
        )}
      </Card>
    </div>
  );
}

function RouteList({
  entries,
  onToggle,
  onDelete,
  busy,
  canManage,
}: {
  entries: RouteEntry[];
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
  busy: boolean;
  canManage: boolean;
}) {
  return (
    <ul className="item-list">
      {entries.map((route) => {
        const node = route.node?.givenName || route.node?.name || "Unknown node";
        return (
          <li key={route.id} className="item-row item-row-wrap">
            <div className="item-lead">
              <span className={`online-dot ${route.node?.online ? "online" : "offline"}`} aria-hidden="true" />
              <div className="item-info">
                <span className="item-header">
                  <span className="item-name">{node}</span>
                  <Badge variant={route.enabled ? "running" : "role"}>{route.enabled ? "enabled" : "not enabled"}</Badge>
                  <span className="sr-only">({route.node?.online ? "online" : "offline"})</span>
                </span>
                <span className="item-detail mono">{route.prefix}</span>
              </div>
            </div>
            {canManage && (
              <div className="item-actions">
                <button
                  type="button"
                  className={`btn-sm${route.enabled ? " btn-ghost" : ""}`}
                  aria-label={`${route.enabled ? "Disable" : "Enable"} route ${route.prefix} on ${node}`}
                  onClick={() => onToggle(route.id, route.enabled)}
                  disabled={busy}
                >
                  {route.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  type="button"
                  className="btn-sm btn-danger"
                  aria-label={`Delete route ${route.prefix} on ${node}`}
                  onClick={() => onDelete(route.id)}
                  disabled={busy}
                >
                  Delete
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
