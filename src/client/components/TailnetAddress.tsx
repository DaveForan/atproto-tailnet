import { useCallback, useEffect, useState } from "react";
import { useApp } from "../hooks/useAppState";
import { useToast } from "./Toast";
import { Card } from "./Card";
import { Badge } from "./Badge";
import { hostnamesService } from "../services/hostnames";
import { errorMessage } from "../lib/utils";
import type { HostnamesData } from "../lib/types";

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Client-side check matching the server's rules (the server is authoritative). */
export function addressProblem(name: string): string | null {
  if (!name) return "Enter an address";
  if (!LABEL_RE.test(name) || name.includes("--")) {
    return "Use lowercase letters, digits and single hyphens (1–63 characters, no hyphen at either end)";
  }
  return null;
}

/**
 * Form for choosing the tailnet's primary address. Used by the setup wizard
 * and the Tailnet address card. Calls `onSaved` after a successful change.
 */
export function AddressForm({
  tenantId,
  initial,
  baseDomain,
  submitLabel,
  onSaved,
  secondary,
}: {
  tenantId: string;
  initial: string;
  baseDomain: string;
  submitLabel: string;
  onSaved: (primary: string) => void;
  secondary?: React.ReactNode;
}) {
  const { toast, toastError } = useToast();
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const problem = addressProblem(value);

  const save = async () => {
    if (problem || busy) return;
    setBusy(true);
    try {
      const r = await hostnamesService.setPrimary(tenantId, value);
      toast(`Address set to ${value}.${baseDomain}`);
      onSaved(r?.primary ?? value);
    } catch (e) {
      toastError(errorMessage(e, "Failed to change the address"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="form-stack"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label htmlFor="tailnet-address" className="text-sm">Tailnet address</label>
      <div className="inline-form">
        <input
          id="tailnet-address"
          type="text"
          value={value}
          maxLength={63}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setValue(e.target.value.trim().toLowerCase())}
          aria-describedby="tailnet-address-help"
        />
        <span className="mono text-dim">.{baseDomain}</span>
      </div>
      <p id="tailnet-address-help" className="help-text">
        {value && problem ? problem : `Devices will connect to https://${value || "…"}.${baseDomain}`}
      </p>
      <div className="btn-group">
        <button type="submit" disabled={busy || !!problem || value === initial}>
          {busy ? "Saving..." : submitLabel}
        </button>
        {secondary}
      </div>
    </form>
  );
}

/** Settings card: current address, aliases, change/retire (originator only). */
export function TailnetAddressCard() {
  const { currentTenant, reload } = useApp();
  const { toast, toastError } = useToast();
  const [data, setData] = useState<HostnamesData | null>(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    if (!currentTenant) return;
    try {
      setData(await hostnamesService.list(currentTenant.id));
    } catch {
      setData(null);
    }
  }, [currentTenant]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!currentTenant || !data) return null;

  const live = data.hostnames.filter((h) => !h.retiredAt);
  const aliases = live.filter((h) => !h.primary);
  const retired = data.hostnames.filter((h) => h.retiredAt);

  const retire = async (name: string) => {
    const ok = window.confirm(
      `Retire ${name}.${data.baseDomain}? Devices still using this address will lose their connection to the tailnet.`,
    );
    if (!ok) return;
    try {
      await hostnamesService.retire(currentTenant.id, name);
      toast(`${name} retired`);
      await load();
    } catch (e) {
      toastError(errorMessage(e, "Failed to retire the alias"));
    }
  };

  return (
    <Card title="Tailnet address">
      <p className="card-description">
        Devices connect to <span className="mono">https://{data.primary}.{data.baseDomain}</span>.
        {aliases.length > 0 && " Older addresses keep working for devices that enrolled with them."}
      </p>

      {aliases.length > 0 && (
        <ul className="item-list">
          {aliases.map((h) => (
            <li key={h.name} className="item-row">
              <span className="mono">{h.name}.{data.baseDomain}</span>
              <Badge variant="pending">alias</Badge>
              {data.canManage && (
                <button className="btn-sm btn-ghost" onClick={() => { void retire(h.name); }}>
                  Retire
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {aliases.length > 0 && data.canManage && (
        <p className="help-text">
          Retire an alias only after every device that uses it has moved to the current address —
          devices still on a retired address lose their connection to the tailnet.
        </p>
      )}
      {retired.length > 0 && data.canManage && (
        <p className="help-text">
          Retired: {retired.map((h) => h.name).join(", ")} (reserved for 30 days, then released).
        </p>
      )}

      {data.canManage &&
        (editing ? (
          <AddressForm
            tenantId={currentTenant.id}
            initial={data.primary}
            baseDomain={data.baseDomain}
            submitLabel="Change address"
            onSaved={() => {
              setEditing(false);
              void load();
              void reload();
            }}
            secondary={
              <button type="button" className="btn-ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
            }
          />
        ) : (
          <button className="btn-sm" onClick={() => setEditing(true)}>Change address</button>
        ))}
    </Card>
  );
}
