/** deviceAdmission: one refusal code per check, in a fixed order. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ locks: [] as unknown[], useCoordinator: false, notify: vi.fn() }));
vi.mock("../db/index.js", () => {
  const q = { from: () => q, innerJoin: () => q, where: () => q, limit: async () => h.locks };
  return { db: { select: () => q }, pool: {} };
});
vi.mock("../orchestrator/control-client.js", () => ({
  get useCoordinator() {
    return h.useCoordinator;
  },
  getControlClient: vi.fn(),
}));
vi.mock("../notifications/service.js", () => ({ notify: h.notify }));

import { deviceAdmission } from "../access/admission.js";

const tenant = (over: Record<string, unknown> = {}) =>
  ({ id: "t", name: "T", lockdownMode: false, requireDeviceApproval: false, maxDevices: 0, ...over }) as never;
const client = (n: number) => ({ listNodes: vi.fn(async () => Array.from({ length: n }, () => ({}))) }) as never;
const member = { isOriginator: false };

beforeEach(() => {
  h.locks = [];
  h.useCoordinator = false;
  h.notify.mockClear();
});

describe("deviceAdmission", () => {
  it("admits by default", async () => {
    expect(await deviceAdmission(tenant(), member, "u", client(0))).toBeNull();
  });

  it("refuses in lockdown first", async () => {
    h.locks = [{ id: "l" }];
    expect(await deviceAdmission(tenant({ lockdownMode: true, maxDevices: 1 }), member, "u", client(5))).toBe("locked_down");
  });

  it("refuses a device-locked member in Headscale mode only", async () => {
    h.locks = [{ id: "l" }];
    expect(await deviceAdmission(tenant(), member, "u", client(0))).toBe("device_locked");
    h.useCoordinator = true;
    expect(await deviceAdmission(tenant(), member, "u", client(0))).toBeNull();
  });

  it("refuses at the device limit and notifies", async () => {
    expect(await deviceAdmission(tenant({ maxDevices: 2 }), member, "u", client(2))).toBe("device_limit");
    expect(h.notify).toHaveBeenCalledWith("t", "device_limit_reached", expect.anything(), expect.anything());
    expect(await deviceAdmission(tenant({ maxDevices: 2 }), member, "u", client(1))).toBeNull();
  });

  it("reports an uncountable limit", async () => {
    const failing = { listNodes: vi.fn(async () => Promise.reject(new Error("down"))) } as never;
    expect(await deviceAdmission(tenant({ maxDevices: 2 }), member, "u", failing)).toBe("limit_unverified");
  });

  it("asks non-originators for approval last", async () => {
    expect(await deviceAdmission(tenant({ requireDeviceApproval: true }), member, "u", client(0))).toBe("approval_required");
    expect(await deviceAdmission(tenant({ requireDeviceApproval: true }), { isOriginator: true }, "u", client(0))).toBeNull();
    expect(await deviceAdmission(tenant({ requireDeviceApproval: true, maxDevices: 1 }), member, "u", client(1))).toBe("device_limit");
  });
});
