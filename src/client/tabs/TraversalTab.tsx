import { useEffect, useState } from "react";
import { useTenantData } from "../hooks/useTenantData";
import { useTenantMutation } from "../hooks/useMutation";
import { networkService } from "../services/network";
import { useApp } from "../hooks/useAppState";
import { useToast } from "../components/Toast";
import { Card } from "../components/Card";
import type { TraversalEvalResult } from "../lib/types";

export function TraversalTab() {
  const { currentTenant } = useApp();
  const { toastError } = useToast();
  const { data: policy, loading, reload } = useTenantData<unknown>(
    "/traversal-policy",
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

  const savePolicy = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(policyText);
    } catch {
      toastError("Invalid JSON syntax — check your policy text");
      return;
    }
    await mutate(
      "/traversal-policy",
      { method: "PUT", body: JSON.stringify(parsed) },
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
      toastError(
        err instanceof Error ? err.message : "Failed to evaluate policy",
      );
    } finally {
      setTestBusy(false);
    }
  };

  if (loading) return <div className="loading">Loading...</div>;

  return (
    <div className="tab-content">
      <Card title="Traversal Policy">
        <div className="inline-form">
          <textarea
            className="code-textarea"
            value={policyText}
            onChange={(e) => setPolicyText(e.target.value)}
            rows={16}
            spellCheck={false}
          />
          <button
            className="btn-primary"
            onClick={savePolicy}
            disabled={saveBusy}
          >
            {saveBusy ? "Saving..." : "Save Policy"}
          </button>
        </div>
      </Card>

      <Card title="Test Traversal">
        <form className="inline-form" onSubmit={evaluate}>
          <input
            type="text"
            placeholder="Source (e.g. 100.64.0.1)"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            required
          />
          <input
            type="text"
            placeholder="Destination (e.g. 100.64.1.1)"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            required
          />
          <button type="submit" className="btn-primary" disabled={testBusy}>
            {testBusy ? "Testing..." : "Test"}
          </button>
        </form>

        {result && (
          <pre className="code-block">
            {JSON.stringify(result, null, 2)}
          </pre>
        )}
      </Card>
    </div>
  );
}
