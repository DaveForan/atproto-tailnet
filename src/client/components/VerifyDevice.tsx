import { useCallback, useEffect, useRef, useState } from "react";
import { Card } from "./Card";
import { deviceTrustService } from "../services/device-trust";
import { ensureDeviceKey, loadDeviceKey, setDeviceId, signChallenge, suggestedDeviceName, deviceKeysSupported } from "../lib/device-key";
import { errorMessage, localRedirect } from "../lib/utils";

type View =
  | { kind: "checking" }
  | { kind: "no-session" }
  | { kind: "untrusted"; handle: string | null }
  | { kind: "waiting"; code: string }
  | { kind: "ended"; message: string };

/**
 * Second step of sign-in for an account with trusted devices (ADR-0035). A
 * trusted browser passes without a prompt. Another browser can ask to be
 * added (confirmed with a code on a trusted device) or use a recovery code.
 */
export function VerifyDevicePage() {
  const [view, setView] = useState<View>({ kind: "checking" });
  const [name, setName] = useState(suggestedDeviceName());
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const poll = useRef<number | null>(null);

  const finish = (redirect: string) => {
    window.location.replace(localRedirect(redirect));
  };

  /** Prove this browser if it holds a trusted key. Returns true when signed in. */
  const tryVerify = useCallback(async (): Promise<"ok" | "untrusted" | "none"> => {
    const pending = await deviceTrustService.pending();
    if (!pending) return "none";
    const key = await loadDeviceKey();
    if (key?.deviceId) {
      try {
        const r = await deviceTrustService.verify(key.deviceId, await signChallenge(key, pending.challenge));
        if (r) {
          finish(r.redirect);
          return "ok";
        }
      } catch {
        // falls through: this browser is not (or no longer) trusted
      }
    }
    setView({ kind: "untrusted", handle: pending.handle });
    return "untrusted";
  }, []);

  useEffect(() => {
    tryVerify()
      .then((r) => r === "none" && setView({ kind: "no-session" }))
      .catch(() => setView({ kind: "no-session" }));
    return () => {
      if (poll.current) window.clearInterval(poll.current);
    };
  }, [tryVerify]);

  const requestTrust = async () => {
    setBusy(true);
    setError(null);
    try {
      const key = await ensureDeviceKey();
      const r = await deviceTrustService.requestTrust(name.trim(), key.publicJwk);
      if (!r) return setView({ kind: "no-session" });
      setView({ kind: "waiting", code: r.code });
      poll.current = window.setInterval(async () => {
        try {
          const s = await deviceTrustService.requestStatus();
          if (!s || s.status === "pending") return;
          if (poll.current) window.clearInterval(poll.current);
          if (s.status === "approved" && s.deviceId) {
            await setDeviceId(s.deviceId);
            await tryVerify();
          } else {
            setView({
              kind: "ended",
              message: s.status === "expired" ? "The request expired." : "The request was refused on your trusted device.",
            });
          }
        } catch {
          // keep polling; a failed poll is not an answer
        }
      }, 4000);
    } catch (e) {
      setError(errorMessage(e, "Could not send the request"));
    } finally {
      setBusy(false);
    }
  };

  const useRecoveryCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await deviceTrustService.recover(code);
      if (r) finish("/#account");
      else setView({ kind: "no-session" });
    } catch (e) {
      setError(errorMessage(e, "That recovery code is not valid"));
    } finally {
      setBusy(false);
    }
  };

  const signOut = (
    <form action="/auth/logout" method="post">
      <button type="submit" className="btn-ghost">Cancel and sign out</button>
    </form>
  );

  return (
    <main className="access-main">
      <div className="access-page">
        {view.kind === "checking" && <div className="loading" role="status">Checking this device…</div>}

        {view.kind === "no-session" && (
          <Card title="Sign in first">
            <p>There is no sign-in waiting for a device check.</p>
            <a className="btn mt-12" href="/">Go to sign-in</a>
          </Card>
        )}

        {view.kind === "untrusted" && (
          <>
            <Card title="This device is not trusted yet">
              <p>
                {view.handle ? `@${view.handle} only allows sign-in from trusted devices.` : "This account only allows sign-in from trusted devices."}{" "}
                The sign-in is on hold, and the account owner was told about this attempt.
              </p>
            </Card>
            <Card title="Ask a trusted device to add this one">
              {deviceKeysSupported() ? (
                <form className="form-stack" onSubmit={(e) => { e.preventDefault(); void requestTrust(); }}>
                  <div className="field">
                    <label htmlFor="new-device-name">Name for this device</label>
                    <input id="new-device-name" type="text" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} required />
                  </div>
                  <button type="submit" disabled={busy || !name.trim()}>{busy ? "Sending…" : "Ask for approval"}</button>
                </form>
              ) : (
                <p className="notice" role="alert">This browser cannot hold a device key (private browsing may block it). Use a recovery code.</p>
              )}
            </Card>
            <Card title="Use a recovery code">
              <form className="form-stack" onSubmit={(e) => { e.preventDefault(); void useRecoveryCode(); }}>
                <div className="field">
                <label htmlFor="recovery-code">Recovery code</label>
                <input
                  id="recovery-code"
                  type="text"
                  className="mono"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="XXXXX-XXXXX"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  aria-describedby="recovery-code-help"
                  required
                />
                <p className="help-text" id="recovery-code-help">Each code works once. After it, you add this device as a trusted device.</p>
                </div>
                <button type="submit" className="btn-ghost" disabled={busy || code.trim().length < 10}>Sign in with the code</button>
              </form>
            </Card>
            {error && <p className="form-error" role="alert">{error}</p>}
            {signOut}
          </>
        )}

        {view.kind === "waiting" && (
          <Card title="Confirm on a trusted device">
            <p>On a device you already trust, open <strong>Account</strong>, find this request and type this code:</p>
            <p className="pairing-code mono" aria-label="Confirmation code">{view.code}</p>
            <p className="help-text" role="status">Waiting for your approval. The code is valid for 10 minutes.</p>
            {signOut}
          </Card>
        )}

        {view.kind === "ended" && (
          <Card title="This device was not added">
            <p role="alert">{view.message}</p>
            <a className="btn mt-12" href="/">Start again</a>
          </Card>
        )}
      </div>
    </main>
  );
}
