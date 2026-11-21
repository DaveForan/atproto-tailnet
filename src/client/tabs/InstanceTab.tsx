import { useState } from "react";
import { useSession } from "../hooks/session";
import { useTenantParallel, type TenantLoaders } from "../hooks/useTenantData";
import { useToast } from "../components/Toast";
import { Card } from "../components/Card";
import { Loading } from "../components/Loading";
import { LoadError } from "../components/LoadError";
import { ConnectClaude } from "../components/ConnectClaude";
import { operatorService } from "../services/operator";
import { instanceService } from "../services/instance";
import { ApiError } from "../services/api";
import type { InstanceInfo, OperatorOverview, TailnetCreator } from "../lib/types";
import { TailnetsCard } from "./instance/TailnetsCard";
import { UsersCard } from "./instance/UsersCard";
import { InstanceSettingsCard } from "./instance/InstanceSettingsCard";
import { CreatorsCard } from "./instance/CreatorsCard";
import { InstanceActivity } from "./instance/ActivityCard";
import type { RunAction } from "./instance/types";

function conflictNames(e: unknown): string[] {
  if (!(e instanceof ApiError) || !e.body) return [];
  const list = Object.values(e.body).find(Array.isArray) as unknown[] | undefined;
  return (list ?? [])
    .map((x) => {
      if (typeof x === "string") return x;
      if (x && typeof x === "object") {
        const o = x as Record<string, unknown>;
        return String(o.name ?? o.slug ?? o.id ?? "");
      }
      return "";
    })
    .filter(Boolean);
}

interface InstanceData {
  overview: OperatorOverview | null;
  creators: TailnetCreator[];
  instance: InstanceInfo | null;
}

const LOADERS: TenantLoaders<InstanceData> = {
  overview: () => operatorService.overview(),
  creators: () => operatorService.getCreators(),
  instance: () => instanceService.get().catch(() => null),
};

export function InstanceTab() {
  const { tenants: myTenants, reload: reloadApp } = useSession();
  const { toast, toastFailure } = useToast();
  const { data, loading, error: loadError, reload: load } = useTenantParallel(
    LOADERS,
    { overview: null, creators: [], instance: null },
    { keepPreviousOnReload: true, instanceWide: true },
  );
  const { overview, creators, instance } = data;
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<string[] | null>(null);

  const run: RunAction = async (fn, success, opts) => {
    if (busy) return false;
    setBusy(true);
    try {
      await fn();
      toast(success);
      await load();
      if (opts?.reloadApp) await reloadApp();
      return true;
    } catch (e) {
      toastFailure(e, "Operation failed");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const isMine = (tenantId: string) => myTenants.some((t) => t.id === tenantId);

  const setSingleTailnet = async (value: boolean) => {
    if (busy) return;
    setBusy(true);
    setConflict(null);
    try {
      await operatorService.updateSettings({ singleTailnet: value });
      toast(value ? "Single-tailnet mode on" : "Single-tailnet mode off");
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const names = conflictNames(e);
        setConflict(
          names.length > 0
            ? names
            : (overview?.tenants ?? []).filter((t) => !t.parentId && t.status !== "deleted").map((t) => t.name),
        );
      } else {
        toastFailure(e, "Failed to update settings");
      }
    } finally {
      setBusy(false);
    }
  };

  const setDefault = (id: string) =>
    void run(
      () => operatorService.updateSettings({ defaultTailnetId: id || null }),
      id ? "Default tailnet updated" : "Default tailnet cleared",
    );

  if (loadError && !overview) {
    return (
      <div className="tab-content">
        <Card title="Instance">
          <p className="form-error" role="alert">{loadError}</p>
          <button type="button" className="btn-sm mt-8" onClick={() => { void load(); }}>Retry</button>
        </Card>
      </div>
    );
  }

  if (loading || !overview) return <Loading />;

  return (
    <div className="tab-content">
      <LoadError error={loadError} onRetry={load} />
      <TailnetsCard overview={overview} busy={busy} run={run} isMine={isMine} />
      <UsersCard users={overview.users} busy={busy} run={run} />
      <InstanceSettingsCard
        overview={overview}
        instance={instance}
        busy={busy}
        conflict={conflict}
        onSingleTailnet={(v) => { void setSingleTailnet(v); }}
        onDefault={setDefault}
      />
      <CreatorsCard creators={creators} busy={busy} run={run} />
      <InstanceActivity />
      <ConnectClaude />
    </div>
  );
}
