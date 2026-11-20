import { api, apiOrNull } from "./api";
import { deviceTraits, ensureDeviceKey, setDeviceId, signChallenge } from "../lib/device-key";

export interface TrustedDevice {
  id: string;
  name: string;
  userAgent: string | null;
  profile: { os: string | null; browser: string | null } | null;
  /** Set when a sign-in with this device's key came from a browser that looked different. */
  warning: string | null;
  warningAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface TrustState {
  locked: boolean;
  max: number;
  currentDeviceId: string | null;
  mustEnroll: boolean;
  stepUpFresh: boolean;
  recoveryCodesLeft: number;
  devices: TrustedDevice[];
  requests: Array<{ id: string; name: string; userAgent: string | null; createdAt: string }>;
}

const post = (body?: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body ?? {}) });

async function challenge(): Promise<string> {
  const r = await api<{ challenge: string }>("/api/trusted-devices/challenge", post());
  if (!r) throw new Error("Not signed in");
  return r.challenge;
}

export const deviceTrustService = {
  state: () => api<TrustState>("/api/trusted-devices"),

  /** Trust this browser (first device, or after a recovery code). Returns recovery codes for a first device. */
  async enroll(name: string): Promise<{ id: string; recoveryCodes?: string[] }> {
    const key = await ensureDeviceKey();
    const signature = await signChallenge(key, await challenge());
    const r = await api<{ id: string; recoveryCodes?: string[] }>(
      "/api/trusted-devices",
      post({ name, publicKeyJwk: key.publicJwk, signature, profile: deviceTraits() }),
    );
    if (!r) throw new Error("Not signed in");
    await setDeviceId(r.id);
    return r;
  },

  /** Prove this trusted device again, for a sensitive change. */
  async stepUp(): Promise<void> {
    const key = await ensureDeviceKey();
    await api("/api/trusted-devices/step-up", post({ signature: await signChallenge(key, await challenge()) }));
  },

  remove: (id: string) => api<{ locked: boolean }>(`/api/trusted-devices/${id}`, { method: "DELETE" }),
  setLimit: (max: number) => api("/api/trusted-devices/limit", { method: "PUT", body: JSON.stringify({ max }) }),
  approve: (id: string, code: string) => api(`/api/trusted-devices/requests/${id}/approve`, post({ code })),
  dismissWarning: (id: string) => api(`/api/trusted-devices/${id}/dismiss-warning`, post()),
  deny: (id: string) => api(`/api/trusted-devices/requests/${id}/deny`, post()),
  newRecoveryCodes: () => api<{ recoveryCodes: string[] }>("/api/trusted-devices/recovery-codes", post()),

  // ── Pending sign-in (no dashboard session yet: a 401 means "nothing pending") ──
  pending: () => apiOrNull<{ handle: string | null; challenge: string }>("/api/device-trust/pending"),
  verify: (deviceId: string, signature: string) =>
    apiOrNull<{ redirect: string }>("/api/device-trust/pending/verify", post({ deviceId, signature, profile: deviceTraits() })),
  recover: (code: string) => apiOrNull<{ redirect: string }>("/api/device-trust/pending/recover", post({ code })),
  requestTrust: (name: string, publicKeyJwk: unknown) =>
    apiOrNull<{ id: string; code: string; expiresAt: string }>("/api/device-trust/pending/request", post({ name, publicKeyJwk, profile: deviceTraits() })),
  requestStatus: () => apiOrNull<{ status: "pending" | "approved" | "denied" | "expired"; deviceId: string | null }>("/api/device-trust/pending/request"),
};
