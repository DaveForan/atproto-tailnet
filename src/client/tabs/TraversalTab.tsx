import { useEffect, useState } from "react";
import { useTenantData } from "../hooks/useTenantData";
import { useTenantMutation } from "../hooks/useMutation";
import { networkService } from "../services/network";
import { useTenant } from "../hooks/session";
import { useToast } from "../components/Toast";
import { Card } from "../components/Card";
import { Loading } from "../components/Loading";
import { CodeBlock } from "../components/CodeBlock";
import type { TraversalEvalResult } from "../lib/types";
import { LoadError } from "../components/LoadError";

export function TraversalTab() {
  const { currentTenant } = useTenant();
  const { toastError, toastFailure } = useToast();
  const { data: policy, loading, error, reload } = useTenantData<unknown>(
    (tid) => networkService.getTraversalPolicy(tid),
    null,
  );
  const { mutate, busy: saveBusy } = useTenantMutation({ reload });

  const [policyText, setPolicyText] = useState("");
  const [source, setSource] = useState("");
  const [destination, setDestination] = useState("");
  const [result, setResult] = useState<TraversalEvalResult | null>(null);
  const [testBusy, setTestBusy] = useState(false);

  useEffect(() => {
    if (policy !== null) setPolicyText(JSON.stringify(policy, null, 2));
  }, [policy]);

  const savePolicy = async (e: React.FormEvent) => {
    e.preventDefault();
    let parsed: unknown;
    try {
      parsed = JSON.parse(policyText);
    } catch {
      toastError("Invalid JSON syntax — check your policy text");
      return;
    }
    await mutate(
      (tid) => networkService.setTraversalPolicy(tid, parsed),
      { successMsg: "Traversal policy saved" },
    );
  };

  const evaluate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentTenant) return;
    setTestBusy(true);
    try {
      const data = await networkService.evaluateTraversal(
        currentTenant.id,
        source,
        destination,
      );
      setResult(data);
    } catch (err) {
      toastFailure(err, "Failed to evaluate policy");
    } finally {
      setTestBusy(false);
    }
  };

  if (loading) return <Loading />;

  return (
    <div className="tab-content">
      <LoadError error={error} onRetry={reload} />
      <Card title="Traversal policy">
        <form className="form-stack" onSubmit={savePolicy}>
          <div className="field">
            <label htmlFor="traversal-policy">Policy (JSON)</label>
            <textarea
              id="traversal-policy"
              className="code-input"
              value={policyText}
              onChange={(e) => setPolicyText(e.target.value)}
              rows={16}
              spellCheck={false}
            />
          </div>
          <button type="submit" disabled={saveBusy}>
            {saveBusy ? "Saving…" : "Save policy"}
          </button>
        </form>
      </Card>

      <Card title="Test traversal">
        <form className="form-stack" onSubmit={evaluate}>
          <div className="field-row">
            <div className="field">
              <label htmlFor="traversal-source">Source</label>
              <input
                id="traversal-source"
                type="text"
                className="mono"
                placeholder="e.g. 100.64.0.1"
                spellCheck={false}
                value={source}
                onChange={(e) => setSource(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="traversal-destination">Destination</label>
              <input
                id="traversal-destination"
                type="text"
                className="mono"
                placeholder="e.g. 100.64.1.1"
                spellCheck={false}
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                required
              />
            </div>
          </div>
          <button type="submit" className="btn-ghost" disabled={testBusy}>
            {testBusy ? "Testing…" : "Test"}
          </button>
        </form>

        {result && <CodeBlock value={JSON.stringify(result, null, 2)} label="Test result" />}
      </Card>
    </div>
  );
}
