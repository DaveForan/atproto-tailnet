import { tenantApi } from "./api";
import type {
  DevicesData,
  HealthData,
  Member,
  AuthKeyResponse,
  AuthKeyOptions,
  AuthKeyInfo,
  Stats,
  WaitingDevices,
  OwnDeviceApproval,
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

  /** The address a device signs in to. */
  getLoginServer: async (tid: string): Promise<string | null> =>
    (await tenantApi<{ loginServer: string }>(tid, ""))?.loginServer ?? null,

  getHealth: (tid: string) =>
    tenantApi<HealthData>(tid, "/health"),

  /** Devices that wait for admission: the caller's own, and the approver queue. */
  waiting: (tid: string) =>
    tenantApi<WaitingDevices>(tid, "/devices/waiting"),

  admitDevice: (tid: string, id: string) =>
    tenantApi<{ status: "admitted" | "waiting_for_approver" }>(tid, `/devices/${id}/admit`, { method: "POST", body: "{}" }),

  refuseDevice: (tid: string, id: string) =>
    tenantApi(tid, `/devices/${id}/refuse`, { method: "POST", body: "{}" }),

  /** The caller's own approval of their new devices. */
  ownApproval: (tid: string) =>
    tenantApi<OwnDeviceApproval>(tid, "/device-approval/mine"),

  setOwnApproval: (tid: string, on: boolean) =>
    tenantApi<OwnDeviceApproval>(tid, "/device-approval/mine", { method: "PUT", body: JSON.stringify({ on }) }),

  /** Removes every device of a member and revokes every key of that member. */
  invalidateDevices: (tid: string, userId: string) =>
    tenantApi<{ devicesDeleted: number; keysRevoked: number }>(tid, `/members/${userId}/devices/invalidate`, { method: "POST", body: "{}" }),

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

  setMemberRole: (tid: string, memberId: string, roleId: string) =>
    tenantApi(tid, `/members/${memberId}/role`, {
      method: "PUT",
      body: JSON.stringify({ roleId }),
    }),

  removeMember: (tid: string, memberId: string) =>
    tenantApi(tid, `/members/${memberId}`, { method: "DELETE" }),
};
