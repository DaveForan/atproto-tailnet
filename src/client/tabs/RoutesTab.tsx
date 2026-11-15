import { useApp } from "../hooks/useAppState";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
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

  const handleToggle = async (routeId: string, currentlyEnabled: boolean) => {
    const action = currentlyEnabled ? "disable" : "enable";
    await mutate(
      `/routes/${routeId}/${action}`,
      { method: "POST" },
      { successMsg: `Route ${action}d` },
    );
  };

  const handleDelete = async (routeId: string) => {
    if (!confirm("Delete this route?")) return;
    await mutate(
      `/routes/${routeId}`,
      { method: "DELETE" },
      { successMsg: "Route deleted" },
    );
  };

  if (loading) return <div className="loading">Loading...</div>;

  return (
    <div className="tab-content">
      <Card title="Exit Nodes">
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

      <Card title="Subnet Routers">
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
    <ul className="route-list">
      {entries.map((route) => (
        <li key={route.id} className="route-row">
          <span
            className={`online-dot ${route.node?.online ? "online" : "offline"}`}
          />
          <div className="route-info">
            <span className="route-node">
              {route.node?.givenName || route.node?.name || "Unknown node"}
            </span>
            <span className="route-prefix">{route.prefix}</span>
          </div>
          {canManage && (
            <div className="route-actions">
              <button
                className={`btn-sm ${route.enabled ? "btn-warning" : "btn-primary"}`}
                onClick={() => onToggle(route.id, route.enabled)}
                disabled={busy}
              >
                {route.enabled ? "Disable" : "Enable"}
              </button>
              <button
                className="btn-sm btn-danger"
                onClick={() => onDelete(route.id)}
                disabled={busy}
              >
                Delete
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
