import { useState } from "react";
import { errorMessage } from "../lib/utils";
import { invitationService } from "../services/invitations";
import { useToast } from "./Toast";
import type { Invitation } from "../lib/types";

export function PendingInvitations({
  invitations,
  onAction,
}: {
  invitations: Invitation[];
  onAction: () => void;
}) {
  const { toast, toastError } = useToast();
  const [busy, setBusy] = useState(false);

  if (!invitations || invitations.length === 0) return null;

  const act = async (id: string, accept: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      if (accept) await invitationService.accept(id);
      else await invitationService.decline(id);
      toast(accept ? "Invitation accepted" : "Invitation declined");
      onAction();
    } catch (e) {
      toastError(errorMessage(e, accept ? "Failed to accept invitation" : "Failed to decline invitation"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="section" aria-labelledby="pending-invitations-heading">
      <h2 id="pending-invitations-heading">Pending Invitations</h2>
      <div className="card">
        {invitations.map((inv) => (
          <div key={inv.id} className="invitation-item">
            <div>
              <strong>{inv.tenantName}</strong>
              <br />
              <span className="text-dim text-sm">
                from {inv.inviterDisplayName || inv.inviterHandle}
              </span>
            </div>
            <div className="btn-group">
              <button className="btn-sm" disabled={busy} onClick={() => act(inv.id, true)}>
                Accept
              </button>
              <button className="btn-sm btn-ghost" disabled={busy} onClick={() => act(inv.id, false)}>
                Decline
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
