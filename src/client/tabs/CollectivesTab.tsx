import { useCallback, useEffect, useState } from "react";
import { collectivesService } from "../services/collectives";
import { useApp } from "../hooks/useAppState";
import { useToast } from "../components/Toast";
import { useTenantMutation } from "../hooks/useMutation";
import { Card } from "../components/Card";
import { Badge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { Loading } from "../components/Loading";
import { useConfirm } from "../components/ConfirmDialog";
import { errorCode, errorMessage } from "../lib/utils";
import type { Ancestor, SubCollective, ComplianceData } from "../lib/types";
import { LoadError } from "../components/LoadError";

export function CollectivesTab() {
  const { currentTenant, hasPerm, user } = useApp();
  const { toast, toastError } = useToast();
  const { mutate, busy } = useTenantMutation();
  const confirm = useConfirm();

  const [ancestors, setAncestors] = useState<Ancestor[]>([]);
  const [collectives, setCollectives] = useState<SubCollective[]>([]);
  const [compliance, setCompliance] = useState<ComplianceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [creating, setCreating] = useState(false);
  const [singleTailnet, setSingleTailnet] = useState(!!user?.isOperator && user.canCreateTailnet === false);
  // Sub-collectives are tailnets: only operators and designated tailnet creators may create them
  const [cannotCreate, setCannotCreate] = useState(
    !!user && !user.isOperator && user.canCreateTailnet === false,
  );

  const loadData = useCallback(async () => {
    if (!currentTenant) return;
    const data = await collectivesService.getAll(currentTenant.id);
    setAncestors(data.ancestors);
    setCollectives(data.collectives);
    setCompliance(data.compliance);
  }, [currentTenant?.id]);

  const loadAll = useCallback(() => {
    setLoading(true);
    return loadData()
      .then(() => setLoadError(null))
      .catch((e) => setLoadError(errorMessage(e, "Failed to load collectives")))
      .finally(() => setLoading(false));
  }, [loadData]);

  useEffect(() => { void loadAll(); }, [loadAll]);

  const createCollective = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentTenant || creating) return;
    setCreating(true);
    try {
      await collectivesService.create(currentTenant.id, newName, newSlug);
      toast("Sub-collective created");
      setNewName("");
      setNewSlug("");
      await loadData();
    } catch (err) {
      const code = errorCode(err);
      if (code === "single_tailnet") setSingleTailnet(true);
      if (code === "cannot_create_tailnet") setCannotCreate(true);
      toastError(errorMessage(err, "Failed to create sub-collective"));
    } finally {
      setCreating(false);
    }
  };

  const ejectCollective = async (id: string, name: string) => {
    if (!(await confirm({ title: `Eject ${name}?`, message: "This sub-collective is removed from this tailnet. This cannot be undone.", confirmLabel: "Eject", danger: true }))) return;
    await mutate(
      `/collectives/${id}/eject`,
      { method: "POST" },
      { successMsg: "Sub-collective ejected", reload: loadData },
    );
  };

  if (loading) return <Loading />;

  const violations = compliance?.violations ?? [];

  return (
    <div className="tab-content">
      <LoadError error={loadError} onRetry={loadAll} />
      {/* Ancestors */}
      <Card title="Parent chain">
        {ancestors.length > 0 ? (
          <ul className="item-list">
            {ancestors.map((a) => (
              <li key={a.id} className="item-row">
                <div className="item-info">
                  <span className="item-name">{a.name}</span>
                  <span className="item-detail mono">{a.slug}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>This is a root collective.</EmptyState>
        )}
      </Card>

      {/* Sub-collectives */}
      <Card title="Sub-collectives">
        {collectives.length > 0 ? (
          <ul className="item-list">
            {collectives.map((c) => (
              <li key={c.id} className="item-row">
                <div className="item-info">
                  <span className="item-header">
                    <span className="item-name">{c.name}</span>
                    <Badge variant="role">{c.status}</Badge>
                  </span>
                  <span className="item-detail mono">{c.slug}</span>
                </div>
                {hasPerm("manage_sub_collectives") && (
                  <button
                    type="button"
                    className="btn-sm btn-danger"
                    aria-label={`Eject ${c.name}`}
                    onClick={() => ejectCollective(c.id, c.name)}
                    disabled={busy}
                  >
                    Eject
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>No sub-collectives.</EmptyState>
        )}

        {hasPerm("manage_sub_collectives") && singleTailnet && (
          <p className="help-text mt-12" role="status">
            New sub-collectives can&apos;t be created because this instance is in single-tailnet mode.
            An instance operator can turn that off on the Instance page.
          </p>
        )}
        {hasPerm("manage_sub_collectives") && !singleTailnet && cannotCreate && (
          <p className="help-text mt-12" role="status">
            A sub-collective is its own tailnet, so only instance operators and people an operator
            has designated as tailnet creators can create one. Ask an instance operator if you need one.
          </p>
        )}
        {hasPerm("manage_sub_collectives") && !singleTailnet && !cannotCreate && (
          <form className="form-section form-stack" onSubmit={createCollective} aria-labelledby="new-collective-heading">
            <h4 id="new-collective-heading">Create a sub-collective</h4>
            <div className="field-row">
              <div className="field">
                <label htmlFor="collective-name">Name</label>
                <input
                  id="collective-name"
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="collective-slug">Slug</label>
                <input
                  id="collective-slug"
                  type="text"
                  className="mono"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={newSlug}
                  onChange={(e) => setNewSlug(e.target.value)}
                  required
                />
              </div>
            </div>
            <button type="submit" disabled={creating}>
              {creating ? "Creating…" : "Create sub-collective"}
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
                <Badge variant={v.severity === "error" ? "stopped" : "warning"}>{v.severity}</Badge>
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
