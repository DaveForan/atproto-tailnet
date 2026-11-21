import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useSession } from "../hooks/session";
import { useTabRoute } from "../hooks/useTabRoute";
import { useToast } from "./Toast";
import { Card } from "./Card";
import { Loading } from "./Loading";
import { Badge } from "./Badge";
import { PendingInvitations } from "./PendingInvitations";
import { instanceService } from "../services/instance";
import { invitationService } from "../services/invitations";
import { ApiError } from "../services/api";
import { errorMessage } from "../lib/utils";
import type { InvitationDetail } from "../lib/types";

const InstanceTab = lazy(() => import("../tabs/InstanceTab").then((m) => ({ default: m.InstanceTab })));

function SignOutButton({ className = "btn-ghost" }: { className?: string }) {
  return (
    <form action="/auth/logout" method="post" className="inline-block">
      <button className={className} type="submit">Sign out</button>
    </form>
  );
}

export function NoAccessPage() {
  const { user, invitations, reload } = useSession();
  const { tab, setTab } = useTabRoute();
  if (!user) return null;

  if (user.isOperator && tab === "instance") {
    return (
      <main>
        <button type="button" className="btn-sm btn-ghost mb-12" onClick={() => setTab("status")}>
          &larr; Back
        </button>
        <Suspense fallback={<Loading />}>
          <InstanceTab />
        </Suspense>
      </main>
    );
  }

  return (
    <main className="access-main">
      <div className="access-page">
        <h1>Welcome, @{user.handle}</h1>
        <p className="text-dim">You&apos;re signed in, but you aren&apos;t a member of any tailnet on this instance yet.</p>
        {user.canCreateTailnet && (
          <p className="help-text mt-8">
            You&apos;re allowed to create a tailnet. Sign out and sign in again to provision it.
          </p>
        )}
        <PendingInvitations invitations={invitations} onAction={() => { void reload(); }} />
        <JoinDefaultTailnet hasInvitations={invitations.length > 0} />
        <div className="btn-group mt-16">
          {user.isOperator && (
            <button type="button" onClick={() => setTab("instance")}>Open Instance settings</button>
          )}
          <SignOutButton />
        </div>
      </div>
    </main>
  );
}

type JoinState =
  | { kind: "loading" }
  | { kind: "invite-only" }
  | { kind: "error"; message: string }
  | { kind: "open"; tenantId: string; name: string }
  | { kind: "pending"; name: string; requestedAt: string }
  | { kind: "rejected"; tenantId: string; name: string }
  | { kind: "approved"; name: string };

function JoinDefaultTailnet({ hasInvitations }: { hasInvitations: boolean }) {
  const { reload } = useSession();
  const { toast, toastFailure } = useToast();
  const [state, setState] = useState<JoinState>({ kind: "loading" });
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      const instance = await instanceService.get();
      const def = instance?.defaultTailnet;
      if (!def || !def.acceptsJoinRequests) {
        setState({ kind: "invite-only" });
        return;
      }
      const tenant = await instanceService.publicTenant(def.address).catch(() => null);
      if (!tenant || !tenant.joinOpen) {
        setState({ kind: "invite-only" });
        return;
      }
      const mine = (await instanceService.myJoinRequests(tenant.id)) ?? [];
      const latest = mine.reduce<(typeof mine)[number] | null>(
        (a, b) => (!a || new Date(b.requestedAt) > new Date(a.requestedAt) ? b : a),
        null,
      );
      const name = def.name || tenant.name;
      if (latest?.status === "pending") setState({ kind: "pending", name, requestedAt: latest.requestedAt });
      else if (latest?.status === "approved") setState({ kind: "approved", name });
      else if (latest?.status === "rejected") setState({ kind: "rejected", tenantId: tenant.id, name });
      else setState({ kind: "open", tenantId: tenant.id, name });
    } catch (e) {
      setState({ kind: "error", message: errorMessage(e, "Failed to load instance information") });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const submit = async (tenantId: string) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await instanceService.requestToJoin(tenantId, message);
      toast("Request submitted");
      setMessage("");
      await load();
    } catch (e) {
      toastFailure(e, "Failed to submit request");
    } finally {
      setSubmitting(false);
    }
  };

  if (state.kind === "loading") return <Loading />;

  if (state.kind === "error") {
    return (
      <Card>
        <p role="alert">{state.message}</p>
        <button type="button" className="btn-sm mt-8" onClick={() => { void load(); }}>Retry</button>
      </Card>
    );
  }

  if (state.kind === "invite-only") {
    return (
      <Card>
        <p>
          {hasInvitations
            ? "This instance is invite-only. Accept an invitation above to get started."
            : "This instance is invite-only. Ask an administrator for an invitation link."}
        </p>
      </Card>
    );
  }

  const requestForm = (tenantId: string, label: string) => (
    <div className="form-stack mt-12">
      <label htmlFor="join-message" className="text-sm">Message to the admins (optional)</label>
      <textarea
        id="join-message"
        maxLength={500}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
      />
      <div>
        <button type="button" onClick={() => { void submit(tenantId); }} disabled={submitting}>
          {submitting ? "Sending..." : label}
        </button>
      </div>
    </div>
  );

  return (
    <Card title={`Request to join ${state.name}`}>
      {state.kind === "open" && (
        <>
          <p className="help-text">An admin of {state.name} will review your request.</p>
          {requestForm(state.tenantId, `Request to join ${state.name}`)}
        </>
      )}
      {state.kind === "pending" && (
        <p>
          <Badge variant="pending">Pending</Badge>{" "}
          Your request was sent {new Date(state.requestedAt).toLocaleString()} and is waiting for review.
        </p>
      )}
      {state.kind === "approved" && (
        <>
          <p><Badge variant="running">Approved</Badge> Your request was approved.</p>
          <button type="button" className="mt-8" onClick={() => { void reload(); }}>Open dashboard</button>
        </>
      )}
      {state.kind === "rejected" && (
        <>
          <p><Badge variant="stopped">Declined</Badge> Your previous request was declined. You can send a new one.</p>
          {requestForm(state.tenantId, "Request again")}
        </>
      )}
    </Card>
  );
}

