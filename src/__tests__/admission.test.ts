/** deviceAdmission: one refusal code per check, in a fixed order. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock("../db/index.js", () => ({ db: {}, pool: {} }));
vi.mock("../orchestrator/control-client.js", () => ({ getCoordinatorClient: vi.fn() }));
vi.mock("../notifications/service.js", () => ({ notify: h.notify }));

import { deviceAdmission } from "../access/admission.js";

const tenant = (over: Record<string, unknown> = {}) =>
  ({ id: "t", name: "T", lockdownMode: false, requireDeviceApproval: false, maxDevices: 0, ...over }) as never;
const nodes = (holds: string[]) => ({ listNodes: vi.fn(async () => holds.map((hold) => ({ hold }))) }) as never;
const client = (n: number) => nodes(Array.from({ length: n }, () => "none"));

beforeEach(() => {
  h.notify.mockClear();
});

describe("deviceAdmission", () => {
  it("admits by default", async () => {
    expect(await deviceAdmission(tenant(), client(0))).toBeNull();
  });

  it("refuses in lockdown first", async () => {
    expect(await deviceAdmission(tenant({ lockdownMode: true, maxDevices: 1 }), client(5))).toBe("locked_down");
  });

  it("refuses at the device limit and notifies", async () => {
    expect(await deviceAdmission(tenant({ maxDevices: 2 }), client(2))).toBe("device_limit");
    expect(h.notify).toHaveBeenCalledWith("t", "device_limit_reached", expect.anything(), expect.anything());
    expect(await deviceAdmission(tenant({ maxDevices: 2 }), client(1))).toBeNull();
  });

  it("counts only admitted devices against the limit", async () => {
    expect(await deviceAdmission(tenant({ maxDevices: 2 }), nodes(["none", "owner", "approver"]))).toBeNull();
    expect(await deviceAdmission(tenant({ maxDevices: 2 }), nodes(["none", "owner", "none"]))).toBe("device_limit");
  });

  it("reports an uncountable limit", async () => {
    const failing = { listNodes: vi.fn(async () => Promise.reject(new Error("down"))) } as never;
    expect(await deviceAdmission(tenant({ maxDevices: 2 }), failing)).toBe("limit_unverified");
  });

  it("does not refuse for the second approval: the hold handles it", async () => {
    expect(await deviceAdmission(tenant({ requireDeviceApproval: true }), client(0))).toBeNull();
    expect(await deviceAdmission(tenant({ requireDeviceApproval: true, maxDevices: 1 }), client(1))).toBe("device_limit");
  });
});
