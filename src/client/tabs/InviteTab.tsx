import { useState } from "react";
import { useApp } from "../hooks/useAppState";
import { useTenantData } from "../hooks/useTenantData";
import { useTenantMutation } from "../hooks/useMutation";
import { Card } from "../components/Card";
import { StatusBadge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { relativeTime } from "../lib/utils";
import type { SentInvitation } from "../lib/types";

export function InviteTab() {
  const { hasPerm } = useApp();
  const { data: invitations, loading, reload } = useTenantData<SentInvitation[]>("/invitations", []);
  const { mutate: sendMutate, busy: sending } = useTenantMutation();
  const { mutate: revokeMutate, busy: revoking } = useTenantMutation();
  const [handle, setHandle] = useState("");

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!handle.trim()) return;
    const ok = await sendMutate(
      "/invitations",
      { method: "POST", body: JSON.stringify({ handle: handle.trim() }) },
      { successMsg: "Invitation sent", reload },
    );
    if (ok) setHandle("");
  };

  const handleRevoke = async (invitationId: string) => {
    if (!confirm("Revoke this invitation?")) return;
    await revokeMutate(
      `/invitations/${invitationId}`,
      { method: "DELETE" },
      { successMsg: "Invitation revoked", reload },
    );
  };

  return (
    <div className="tab-content">
      {hasPerm("invite") && (
        <Card title="Send Invitation">
          <form className="invite-form" onSubmit={handleSend}>
            <input
              type="text"
              className="input"
              placeholder="handle.bsky.social"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
            />
            <button
              className="btn btn-primary"
              type="submit"
              disabled={sending || !handle.trim()}
            >
              {sending ? "Sending..." : "Send"}
            </button>
          </form>
        </Card>
      )}

      <Card title="Sent Invitations">
        {loading ? (
          <div className="loading">Loading...</div>
        ) : invitations.length === 0 ? (
          <EmptyState>No invitations sent yet.</EmptyState>
        ) : (
          <ul className="invitation-list">
            {invitations.map((inv) => (
              <li key={inv.id} className="invitation-row">
                <div className="invitation-info">
                  <span className="invitation-handle">
                    @{inv.inviteeHandle}
                  </span>
                  <span className="invitation-time">
                    {relativeTime(inv.createdAt)}
                  </span>
                </div>
                <div className="invitation-actions">
                  <StatusBadge status={inv.status} />
                  {inv.status === "pending" && hasPerm("invite") && (
                    <button
                      className="btn-sm btn-danger"
                      onClick={() => handleRevoke(inv.id)}
                      disabled={revoking}
                    >
                      Revoke
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
