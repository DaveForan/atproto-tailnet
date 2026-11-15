import { useEffect, useState } from "react";
import { Card } from "../components/Card";
import { useTenantData } from "../hooks/useTenantData";
import { useTenantMutation } from "../hooks/useMutation";
import type { IpConfig } from "../lib/types";

const IP_FALLBACK: IpConfig = {
  ipv4Prefix: "",
  ipv6Prefix: "",
  ipAllocation: "sequential",
};

export function IpConfigTab() {
  const { data: ipConfig, loading, reload } = useTenantData<IpConfig>(
    "/ip-config",
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
    await mutate("/ip-config", {
      method: "PUT",
      body: JSON.stringify({ ipv4Prefix, ipv6Prefix, ipAllocation }),
    });
  };

  if (loading) return <div className="loading">Loading...</div>;

  return (
    <div className="tab-content">
      <Card title="IP Configuration">
        <div className="warning-banner">
          Changing IP configuration will trigger a container restart. Connected
          devices may briefly lose connectivity.
        </div>

        <form className="form" onSubmit={handleSave}>
          <div className="form-group">
            <label className="form-label" htmlFor="ipv4-prefix">
              IPv4 Prefix
            </label>
            <input
              id="ipv4-prefix"
              type="text"
              className="input"
              value={ipv4Prefix}
              onChange={(e) => setIpv4Prefix(e.target.value)}
              placeholder="100.64.0.0/10"
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="ipv6-prefix">
              IPv6 Prefix
            </label>
            <input
              id="ipv6-prefix"
              type="text"
              className="input"
              value={ipv6Prefix}
              onChange={(e) => setIpv6Prefix(e.target.value)}
              placeholder="fd7a:115c:a1e0::/48"
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="ip-allocation">
              Allocation Strategy
            </label>
            <select
              id="ip-allocation"
              className="input"
              value={ipAllocation}
              onChange={(e) =>
                setIpAllocation(e.target.value as "sequential" | "random")
              }
            >
              <option value="sequential">Sequential</option>
              <option value="random">Random</option>
            </select>
          </div>

          <button
            className="btn btn-primary"
            type="submit"
            disabled={busy}
          >
            {busy ? "Saving..." : "Save"}
          </button>
        </form>
      </Card>
    </div>
  );
}
