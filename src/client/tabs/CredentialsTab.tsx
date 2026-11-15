import { useState } from "react";
import { credentialsService } from "../services/credentials";
import { useApp } from "../hooks/useAppState";
import { useToast } from "../components/Toast";
import { Card } from "../components/Card";
import { copyToClipboard } from "../lib/utils";

function CodeResult({ value, label }: { value: string | null; label: string }) {
  const { toast } = useToast();
  if (!value) return null;
  return (
    <div className="code-block-wrapper">
      <code className="code-block">{value}</code>
      <button
        className="btn-sm btn-ghost"
        onClick={() => {
          copyToClipboard(value);
          toast(`${label} copied`);
        }}
      >
        Copy
      </button>
    </div>
  );
}

export function CredentialsTab() {
  const { currentTenant } = useApp();
  const { toast, toastError } = useToast();

  // Track which action is in-flight (null = idle)
  const [busyAction, setBusyAction] = useState<string | null>(null);

  // Membership form
  const [memberDid, setMemberDid] = useState("");
  const [memberResult, setMemberResult] = useState<string | null>(null);

  // Role form
  const [roleDid, setRoleDid] = useState("");
  const [rolePerms, setRolePerms] = useState("");
  const [roleResult, setRoleResult] = useState<string | null>(null);

  // Capability form
  const [capDid, setCapDid] = useState("");
  const [capName, setCapName] = useState("");
  const [capResource, setCapResource] = useState("");
  const [capResult, setCapResult] = useState<string | null>(null);

  // Verify form
  const [verifyJwt, setVerifyJwt] = useState("");
  const [verifyResult, setVerifyResult] = useState<string | null>(null);

  // Challenge
  const [challenge, setChallenge] = useState<string | null>(null);

  const busy = busyAction !== null;

  const issueMembership = async () => {
    if (!currentTenant || !memberDid.trim()) return;
    setBusyAction("membership");
    try {
      const result = await credentialsService.issueMembership(
        currentTenant.id,
        memberDid.trim(),
      );
      setMemberResult(result?.jwt ?? null);
      toast("Membership credential issued");
    } catch (e) {
      toastError(
        e instanceof Error ? e.message : "Failed to issue membership",
      );
    } finally {
      setBusyAction(null);
    }
  };

  const issueRole = async () => {
    if (!currentTenant || !roleDid.trim()) return;
    setBusyAction("role");
    const roleName = rolePerms.trim();
    try {
      const result = await credentialsService.issueRole(
        currentTenant.id,
        roleDid.trim(),
        roleName,
      );
      setRoleResult(result?.jwt ?? null);
      toast("Role credential issued");
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Failed to issue role");
    } finally {
      setBusyAction(null);
    }
  };

  const issueCapability = async () => {
    if (!currentTenant || !capDid.trim() || !capName.trim()) return;
    setBusyAction("capability");
    try {
      const result = await credentialsService.issueCapability(
        currentTenant.id,
        capDid.trim(),
        capName.trim(),
        capResource.trim() || undefined,
      );
      setCapResult(result?.jwt ?? null);
      toast("Capability credential issued");
    } catch (e) {
      toastError(
        e instanceof Error ? e.message : "Failed to issue capability",
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleVerify = async () => {
    if (!verifyJwt.trim()) return;
    setBusyAction("verify");
    try {
      const result = await credentialsService.verify(verifyJwt.trim());
      setVerifyResult(
        result ? JSON.stringify(result, null, 2) : "No response",
      );
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Verification failed");
    } finally {
      setBusyAction(null);
    }
  };

  const handleChallenge = async () => {
    if (!currentTenant) return;
    setBusyAction("challenge");
    try {
      const result = await credentialsService.generateChallenge(
        currentTenant.id,
      );
      setChallenge(result?.challenge ?? null);
      toast("Challenge generated");
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Failed to generate challenge");
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="tab-content">
      <Card title="Issue Membership Credential">
        <div className="form-row">
          <input
            type="text"
            placeholder="Subject DID"
            value={memberDid}
            onChange={(e) => setMemberDid(e.target.value)}
          />
          <button className="btn-primary" onClick={issueMembership} disabled={busy}>
            {busyAction === "membership" ? "Issuing..." : "Issue"}
          </button>
        </div>
        <CodeResult value={memberResult} label="Credential" />
      </Card>

      <Card title="Issue Role Credential">
        <div className="form-stack">
          <input
            type="text"
            placeholder="Subject DID"
            value={roleDid}
            onChange={(e) => setRoleDid(e.target.value)}
          />
          <input
            type="text"
            placeholder="Permissions (comma-separated)"
            value={rolePerms}
            onChange={(e) => setRolePerms(e.target.value)}
          />
          <button className="btn-primary" onClick={issueRole} disabled={busy}>
            {busyAction === "role" ? "Issuing..." : "Issue"}
          </button>
        </div>
        <CodeResult value={roleResult} label="Credential" />
      </Card>

      <Card title="Issue Capability Credential">
        <div className="form-stack">
          <input
            type="text"
            placeholder="Subject DID"
            value={capDid}
            onChange={(e) => setCapDid(e.target.value)}
          />
          <input
            type="text"
            placeholder="Capability name"
            value={capName}
            onChange={(e) => setCapName(e.target.value)}
          />
          <input
            type="text"
            placeholder="Resource"
            value={capResource}
            onChange={(e) => setCapResource(e.target.value)}
          />
          <button className="btn-primary" onClick={issueCapability} disabled={busy}>
            {busyAction === "capability" ? "Issuing..." : "Issue"}
          </button>
        </div>
        <CodeResult value={capResult} label="Credential" />
      </Card>

      <Card title="Verify Credential">
        <div className="form-stack">
          <textarea
            placeholder="Paste JWT here"
            value={verifyJwt}
            onChange={(e) => setVerifyJwt(e.target.value)}
            rows={4}
          />
          <button className="btn-primary" onClick={handleVerify} disabled={busy}>
            {busyAction === "verify" ? "Verifying..." : "Verify"}
          </button>
        </div>
        <CodeResult value={verifyResult} label="Result" />
      </Card>

      <Card title="Challenge">
        <button className="btn-primary" onClick={handleChallenge} disabled={busy}>
          {busyAction === "challenge" ? "Generating..." : "Generate Challenge"}
        </button>
        <CodeResult value={challenge} label="Challenge" />
      </Card>
    </div>
  );
}
