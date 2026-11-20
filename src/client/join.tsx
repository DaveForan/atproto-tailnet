import { StrictMode, useCallback, useEffect, useState } from "react";
import { errorMessage } from "./lib/utils";
import { createRoot } from "react-dom/client";
import { api, fetchCsrfToken } from "./services/api";
import { ToastProvider, useToast } from "./components/Toast";
import { applyTheme } from "./lib/theme";

applyTheme();

interface JoinTenant {
  id: string;
  name: string;
  joinOpen: boolean;
}

interface JoinRequest {
  status: "pending" | "approved" | "rejected";
  requestedAt: string;
}

type JoinState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "not-found" }
  | { kind: "closed"; name: string }
  | { kind: "login"; name: string; slug: string }
  | { kind: "already-member"; name: string }
  | { kind: "pending"; name: string; requestedAt: string }
  | { kind: "approved"; name: string }
  | { kind: "rejected"; name: string; tenantId: string }
  | { kind: "open"; name: string; tenantId: string };

function JoinApp() {
  const slug = window.location.pathname.split("/join/")[1] || "";
  const [state, setState] = useState<JoinState>({ kind: "loading" });
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { toast, toastError } = useToast();

  const init = useCallback(async () => {
    try {
      const tenant = await api<JoinTenant>(
        `/api/tenants/by-slug/${encodeURIComponent(slug)}/public`,
      ).catch(() => null);
      if (!tenant) {
        setState({ kind: "not-found" });
        return;
      }

      const me = await api<{ id: string }>("/api/me");
      const loggedIn = !!me?.id;

      if (loggedIn) {
        // GET /api/tenants/:id is 200 for members, 404 otherwise
        const existing = await api<{ id: string }>(`/api/tenants/${tenant.id}`).catch(() => null);
        if (existing?.id) {
          setState({ kind: "already-member", name: tenant.name });
          return;
        }
      }

      if (!tenant.joinOpen) {
        setState({ kind: "closed", name: tenant.name });
        return;
      }

      if (!loggedIn) {
        setState({ kind: "login", name: tenant.name, slug });
        return;
      }

      await fetchCsrfToken();

      const mine = await api<JoinRequest[]>(
        `/api/tenants/${tenant.id}/join-requests/mine`,
      );

      if (mine && mine.length > 0) {
        const latest = mine.reduce((a, b) =>
          new Date(b.requestedAt).getTime() > new Date(a.requestedAt).getTime() ? b : a,
        );
        if (latest.status === "pending") {
          setState({ kind: "pending", name: tenant.name, requestedAt: latest.requestedAt });
          return;
        }
        if (latest.status === "approved") {
          setState({ kind: "approved", name: tenant.name });
          return;
        }
        if (latest.status === "rejected") {
          setState({ kind: "rejected", name: tenant.name, tenantId: tenant.id });
          return;
        }
      }

      setState({ kind: "open", name: tenant.name, tenantId: tenant.id });
    } catch (e) {
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : "Something went wrong",
      });
    }
  }, [slug]);

  useEffect(() => { init(); }, [init]);

  const submitRequest = async (tenantId: string) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await api(`/api/tenants/${tenantId}/join-requests`, {
        method: "POST",
        body: JSON.stringify({ message: message.trim() || undefined }),
      });
      toast("Request submitted!");
      await init();
    } catch (e) {
      toastError(errorMessage(e, "Failed to submit request"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="join-container">
      <div className="card join-card">
        {state.kind === "loading" && <p>Loading...</p>}

        {state.kind === "error" && (
          <>
            <h1>Something went wrong</h1>
            <p className="text-dim">{state.message}</p>
            <a href="/">Go to dashboard</a>
          </>
        )}

        {state.kind === "not-found" && (
          <>
            <h1>Tailnet not found</h1>
            <p className="text-dim">
              This tailnet does not exist or is not accepting requests.
            </p>
            <a href="/">Go to dashboard</a>
          </>
        )}

        {state.kind === "closed" && (
          <>
            <h1>{state.name}</h1>
            <p className="text-dim">
              This tailnet is not currently accepting join requests.
            </p>
            <a href="/">Go to dashboard</a>
          </>
        )}

        {state.kind === "login" && (
          <>
            <h1>{state.name}</h1>
            <p className="text-dim">
              Sign in with your Bluesky identity to request access.
            </p>
            <form action="/auth/login" method="get" className="inline-form justify-center">
              <input
                type="text"
                name="handle"
                placeholder="yourname.bsky.social"
                required
                className="w-220"
              />
              <input type="hidden" name="redirect" value={`/join/${slug}`} />
              <button type="submit">Sign in</button>
            </form>
          </>
        )}

        {state.kind === "already-member" && (
          <>
            <h1>{state.name}</h1>
            <p className="text-dim">You are already a member of this tailnet.</p>
            <a href="/">Go to dashboard</a>
          </>
        )}

        {state.kind === "pending" && (
          <>
            <h1>{state.name}</h1>
            <p className="text-dim">Your request to join is pending review.</p>
            <span className="badge badge-pending">Pending</span>
            <p className="text-dim text-sm mt-16">
              Submitted {new Date(state.requestedAt).toLocaleString()}
            </p>
            <p className="mt-16"><a href="/">Go to dashboard</a></p>
          </>
        )}

        {state.kind === "approved" && (
          <>
            <h1>{state.name}</h1>
            <p className="text-dim">Your request was approved! You are now a member.</p>
            <span className="badge badge-running">Approved</span>
            <p className="mt-16"><a href="/">Go to dashboard</a></p>
          </>
        )}

        {state.kind === "rejected" && (
          <>
            <h1>{state.name}</h1>
            <p className="text-dim">Your previous request was declined.</p>
            <span className="badge badge-stopped">Rejected</span>
            <div className="mt-16">
              <textarea
                placeholder="Add an optional message (max 500 chars)"
                maxLength={500}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
              <button
                onClick={() => submitRequest(state.tenantId)}
                disabled={submitting}
                className="mt-8"
              >
                Request Again
              </button>
            </div>
          </>
        )}

        {state.kind === "open" && (
          <>
            <h1>{state.name}</h1>
            <p className="text-dim">
              Request to join this tailnet. The owner will review your request.
            </p>
            <div>
              <textarea
                placeholder="Add an optional message (max 500 chars)"
                maxLength={500}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
              <button
                onClick={() => submitRequest(state.tenantId)}
                disabled={submitting}
                className="mt-8"
              >
                Request to Join
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <ToastProvider>
      <JoinApp />
    </ToastProvider>
  </StrictMode>,
);
