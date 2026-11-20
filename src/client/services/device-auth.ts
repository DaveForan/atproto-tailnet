import { api } from "./api";

export interface PendingDeviceSignIn {
  device: { hostname: string; os: string; fingerprint: string };
  /** When the device asked to sign in (ISO time), if the server knows. */
  requestedAt?: string | null;
  /** The address the device's request came from, if the server knows. */
  requesterIp?: string | null;
  tailnets: Array<{ id: string; name: string; blocked: string | null }>;
}

export const deviceAuthService = {
  get: (id: string) => api<PendingDeviceSignIn>(`/api/device-auth/${id}`),
  approve: (id: string, tenantId: string) =>
    api<{ tailnet: string }>(`/api/device-auth/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({ tenantId, confirm: true }),
    }),
  deny: (id: string) => api(`/api/device-auth/${id}/deny`, { method: "POST", body: "{}" }),
};
