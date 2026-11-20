import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { CodeBlock } from "../../components/CodeBlock";
import type { BrokerData } from "../../lib/types";
import type { Federation } from "./useFederation";

export function DidCard({ fed }: { fed: Federation }) {
  const { busy, canManage, did, rotateDid } = fed;
  return (
    <Card title="Collective identity">
      {did ? (
        <CodeBlock value={did} label="Collective DID" />
      ) : (
        <EmptyState>No DID assigned.</EmptyState>
      )}
      <div className="form-section">
        <p className="help-text">
          Rotating the DID invalidates all federation sessions and credentials signed under the current one.
        </p>
        <button type="button" className="btn-sm btn-danger" onClick={rotateDid} disabled={busy || !canManage}>
          Rotate DID
        </button>
      </div>
    </Card>
  );
}

export function BrokerCard({ broker }: { broker: BrokerData | null }) {
  return (
    <Card title="Broker status">
      {broker ? (
        <div className="stats-row">
          <div className="stat-card">
            <div className="stat-value">{broker.sessionCount}</div>
            <div className="stat-label">Sessions</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{broker.importedRoutes}</div>
            <div className="stat-label">Imported routes</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{broker.exportedRoutes}</div>
            <div className="stat-label">Exported routes</div>
          </div>
        </div>
      ) : (
        <EmptyState>Broker data unavailable.</EmptyState>
      )}
    </Card>
  );
}
