import { useState } from "react";
import { credentialsService } from "../services/credentials";
import { useTenant } from "../hooks/session";
import { useToast } from "../components/Toast";
import { Card } from "../components/Card";
import { CodeBlock } from "../components/CodeBlock";

function CodeResult({ value, label }: { value: string | null; label: string }) {
  if (!value) return null;
  return <CodeBlock value={value} label={label} />;
}

export function CredentialsTab() {
  const { currentTenant } = useTenant();
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
  const [capResult, setCapResult] = useState<string | null>(null);

  // Verify form
  const [verifyJwt, setVerifyJwt] = useState("");
  const [verifyResult, setVerifyResult] = useState<string | null>(null);

  // Challenge
  const [challenge, setChallenge] = useState<string | null>(null);

  const busy = busyAction !== null;

  const issueMembership = async (e: React.FormEvent) => {
    e.preventDefault();
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

  const issueRole = async (e: React.FormEvent) => {
    e.preventDefault();
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

  const issueCapability = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentTenant || !capDid.trim() || !capName.trim()) return;
    setBusyAction("capability");
    try {
      const result = await credentialsService.issueCapability(
        currentTenant.id,
        capDid.trim(),
        capName.trim(),
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

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
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

  const handleChallenge = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentTenant) return;
    setBusyAction("challenge");
    try {
      const result = await credentialsService.generateChallenge(
        currentTenant.id,
      );
      setChallenge(result?.challenge ? JSON.stringify(result.challenge, null, 2) : null);
      toast("Challenge generated");
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Failed to generate challenge");
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="tab-content">
      <Card title="Issue a membership credential">
        <form className="field" onSubmit={issueMembership}>
          <label htmlFor="cred-member-did">Subject DID</label>
          <div className="inline-form">
            <input
              id="cred-member-did"
              type="text"
              className="mono"
              placeholder="did:plc:..."
              spellCheck={false}
              value={memberDid}
              onChange={(e) => setMemberDid(e.target.value)}
            />
            <button type="submit" disabled={busy || !memberDid.trim()}>
              {busyAction === "membership" ? "Issuing…" : "Issue"}
            </button>
          </div>
        </form>
        <CodeResult value={memberResult} label="Membership credential" />
      </Card>

      <Card title="Issue a role credential">
        <form className="form-stack" onSubmit={issueRole}>
          <div className="field">
            <label htmlFor="cred-role-did">Subject DID</label>
            <input
              id="cred-role-did"
              type="text"
              className="mono"
              placeholder="did:plc:..."
              spellCheck={false}
              value={roleDid}
              onChange={(e) => setRoleDid(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="cred-role-perms">Permissions to attest</label>
            <input
              id="cred-role-perms"
              type="text"
              value={rolePerms}
              onChange={(e) => setRolePerms(e.target.value)}
              aria-describedby="cred-role-perms-help"
            />
            <p className="help-text" id="cred-role-perms-help">
              Comma-separated. Leave blank for all permissions of the member&apos;s role.
            </p>
          </div>
          <button type="submit" disabled={busy || !roleDid.trim()}>
            {busyAction === "role" ? "Issuing…" : "Issue"}
          </button>
        </form>
        <CodeResult value={roleResult} label="Role credential" />
      </Card>

      <Card title="Issue a capability credential">
        <form className="form-stack" onSubmit={issueCapability}>
          <div className="field">
            <label htmlFor="cred-cap-did">Subject DID</label>
            <input
              id="cred-cap-did"
              type="text"
              className="mono"
              placeholder="did:plc:..."
              spellCheck={false}
              value={capDid}
              onChange={(e) => setCapDid(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="cred-cap-name">Capability</label>
            <input
              id="cred-cap-name"
              type="text"
              value={capName}
              onChange={(e) => setCapName(e.target.value)}
              aria-describedby="cred-cap-name-help"
            />
            <p className="help-text" id="cred-cap-name-help">
              A permission the member holds, for example <code>create_posts</code>.
            </p>
          </div>
          <button type="submit" disabled={busy || !capDid.trim() || !capName.trim()}>
            {busyAction === "capability" ? "Issuing…" : "Issue"}
          </button>
        </form>
        <CodeResult value={capResult} label="Capability credential" />
      </Card>

      <Card title="Verify a credential">
        <form className="form-stack" onSubmit={handleVerify}>
          <div className="field">
            <label htmlFor="cred-verify-jwt">Credential (JWT)</label>
            <textarea
              id="cred-verify-jwt"
              className="mono"
              spellCheck={false}
              value={verifyJwt}
              onChange={(e) => setVerifyJwt(e.target.value)}
              rows={4}
            />
          </div>
          <button type="submit" disabled={busy || !verifyJwt.trim()}>
            {busyAction === "verify" ? "Verifying…" : "Verify"}
          </button>
        </form>
        <CodeResult value={verifyResult} label="Verification result" />
      </Card>

      <Card title="Holder challenge">
        <form onSubmit={handleChallenge}>
          <button type="submit" disabled={busy}>
            {busyAction === "challenge" ? "Generating…" : "Generate challenge"}
          </button>
        </form>
        <CodeResult value={challenge} label="Challenge" />
      </Card>
    </div>
  );
}
