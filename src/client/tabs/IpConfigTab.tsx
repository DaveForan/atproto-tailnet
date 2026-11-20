import { useEffect, useState } from "react";
import { Card } from "../components/Card";
import { Loading } from "../components/Loading";
import { useTenantData } from "../hooks/useTenantData";
import { useTenant } from "../hooks/session";
import { networkService } from "../services/network";
import { useTenantMutation } from "../hooks/useMutation";
import type { IpConfig } from "../lib/types";
import { LoadError } from "../components/LoadError";

const IP_FALLBACK: IpConfig = {
  ipv4Prefix: "",
  ipv6Prefix: "",
  ipAllocation: "sequential",
};

export function IpConfigTab() {
  const { currentTenant } = useTenant();
  // Reached only by an old link: the tab is hidden in coordinator mode
  if (currentTenant?.coordinatorMode) {
    return (
      <div className="tab-content">
        <Card title="IP ranges">
          <p className="card-description">The coordinator assigns the address ranges of this tailnet.</p>
        </Card>
      </div>
    );
  }
  return <IpConfigForm />;
}

function IpConfigForm() {
  const { data: ipConfig, loading, error, reload } = useTenantData<IpConfig>(
    (tid) => networkService.getIpConfig(tid),
    IP_FALLBACK,
  );
  const { mutate, busy } = useTenantMutation({
    onSuccess: "IP configuration saved",
    onError: "Failed to save IP config",
    reload,
  });

  const [ipv4Prefix, setIpv4Prefix] = useState("");
  const [ipv6Prefix, setIpv6Prefix] = useState("");
  const [ipAllocation, setIpAllocation] = useState<"sequential" | "random">(
    "sequential",
  );

  // Sync form fields when loaded data changes
  useEffect(() => {
    if (ipConfig) {
      setIpv4Prefix(ipConfig.ipv4Prefix);
      setIpv6Prefix(ipConfig.ipv6Prefix);
      setIpAllocation(ipConfig.ipAllocation);
    }
  }, [ipConfig]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    await mutate((tid) => networkService.setIpConfig(tid, { ipv4Prefix, ipv6Prefix, ipAllocation }));
  };

  if (loading) return <Loading />;

  return (
    <div className="tab-content">
      <LoadError error={error} onRetry={reload} />
      <Card title="IP ranges">
        <p className="notice mb-12" role="note">
          Changing IP configuration will trigger a container restart. Connected
          devices may briefly lose connectivity.
        </p>

        <form className="form-stack" onSubmit={handleSave}>
          <div className="field-row">
            <div className="field">
              <label htmlFor="ipv4-prefix">IPv4 prefix</label>
              <input
                id="ipv4-prefix"
                type="text"
                className="mono"
                value={ipv4Prefix}
                onChange={(e) => setIpv4Prefix(e.target.value)}
                placeholder="100.64.0.0/10"
                spellCheck={false}
              />
            </div>

            <div className="field">
              <label htmlFor="ipv6-prefix">IPv6 prefix</label>
              <input
                id="ipv6-prefix"
                type="text"
                className="mono"
                value={ipv6Prefix}
                onChange={(e) => setIpv6Prefix(e.target.value)}
                placeholder="fd7a:115c:a1e0::/48"
                spellCheck={false}
              />
            </div>

            <div className="field">
              <label htmlFor="ip-allocation">Allocation strategy</label>
              <select
                id="ip-allocation"
                value={ipAllocation}
                onChange={(e) =>
                  setIpAllocation(e.target.value as "sequential" | "random")
                }
              >
                <option value="sequential">Sequential</option>
                <option value="random">Random</option>
              </select>
            </div>
          </div>

          <button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </form>
      </Card>
    </div>
  );
}
