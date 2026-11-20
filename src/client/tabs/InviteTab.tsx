import { useState } from "react";
import { useApp } from "../hooks/useAppState";
import { useTenantData } from "../hooks/useTenantData";
import { useTenantMutation } from "../hooks/useMutation";
import { useToast } from "../components/Toast";
import { Card } from "../components/Card";
import { CopyField } from "../components/CopyField";
import { StatusBadge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { Loading } from "../components/Loading";
import { useConfirm } from "../components/ConfirmDialog";
import { invitationService } from "../services/invitations";
import { errorMessage, relativeTime, tryCopy } from "../lib/utils";
import type { SentInvitation } from "../lib/types";
import { LoadError } from "../components/LoadError";

export function InviteTab() {
  const { hasPerm, currentTenant } = useApp();
  const { toast, toastError } = useToast();
  const { data: invitations, loading, error, reload } = useTenantData<SentInvitation[]>("/invitations", []);
  const { mutate: revokeMutate, busy: revoking } = useTenantMutation();
  const [invitee, setInvitee] = useState("");
  const [sending, setSending] = useState(false);
  const [created, setCreated] = useState<SentInvitation | null>(null);
  const [shownLink, setShownLink] = useState<string | null>(null);
  const confirm = useConfirm();

  const isDid = invitee.trim().startsWith("did:");

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentTenant || !invitee.trim() || sending) return;
    setSending(true);
    try {
      const inv = await invitationService.send(currentTenant.id, invitee);
      setCreated(inv);
      setInvitee("");
      toast("Invitation created");
      await reload();
    } catch (err) {
      toastError(errorMessage(err, "Failed to create invitation"));
    } finally {
      setSending(false);
    }
  };

  const handleRevoke = async (invitationId: string) => {
    if (!(await confirm({ title: "Revoke this invitation?", message: "The link will stop working.", confirmLabel: "Revoke", danger: true }))) return;
    if (created?.id === invitationId) setCreated(null);
    await revokeMutate(
      `/invitations/${invitationId}`,
      { method: "DELETE" },
      { successMsg: "Invitation revoked", reload },
    );
  };

  const copyLink = async (inv: SentInvitation) => {
    if (!inv.inviteUrl) return;
    if (await tryCopy(inv.inviteUrl)) {
      setShownLink(null);
      toast("Invitation link copied");
    } else {
      setShownLink(inv.id);
    }
  };

  const pending = invitations.filter((i) => i.status === "pending");
  const past = invitations.filter((i) => i.status !== "pending");
  const who = (inv: SentInvitation) =>
    inv.inviteeHandle && !inv.inviteeHandle.startsWith("did:") ? `@${inv.inviteeHandle}` : inv.inviteeHandle || inv.inviteeDid;

  return (
    <div className="tab-content">
      <LoadError error={error} onRetry={reload} />
      {hasPerm("invite") && (
        <Card title="Invite someone">
          <p className="help-text">
            Enter their Bluesky handle or DID. You&apos;ll get an invitation link to send them yourself;
            nothing is sent automatically.
          </p>
          <form className="field" onSubmit={handleSend}>
            <label htmlFor="invitee">Handle or DID</label>
            <div className="inline-form">
              <input
                id="invitee"
                type="text"
                placeholder="handle.bsky.social or did:plc:..."
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={invitee}
                onChange={(e) => setInvitee(e.target.value)}
              />
              <button type="submit" disabled={sending || !invitee.trim()}>
                {sending ? "Creating…" : isDid ? "Invite DID" : "Create invitation"}
              </button>
            </div>
          </form>
          {created && (
            <div className="form-section" aria-live="polite">
              <h4>Invitation link for {who(created)}</h4>
              {created.inviteUrl ? (
                <>
                  <CopyField value={created.inviteUrl} label={`Invitation link for ${who(created)}`} />
                  <p className="help-text mt-8">
                    Send this link to them by DM, email, or however you like. It only works when they
                    sign in with the invited account.
                  </p>
                </>
              ) : (
                <p className="help-text">
                  The invitation was created. They will see it on their dashboard after signing in.
                </p>
              )}
            </div>
          )}
        </Card>
      )}

      <Card title="Pending invitations">
        {loading ? (
          <Loading />
        ) : error && pending.length === 0 ? null : pending.length === 0 ? (
          <EmptyState>No pending invitations.</EmptyState>
        ) : (
          <ul className="item-list">
            {pending.map((inv) => (
              <li key={inv.id} className="item-row item-row-wrap">
                <div className="item-info">
                  <span className="item-name">{who(inv)}</span>
                  <span className="item-detail">{relativeTime(inv.createdAt)}</span>
                </div>
                <div className="item-actions">
                  {inv.inviteUrl && (
                    <button
                      type="button"
                      className="btn-sm btn-ghost"
                      aria-label={`Copy invitation link for ${who(inv)}`}
                      onClick={() => { void copyLink(inv); }}
                    >
                      Copy link
                    </button>
                  )}
                  {hasPerm("invite") && (
                    <button
                      type="button"
                      className="btn-sm btn-danger"
                      aria-label={`Revoke invitation for ${who(inv)}`}
                      onClick={() => handleRevoke(inv.id)}
                      disabled={revoking}
                    >
                      Revoke
                    </button>
                  )}
                </div>
                {shownLink === inv.id && inv.inviteUrl && (
                  <div className="item-full">
                    <CopyField value={inv.inviteUrl} label={`Invitation link for ${who(inv)}`} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {past.length > 0 && (
        <Card title="Past invitations">
          <ul className="item-list">
            {past.map((inv) => (
              <li key={inv.id} className="item-row">
                <div className="item-info">
                  <span className="item-name">{who(inv)}</span>
                  <span className="item-detail">{relativeTime(inv.createdAt)}</span>
                </div>
                <StatusBadge status={inv.status} />
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
