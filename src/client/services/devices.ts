import { tenantApi } from "./api";
import type {
  DevicesData,
  HealthData,
  Member,
  DeviceLockInfo,
  AuthKeyResponse,
} from "../lib/types";

export const deviceService = {
  getDevices: (tid: string) =>
    tenantApi<DevicesData>(tid, "/devices"),

  getHealth: (tid: string) =>
    tenantApi<HealthData>(tid, "/health"),

  removeDevice: (tid: string, id: string) =>
    tenantApi(tid, `/devices/${id}`, { method: "DELETE" }),

  generateAuthKey: (tid: string) =>
    tenantApi<AuthKeyResponse>(tid, "/devices/auth-key", { method: "POST" }),

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
