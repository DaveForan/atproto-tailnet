import { Card } from "../../components/Card";
import type { Federation } from "./useFederation";

export function RequestCard({ fed }: { fed: Federation }) {
  const { busy, canManage } = fed;
  const { targetSlug, setTargetSlug, requestMessage, setRequestMessage, requestCidrs, setRequestCidrs, requestFederation } = fed.request;
  return (
    <Card title="Request federation">
      <form className="form-stack" onSubmit={requestFederation}>
        <div className="field">
          <label htmlFor="fed-target">Target collective slug</label>
          <input
            id="fed-target"
            type="text"
            className="mono"
            autoCapitalize="none"
            spellCheck={false}
            value={targetSlug}
            onChange={(e) => setTargetSlug(e.target.value)}
            required
          />
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="fed-message">Message (optional)</label>
            <textarea
              id="fed-message"
              value={requestMessage}
              onChange={(e) => setRequestMessage(e.target.value)}
              rows={3}
            />
          </div>
          <div className="field">
            <label htmlFor="fed-cidrs">CIDRs to share (one per line)</label>
            <textarea
              id="fed-cidrs"
              className="mono"
              spellCheck={false}
              value={requestCidrs}
              onChange={(e) => setRequestCidrs(e.target.value)}
              rows={3}
            />
          </div>
        </div>
        <button type="submit" disabled={busy || !canManage}>
          Send request
        </button>
      </form>
    </Card>
  );
}
