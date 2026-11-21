import { Card } from "../../components/Card";
import type { Federation } from "./useFederation";

export function PostureCard({ fed }: { fed: Federation }) {
  const { busy, canManage } = fed;
  const { posture, setPosture, savePosture } = fed.posture;
  return (
    <Card title="Federation posture">
      <form className="field" onSubmit={savePosture}>
        <label htmlFor="fed-posture">Who may federate with this tailnet</label>
        <div className="inline-form">
          <select
            id="fed-posture"
            value={posture}
            onChange={(e) => setPosture(e.target.value)}
          >
            <option value="open">Open</option>
            <option value="closed">Closed</option>
          </select>
          <button type="submit" disabled={busy || !canManage}>
            Save posture
          </button>
        </div>
      </form>
    </Card>
  );
}
