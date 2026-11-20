import { Card } from "../../components/Card";
import type { ScopePolicyConfig } from "../../lib/types";
import { ALL_SCOPES, DEFAULT_POLICY, type Federation } from "./useFederation";

export function ScopeCard({ fed }: { fed: Federation }) {
  const { busy, canManage } = fed;
  const { scopes, toggleScope, policies, setPolicy, region, setRegion, lat, setLat, lon, setLon, saveScope } = fed.scope;
  return (
    <Card title="Federation scope">
      <form className="form-stack" onSubmit={saveScope} noValidate>
        <fieldset className="check-list">
          <legend>Scopes</legend>
          {ALL_SCOPES.map((sc) => {
            const enabled = scopes.includes(sc);
            const policy = policies[sc] ?? DEFAULT_POLICY;
            return (
              <div key={sc} className="scope-row">
                <label className="check-inline">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => toggleScope(sc, e.target.checked)}
                  />
                  {sc}
                </label>
                {enabled && (
                  <>
                    <label className="check-inline">
                      <input
                        type="checkbox"
                        checked={policy.autoAccept}
                        onChange={(e) => setPolicy(sc, { autoAccept: e.target.checked })}
                      />
                      Auto-accept
                    </label>
                    <select
                      className="select-compact"
                      aria-label={`Verification for the ${sc} scope`}
                      value={policy.verification}
                      onChange={(e) =>
                        setPolicy(sc, { verification: e.target.value as ScopePolicyConfig["verification"] })
                      }
                    >
                      <option value="standard">Standard verification</option>
                      <option value="strict">Strict verification</option>
                    </select>
                  </>
                )}
              </div>
            );
          })}
        </fieldset>
        <div className="field-row">
          <div className="field">
            <label htmlFor="fed-region">Region (UN M49 3-digit code, optional)</label>
            <input
              id="fed-region"
              type="text"
              inputMode="numeric"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              pattern="\d{3}"
              maxLength={3}
              placeholder="e.g. 021"
            />
          </div>
          <div className="field">
            <label htmlFor="fed-lat">Latitude (optional)</label>
            <input
              id="fed-lat"
              type="number"
              step="any"
              min={-90}
              max={90}
              value={lat}
              onChange={(e) => setLat(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="fed-lon">Longitude (optional)</label>
            <input
              id="fed-lon"
              type="number"
              step="any"
              min={-180}
              max={180}
              value={lon}
              onChange={(e) => setLon(e.target.value)}
            />
          </div>
        </div>
        <button type="submit" disabled={busy || !canManage}>
          Save scope
        </button>
      </form>
    </Card>
  );
}
