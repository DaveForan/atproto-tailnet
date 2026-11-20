import { useCallback, useEffect, useState } from "react";
import { useToast } from "../components/Toast";
import { useConfirm } from "../components/ConfirmDialog";
import { Card } from "../components/Card";
import { Badge } from "../components/Badge";
import { errorMessage, errorCode } from "../lib/utils";
import { THEMES, currentTheme, setTheme, type ThemeId } from "../lib/theme";
import { deviceTrustService, type TrustState } from "../services/device-trust";
import { deviceKeysSupported, forgetDeviceKey, suggestedDeviceName } from "../lib/device-key";

function ThemePicker() {
  const [theme, setCurrent] = useState<ThemeId>(currentTheme());
  return (
    <div className="theme-grid" role="radiogroup" aria-label="Colour theme">
      {THEMES.map((t) => (
        <button
          key={t.id}
          type="button"
          role="radio"
          aria-checked={theme === t.id}
          className="theme-option"
          onClick={() => {
            setTheme(t.id);
            setCurrent(t.id);
          }}
        >
          <span className="theme-swatch" aria-hidden="true">
            <span className={`swatch-${t.id}-bg`} />
            <span className={`swatch-${t.id}-accent`} />
            <span className={`swatch-${t.id}-ink`} />
          </span>
          <strong>{t.name}</strong>
          <span className="text-dim text-sm">{t.description}</span>
        </button>
      ))}
    </div>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div className="form-stack">
      <p className="notice">
        <strong>Save these recovery codes now.</strong> They are shown once. Each code signs you in one time if you
        lose every trusted device. Without a trusted device or a code, only someone with access to the server can
        restore your sign-in.
      </p>
      <ul className="code-grid mono">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="btn-group">
        <button type="button"
          className="btn-sm btn-ghost"
          onClick={() => { void navigator.clipboard?.writeText(codes.join("\n")); }}
        >
          Copy all
        </button>
        <button type="button" className="btn-sm" onClick={onDone}>I saved them</button>
      </div>
    </div>
  );
}