type InviteState =
  | { kind: "loading" }
  | { kind: "not-found" }
  | { kind: "error"; message: string }
  | { kind: "ready"; invitation: InvitationDetail };

const STATUS_TEXT: Record<string, string> = {
  accepted: "You've already accepted this invitation.",
  declined: "You declined this invitation.",
  revoked: "This invitation was revoked by the tailnet's admins.",
};

export function InvitePage({ id, onDone }: { id: string; onDone: (slug?: string) => void }) {
  const { user } = useSession();
  const { toast, toastFailure } = useToast();
  const [state, setState] = useState<InviteState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    invitationService
      .get(id)
      .then((invitation) => {
        if (cancelled) return;
        setState(invitation ? { kind: "ready", invitation } : { kind: "not-found" });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) setState({ kind: "not-found" });
        else setState({ kind: "error", message: errorMessage(e, "Failed to load invitation") });
      });
    return () => { cancelled = true; };
  }, [id]);

  const act = async (accept: boolean, slug: string) => {
    setBusy(true);
    try {
      if (accept) await invitationService.accept(id);
      else await invitationService.decline(id);
      toast(accept ? "Invitation accepted" : "Invitation declined");
      onDone(accept ? slug : undefined);
    } catch (e) {
      toastFailure(e, accept ? "Failed to accept invitation" : "Failed to decline invitation");
      setBusy(false);
    }
  };

  return (
    <main className="access-main">
      <div className="access-page text-center">
        {state.kind === "loading" && <p>Loading invitation...</p>}

        {state.kind === "not-found" && (
          <>
            <h1>This invitation isn&apos;t for this account</h1>
            <p className="text-dim">
              You&apos;re signed in as @{user?.handle}. If you were invited with a different Bluesky
              account, sign out, then open the invitation link again and sign in with that account.
            </p>
            <div className="btn-group justify-center mt-16">
              <SignOutButton className="" />
              <button type="button" className="btn-ghost" onClick={() => onDone()}>Go to dashboard</button>
            </div>
          </>
        )}

        {state.kind === "error" && (
          <>
            <h1>Couldn&apos;t load this invitation</h1>
            <p className="text-dim" role="alert">{state.message}</p>
            <button type="button" className="mt-16" onClick={() => onDone()}>Go to dashboard</button>
          </>
        )}

        {state.kind === "ready" && state.invitation.status === "pending" && (
          <>
            <h1>@{state.invitation.inviterHandle} invited you to {state.invitation.tenant.name}</h1>
            <p className="text-dim">Accept to join the tailnet and start adding your devices.</p>
            <div className="btn-group justify-center mt-16">
              <button type="button" disabled={busy} onClick={() => { void act(true, state.invitation.tenant.slug); }}>
                Accept
              </button>
              <button type="button"
                className="btn-ghost"
                disabled={busy}
                onClick={() => { void act(false, state.invitation.tenant.slug); }}
              >
                Decline
              </button>
            </div>
          </>
        )}

        {state.kind === "ready" && state.invitation.status !== "pending" && (
          <>
            <h1>{state.invitation.tenant.name}</h1>
            <p className="text-dim">{STATUS_TEXT[state.invitation.status] ?? "This invitation is no longer open."}</p>
            <button type="button"
              className="mt-16"
              onClick={() => onDone(state.invitation.status === "accepted" ? state.invitation.tenant.slug : undefined)}
            >
              Go to dashboard
            </button>
          </>
        )}
      </div>
    </main>
  );
}

export function SuspendedPage() {
  const { currentTenant, tenants, selectTenant } = useSession();
  if (!currentTenant) return null;
  const others = tenants.filter((t) => t.id !== currentTenant.id);

  return (
    <main className="access-main">
      <div className="access-page">
        <h1>{currentTenant.name} is suspended</h1>
        <p className="text-dim">
          The instance operator has suspended this tailnet. Its devices can&apos;t connect and its
          dashboard is unavailable until it is unsuspended. Contact the instance operator if you
          think this is a mistake.
        </p>
        {others.length > 0 && (
          <div className="form-stack mt-16">
            <label htmlFor="suspended-switch" className="text-sm">Switch to another tailnet</label>
            <select
              id="suspended-switch"
              value=""
              onChange={(e) => { if (e.target.value) selectTenant(e.target.value); }}
            >
              <option value="">Choose a tailnet...</option>
              {others.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
        )}
        <div className="mt-16"><SignOutButton /></div>
      </div>
    </main>
  );
}
