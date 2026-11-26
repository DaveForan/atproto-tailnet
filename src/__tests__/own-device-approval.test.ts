/** A member's own device approval, and invalidating a member's devices and keys (ADR-0039). */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { AddressInfo } from "node:net";

vi.hoisted(() => {
  process.env.COORDINATOR_URL = "http://coordinator:9443";
  process.env.COORDINATOR_API_KEY = "k".repeat(40);
});

const { results, writes, sync, revoke, logAudit } = vi.hoisted(() => ({
  results: [] as unknown[],
  writes: [] as unknown[],
  sync: vi.fn(async () => true),
  revoke: vi.fn(async () => ({ devicesDeleted: 2, keysRevoked: 1, errors: [] as string[] })),
  logAudit: vi.fn(),
}));

vi.mock("../db/index.js", () => {
  const chain = (): unknown =>
    new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === "then") {
          const next = results.length ? results.shift() : [];
          return (res: (v: unknown) => unknown) => Promise.resolve(next).then(res);
        }
        if (prop === "set") return (arg: unknown) => (writes.push(arg), chain());
        return () => chain();
      },
    });
  return { db: { select: () => chain(), insert: () => chain(), update: () => chain(), delete: () => chain() }, pool: {} };
});
vi.mock("../orchestrator/control-client.js", () => ({
  useCoordinator: true,
  getControlClient: () => ({}),
  getCoordinatorClient: () => ({}),
}));
vi.mock("../access/sync.js", () => ({ syncTenantAccess: sync }));
vi.mock("../access/keys.js", () => ({ revokeMemberAccess: revoke }));
vi.mock("../notifications/service.js", () => ({ notify: vi.fn() }));
vi.mock("../audit/log.js", () => ({ logAudit }));

import express from "express";
import type { Request, Response, NextFunction } from "express";
import { deviceHoldsRouter } from "../routes/device-holds.js";
import { compileAccess } from "../access/compiler.js";

const T = "11111111-1111-4111-8111-111111111111";
const as = (t: Record<string, unknown> = {}, m: Record<string, unknown> = {}, permissions: string[] = []) => {
  results.length = 0;
  results.push([
    {
      tenant: { id: T, name: "Harbor", coordinatorTenantId: "c-1", lockdownMode: false, requireDeviceApproval: false, lastActivityAt: new Date(), ...t },
      membership: { id: "m", isOriginator: false, approveOwnDevices: true, ...m },
      role: { permissions },
    },
  ]);
};

const app = express();
app.use(express.json());
app.use((req: Request, _res: Response, next: NextFunction) => {
  (req as unknown as { session: Record<string, unknown> }).session = { userId: "u-1", did: "did:plc:x" };
  if (req.headers["x-agent"]) (req as unknown as { agentToken: unknown }).agentToken = { id: "a", permissions: [] };
  next();
});
app.use(deviceHoldsRouter);
const server = app.listen(0);
afterAll(() => server.close());

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tenants/${T}/${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
}

beforeEach(() => {
  results.length = 0;
  writes.length = 0;
  vi.clearAllMocks();
});

describe("own device approval", () => {
  it("is on by default and a member turns it off for themselves", async () => {
    as();
    expect((await call("GET", "device-approval/mine")).json).toEqual({ on: true, locked: false, needsApprover: false, supported: true });
    as();
    const off = await call("PUT", "device-approval/mine", { on: false });
    expect(off.json).toEqual({ on: false, locked: false });
    expect(writes).toEqual([{ approveOwnDevices: false }]);
    expect(sync).toHaveBeenCalledWith(T);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "own_device_approval_changed", metadata: { on: false } }));
  });

  it("saves nothing when the coordinator does not take the change", async () => {
    as();
    sync.mockResolvedValueOnce(false);
    const off = await call("PUT", "device-approval/mine", { on: false });
    expect([off.status, off.json.code]).toEqual([502, "not_applied"]);
    // Off stays stored: the coordinator may hold either value, and "on" would claim too much
    expect(writes).toEqual([{ approveOwnDevices: false }, { approveOwnDevices: false }]);
    as({}, { approveOwnDevices: false });
    sync.mockResolvedValueOnce(false);
    expect((await call("PUT", "device-approval/mine", { on: true })).status).toBe(502);
    expect(writes.slice(2)).toEqual([{ approveOwnDevices: true }, { approveOwnDevices: false }]);
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("the second approval locks it on for every member", async () => {
    as({ requireDeviceApproval: true }, { approveOwnDevices: false });
    expect((await call("GET", "device-approval/mine")).json).toMatchObject({ on: true, locked: true });
    as({ requireDeviceApproval: true }, { isOriginator: true });
    const off = await call("PUT", "device-approval/mine", { on: false });
    expect([off.status, off.json.code]).toEqual([409, "approval_locked"]);
    expect(writes).toEqual([]);
  });

  it("lockdown and agent tokens cannot turn it off", async () => {
    as({ lockdownMode: true });
    expect((await call("PUT", "device-approval/mine", { on: false })).status).toBe(403);
    as({ lockdownMode: true });
    expect((await call("PUT", "device-approval/mine", { on: true })).status).toBe(200);
    as();
    expect((await call("PUT", "device-approval/mine", { on: false }, { "x-agent": "1" })).status).toBe(401);
  });

  it("only the listed owners reach the coordinator", () => {
    const base = { mode: "member" as const, posts: [], connections: [], shares: [] };
    expect(compileAccess(base)).toEqual({ mode: "member", rules: [] });
    expect(compileAccess({ ...base, unheldOwners: ["u-2", "u-1", "u-2"] })).toEqual({ mode: "member", rules: [], unheld_owners: ["u-1", "u-2"] });
  });
});

describe("invalidate devices and keys", () => {
  it("a member invalidates their own", async () => {
    as();
    results.push([{ id: "m" }]);
    const r = await call("POST", "members/u-1/devices/invalidate");
    expect(r.json).toEqual({ status: "invalidated", devicesDeleted: 2, keysRevoked: 1 });
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ tenantId: T, userId: "u-1" }));
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "devices_invalidated", targetId: "u-1" }));
  });

  it("another member's needs the originator or manage_devices", async () => {
    as();
    expect((await call("POST", "members/u-2/devices/invalidate")).status).toBe(403);
    expect(revoke).not.toHaveBeenCalled();
    as({}, { isOriginator: true });
    results.push([{ id: "m2" }]);
    expect((await call("POST", "members/u-2/devices/invalidate")).status).toBe(200);
    as({}, {}, ["manage_devices"]);
    results.push([]);
    expect((await call("POST", "members/u-9/devices/invalidate")).status).toBe(404);
  });

  it("works in lockdown and reports a partial failure", async () => {
    as({ lockdownMode: true });
    results.push([{ id: "m" }]);
    revoke.mockResolvedValueOnce({ devicesDeleted: 0, keysRevoked: 1, errors: ["delete_devices"] });
    expect((await call("POST", "members/u-1/devices/invalidate")).status).toBe(502);
  });
});
