import { tenantApi } from "./api";
import type {
  DevicesData,
  HealthData,
  Member,
  DeviceLockInfo,
  AuthKeyResponse,
  AuthKeyOptions,
  AuthKeyInfo,
  Stats,
} from "../lib/types";

export const deviceService = {
  getDevices: (tid: string) =>
    tenantApi<DevicesData>(tid, "/devices"),

  /** Device and member counts for the header. No count endpoint exists, so it fetches all devices. */
  getStats: async (tid: string): Promise<Stats | null> => {
    const devices = await deviceService.getDevices(tid);
    if (!devices) return null;
    const byUser = devices.byUser || [];
    let total = 0;
    let online = 0;
    for (const group of byUser) {
      for (const d of group.devices) {
        total++;
        if (d.online) online++;
      }
    }
    return { totalDevices: total, onlineDevices: online, totalMembers: byUser.length };
  },

  getHealth: (tid: string) =>
    tenantApi<HealthData>(tid, "/health"),

  removeDevice: (tid: string, id: string) =>
    tenantApi(tid, `/devices/${id}`, { method: "DELETE" }),

  generateAuthKey: (tid: string, opts: AuthKeyOptions = {}) =>
    tenantApi<AuthKeyResponse>(tid, "/devices/auth-key", {
      method: "POST",
      body: JSON.stringify(opts),
    }),

  listAuthKeys: (tid: string) =>
    tenantApi<{ keys: AuthKeyInfo[] }>(tid, "/auth-keys"),

  revokeAuthKey: (tid: string, keyId: string) =>
    tenantApi(tid, `/auth-keys/${keyId}`, { method: "DELETE" }),

  getMembers: (tid: string) =>
    tenantApi<Member[]>(tid, "/members"),

  getDeviceLock: (tid: string, memberId: string) =>
    tenantApi<DeviceLockInfo>(tid, `/device-locks/${memberId}`),

  lockDevice: (tid: string, memberId: string) =>
    tenantApi(tid, "/device-locks", {
      method: "POST",
      body: JSON.stringify({ userId: memberId }),
    }),

  unlockDevice: (tid: string, memberId: string) =>
    tenantApi(tid, "/device-locks", {
      method: "DELETE",
      body: JSON.stringify({ userId: memberId }),
    }),

  setMemberRole: (tid: string, memberId: string, roleId: string) =>
    tenantApi(tid, `/members/${memberId}/role`, {
      method: "PUT",
      body: JSON.stringify({ roleId }),
    }),

  removeMember: (tid: string, memberId: string) =>
    tenantApi(tid, `/members/${memberId}`, { method: "DELETE" }),
};
