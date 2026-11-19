import { useCallback, useEffect, useState } from "react";
import { collectivesService } from "../services/collectives";
import { useApp } from "../hooks/useAppState";
import { useToast } from "../components/Toast";
import { useTenantMutation } from "../hooks/useMutation";
import { Card } from "../components/Card";
import { Badge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import type { Ancestor, SubCollective, ComplianceData } from "../lib/types";

export function CollectivesTab() {
  const { currentTenant, hasPerm } = useApp();
  const { toastError } = useToast();
  const { mutate, busy } = useTenantMutation();

  const [ancestors, setAncestors] = useState<Ancestor[]>([]);
  const [collectives, setCollectives] = useState<SubCollective[]>([]);
  const [compliance, setCompliance] = useState<ComplianceData | null>(null);
  const [loading, setLoading] = useState(true);

  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");

  const loadData = useCallback(async () => {
    if (!currentTenant) return;
    const data = await collectivesService.getAll(currentTenant.id);
    setAncestors(data.ancestors);
    setCollectives(data.collectives);
    setCompliance(data.compliance);
  }, [currentTenant?.id]);

  useEffect(() => {
    setLoading(true);
    loadData()
      .catch((e) => {
        toastError(
          e instanceof Error ? e.message : "Failed to load collectives",
        );
      })
      .finally(() => setLoading(false));
  }, [loadData]);

  const createCollective = async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await mutate(
      "/collectives",
      { method: "POST", body: JSON.stringify({ name: newName, slug: newSlug }) },
      { successMsg: "Sub-collective created", reload: loadData },
    );
    if (ok) {
      setNewName("");
      setNewSlug("");
    }
  };

  const ejectCollective = async (id: string) => {
    if (!confirm("Eject this sub-collective? This cannot be undone.")) return;
    await mutate(
      `/collectives/${id}/eject`,
      { method: "POST" },
      { successMsg: "Sub-collective ejected", reload: loadData },
    );
  };

  if (loading) return <div className="loading">Loading...</div>;

  const violations = compliance?.violations ?? [];

  return (
    <div className="tab-content">
      {/* Ancestors */}
      <Card title="Parent Chain">
        {ancestors.length > 0 ? (
          <ul className="item-list">
            {ancestors.map((a) => (
              <li key={a.id} className="item-row">
                <div className="item-info">
                  <span className="item-name">{a.name}</span>
                  <span className="item-detail">{a.slug}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>This is a root collective.</EmptyState>
        )}
      </Card>

      {/* Sub-collectives */}
      <Card title="Sub-Collectives">
        {collectives.length > 0 ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Slug</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {collectives.map((c) => (
                <tr key={c.id}>
                  <td>
                    <a
                      href={`#collectives`}
                      className="link"
                    >
                      {c.name}
                    </a>
                  </td>
                  <td>{c.slug}</td>
                  <td>
                    <Badge variant="role">{c.status}</Badge>
                  </td>
                  <td>
                    {hasPerm("manage_sub_collectives") && (
                      <button
                        className="btn-sm btn-danger"
                        onClick={() => ejectCollective(c.id)}
                        disabled={busy}
                      >
                        Eject
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState>No sub-collectives.</EmptyState>
        )}

        {hasPerm("manage_sub_collectives") && (
          <form className="inline-form" onSubmit={createCollective}>
            <input
              type="text"
              placeholder="Collective name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              required
            />
            <input
              type="text"
              placeholder="Slug"
              value={newSlug}
              onChange={(e) => setNewSlug(e.target.value)}
              required
            />
            <button type="submit" className="btn-primary" disabled={busy}>
              Create Sub-Collective
            </button>
          </form>
        )}
      </Card>

      {/* Compliance */}
      <Card title="Compliance">
        {violations.length > 0 ? (
          <ul className="item-list">
            {violations.map((v, i) => (
              <li key={i} className="item-row">
                <div className="item-info">
                  <span className="item-name">{v.type}</span>
                  <span className="item-detail">{v.message}</span>
                </div>
                <div className="item-actions">
                  <Badge
                    variant={v.severity === "error" ? "stopped" : "warning"}
                  >
                    {v.severity}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>No compliance violations.</EmptyState>
        )}
      </Card>
    </div>
  );
}