/** Trusted devices: the lock that limits sign-in to chosen devices (ADR-0035). */
function TrustedDevices({ onChanged }: { onChanged?: () => void }) {
  const { toast, toastError } = useToast();
  const confirm = useConfirm();
  const [state, setState] = useState<TrustState | null>(null);
  const [name, setName] = useState(suggestedDeviceName());
  const [codes, setCodes] = useState<string[] | null>(null);
  const [pairing, setPairing] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await deviceTrustService.state());
    } catch {
      setState(null);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  /** Run a change that needs a fresh proof; proves this device first when asked to. */
  const guarded = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn(); // the API layer proves this device again when the server asks
      toast(done);
      await load();
      onChanged?.();
    } catch (e) {
      toastError(
        errorCode(e) === "device_not_trusted"
          ? "This browser is not one of your trusted devices, so it cannot change the lock."
          : errorMessage(e, "That did not work"),
      );
    } finally {
      setBusy(false);
    }
  };

  if (!state) return <div className="loading" role="status">Loading…</div>;
  if (codes) {
    return (
      <RecoveryCodes
        codes={codes}
        onDone={() => {
          setCodes(null);
          void load();
          onChanged?.();
        }}
      />
    );
  }

  const enroll = () =>
    guarded(async () => {
      const r = await deviceTrustService.enroll(name.trim());
      if (r.recoveryCodes) setCodes(r.recoveryCodes);
    }, "This device is now trusted");

  const canEnrollHere = !state.locked || state.mustEnroll;
  const full = state.devices.length >= state.max;

  return (
    <div className="form-stack">
      {state.mustEnroll && (
        <p className="notice" role="alert">
          You signed in with a recovery code. Add this device as a trusted device to continue.
        </p>
      )}
      {!state.locked && !state.mustEnroll && (
        <p className="card-description">
          The lock is off: anyone who can sign in to your AT Protocol account can sign in here. Trust this device to
          turn the lock on. After that, a sign-in from any other device is refused until you approve that device from
          one you already trust.
        </p>
      )}
      {state.locked && (
        <p className="notice notice-ok">
          The lock is on. Sign-in works only from the {state.devices.length} trusted device(s) below. You have{" "}
          {state.recoveryCodesLeft} recovery code(s) left.
        </p>
      )}

      {state.requests.length > 0 && (
        <>
          <h4 className="list-heading">Devices asking to be trusted</h4>
          <ul className="post-list">
            {state.requests.map((r) => (
              <li key={r.id} className="post-card">
                <div className="post-head">
                  <h4>{r.name}</h4>
                  <Badge variant="pending">waiting</Badge>
                </div>
                {r.userAgent && <p className="text-dim text-sm">{r.userAgent}</p>}
                <p className="help-text">
                  Approve only if you are signing in on that device right now. Type the code that it shows.
                </p>
                <div className="inline-form">
                  <label htmlFor={`pair-${r.id}`} className="text-sm">Code</label>
                  <input
                    id={`pair-${r.id}`}
                    type="text"
                    className="mono"
                    maxLength={6}
                    autoComplete="off"
                    spellCheck={false}
                    value={pairing[r.id] ?? ""}
                    onChange={(e) => setPairing((p) => ({ ...p, [r.id]: e.target.value.toUpperCase() }))}
                  />
                  <button type="button"
                    className="btn-sm"
                    disabled={busy || (pairing[r.id] ?? "").length !== 6 || full}
                    onClick={() => { void guarded(() => deviceTrustService.approve(r.id, pairing[r.id]), "Device added"); }}
                  >
                    Approve
                  </button>
                  <button type="button" className="btn-sm btn-ghost" disabled={busy} onClick={() => { void guarded(() => deviceTrustService.deny(r.id), "Refused"); }}>
                    Refuse
                  </button>
                </div>
                {full && <p className="help-text">You are at your limit of {state.max} devices. Remove one or raise the limit first.</p>}
              </li>
            ))}
          </ul>
        </>
      )}

      {state.devices.length > 0 && (
        <ul className="item-list">
          {state.devices.map((d) => (
            <li key={d.id} className="item-row">
              <span>
                <strong>{d.name}</strong>
                {d.id === state.currentDeviceId && <> <Badge variant="running">this device</Badge></>}
                <br />
                <span className="text-dim text-sm">
                  {d.profile?.browser && d.profile.os ? `${d.profile.browser} on ${d.profile.os} · ` : ""}
                  Added {new Date(d.createdAt).toLocaleDateString()}
                  {d.lastUsedAt ? ` · last sign-in ${new Date(d.lastUsedAt).toLocaleString()}` : ""}
                </span>
                {d.warning && (
                  <span className="notice device-warning" role="alert">
                    <strong>This device signed in from a browser that looks different.</strong> Changed: {d.warning}
                    {d.warningAt ? ` (${new Date(d.warningAt).toLocaleString()})` : ""}. If this was not you, remove the
                    device: its key may have been copied.{" "}
                    <button type="button"
                      className="btn-sm btn-ghost"
                      disabled={busy}
                      onClick={() => { void guarded(() => deviceTrustService.dismissWarning(d.id), "Warning cleared"); }}
                    >
                      This was me
                    </button>
                  </span>
                )}
              </span>
              <button type="button"
                className="btn-sm btn-ghost"
                disabled={busy}
                onClick={async () => {
                  const last = state.devices.length === 1;
                  const ok = await confirm(
                    last
                      ? { title: "Remove the last trusted device?", message: "The lock turns off and any device can sign in again.", confirmLabel: "Remove device", danger: true }
                      : { title: `Remove "${d.name}"?`, message: "It is signed out and can no longer sign in.", confirmLabel: "Remove device", danger: true },
                  );
                  if (!ok) return;
                  void guarded(async () => {
                    await deviceTrustService.remove(d.id);
                    if (d.id === state.currentDeviceId) await forgetDeviceKey();
                  }, "Device removed");
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {canEnrollHere &&
        (deviceKeysSupported() ? (
          <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void enroll(); }}>
            <label htmlFor="trust-name" className="text-sm">Name for this device</label>
            <input id="trust-name" type="text" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} required />
            <button type="submit" disabled={busy || !name.trim()}>{state.locked ? "Trust this device" : "Trust this device and turn the lock on"}</button>
          </form>
        ) : (
          <p role="alert">This browser cannot hold a device key. Private browsing may block it.</p>
        ))}

      {state.locked && (
        <>
          <div className="inline-form">
            <label htmlFor="trust-max" className="text-sm">Most devices I allow</label>
            <select
              id="trust-max"
              value={state.max}
              disabled={busy}
              onChange={(e) => { void guarded(() => deviceTrustService.setLimit(Number(e.target.value)), "Limit changed"); }}
            >
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n} disabled={n < state.devices.length}>{n}</option>
              ))}
            </select>
          </div>
          <div className="btn-group">
            <button type="button"
              className="btn-sm btn-ghost"
              disabled={busy}
              onClick={async () => {
                if (!(await confirm({ title: "Make new recovery codes?", message: "The old codes stop working.", confirmLabel: "Make new codes" }))) return;
                void guarded(async () => {
                  const r = await deviceTrustService.newRecoveryCodes();
                  if (r) setCodes(r.recoveryCodes);
                }, "New recovery codes made");
              }}
            >
              Make new recovery codes
            </button>
          </div>
          <div className="btn-group">
            <button type="button" className="btn-sm btn-ghost" disabled={busy} onClick={() => { void guarded(() => deviceTrustService.stepUp(), "Confirmed for 5 minutes"); }}>
              Confirm this device
            </button>
          </div>
          <p className="help-text">
            Confirm this device before you allow an application (MCP) to connect to your account.
          </p>
          <p className="help-text">
            To add another device: sign in on it, choose &quot;Ask for approval&quot;, then approve it here with the code it shows.
          </p>
        </>
      )}
    </div>
  );
}

export function AccountTab({ onChanged }: { onChanged?: () => void }) {
  return (
    <div className="tab-content">
      <Card title="Trusted devices">
        <TrustedDevices onChanged={onChanged} />
      </Card>
      <Card title="Appearance">
        <p className="card-description">The theme is saved in this browser.</p>
        <ThemePicker />
      </Card>
    </div>
  );
}
