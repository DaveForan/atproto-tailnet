import { tenantApi } from "./api";

export interface MachineLockState {
  /** False outside coordinator mode: the lock cannot be enforced there. */
  supported: boolean;
  locked: boolean;
  devices: Array<{ id: string; name: string; online: boolean; allowed: boolean }>;
  /** While set and in the future, the next new device is let in and added to the lock. */
  allowOneUntil: string | null;
  /** Machines that tried to join while locked, newest first. */
  refused: Array<{ at: string; hostname: string; os: string; fingerprint: string }>;
}

export const machineLockService = {
  get: (tid: string) => tenantApi<MachineLockState>(tid, "/machine-lock"),
  lock: (tid: string, deviceIds: string[]) =>
    tenantApi<MachineLockState>(tid, "/machine-lock", { method: "PUT", body: JSON.stringify({ deviceIds }) }),
  allowOne: (tid: string) => tenantApi<MachineLockState>(tid, "/machine-lock/allow-one", { method: "POST", body: "{}" }),
  unlock: (tid: string) => tenantApi<MachineLockState>(tid, "/machine-lock", { method: "DELETE" }),
};
