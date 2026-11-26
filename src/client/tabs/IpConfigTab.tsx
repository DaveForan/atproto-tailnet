import { Card } from "../components/Card";
import { Loading } from "../components/Loading";
import { LoadError } from "../components/LoadError";
import { useTenantData } from "../hooks/useTenantData";
import { networkService } from "../services/network";
import type { IpConfig } from "../lib/types";

export function IpConfigTab() {
  const { data: ipConfig, loading, error, reload } = useTenantData<IpConfig | null>(
    (tid) => networkService.getIpConfig(tid),
    null,
  );

  if (loading) return <Loading />;

  return (
    <div className="tab-content">
      <LoadError error={error} onRetry={reload} />
      <Card title="IP ranges">
        <p className="card-description">
          The address ranges of this tailnet are fixed when the tailnet is created.
        </p>
        {ipConfig && (
          <dl className="detail-list">
            <dt>IPv4 range</dt>
            <dd className="mono">{ipConfig.ipv4Prefix}</dd>
            <dt>IPv6 range</dt>
            <dd className="mono">{ipConfig.ipv6Prefix}</dd>
          </dl>
        )}
      </Card>
    </div>
  );
}
