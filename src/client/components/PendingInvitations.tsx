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
    <section className="card" aria-labelledby="pending-invitations-heading">
      <div className="card-header">
        <h3 id="pending-invitations-heading">Invitations for you</h3>
      </div>
      <ul className="item-list">
        {invitations.map((inv) => (
          <li key={inv.id} className="item-row">
            <div className="item-info">
              <span className="item-name">{inv.tenantName}</span>
              <span className="item-detail">from {inv.inviterDisplayName || inv.inviterHandle}</span>
            </div>
            <div className="item-actions">
              <button
                type="button"
                className="btn-sm"
                disabled={busy}
                aria-label={`Accept invitation to ${inv.tenantName}`}
                onClick={() => act(inv.id, true)}
              >
                Accept
              </button>
              <button
                type="button"
                className="btn-sm btn-ghost"
                disabled={busy}
                aria-label={`Decline invitation to ${inv.tenantName}`}
                onClick={() => act(inv.id, false)}
              >
                Decline
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
