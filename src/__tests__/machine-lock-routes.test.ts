/**
 * Member machine lock routes (ADR-0035 §2): a member locks their own devices;
 * the coordinator enforces it. Changes need a fresh device proof.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { AddressInfo } from "node:net";

const h = vi.hoisted(() => ({
  member: true,
  coordinatorTenantId: "coord-1" as string | null,
  proofOk: true,
  devices: [] as Array<{ id: string; name: string; online: boolean; ownerId: string }>,
  coord: {
    getOwnerLock: vi.fn(),
    setOwnerLock: vi.fn(),
    allowOneMachine: vi.fn(),
    deleteOwnerLock: vi.fn(),
  },
  audit: vi.fn(),
  sync: vi.fn(async () => {}),
}));

vi.mock("../config.js", () => ({ config: { coordinatorUrl: "http://coord", coordinatorApiKey: "k" } }));
vi.mock("../routes/helpers.js", () => ({
  requireSession: (req: any, res: any, next: any) => (req.session?.userId ? next() : res.status(401).json({ error: "Not signed in" })),
  param: (req: any, name: string) => String(req.params[name]),
  getTenantForUser: async () =>
    h.member ? { tenant: { id: "t-1", coordinatorTenantId: h.coordinatorTenantId }, membership: {} } : null,
}));
vi.mock("../audit/log.js", () => ({ logAudit: h.audit }));
vi.mock("../logger.js", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("../orchestrator/coordinator-api.js", () => ({
  CoordinatorApiClient: class {
    getOwnerLock = h.coord.getOwnerLock;
    setOwnerLock = h.coord.setOwnerLock;
    allowOneMachine = h.coord.allowOneMachine;
    deleteOwnerLock = h.coord.deleteOwnerLock;
  },
}));
vi.mock("../access/devices.js", () => ({ listUserDevices: async () => h.devices }));
vi.mock("../access/sync.js", () => ({ syncTenantAccess: h.sync }));
vi.mock("../routes/device-trust.js", () => ({
  requireFreshDeviceProof: async (_req: any, res: any) => {
    if (!h.proofOk) res.status(403).json({ error: "Confirm on this trusted device first", code: "step_up_required" });
    return h.proofOk;
  },
}));

import express from "express";
import { machineLockRouter } from "../routes/machine-lock.js";

let session: Record<string, unknown> = {};
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as any).session = session;
  next();
});
app.use(machineLockRouter);
const server = app.listen(0);
afterAll(() => server.close());

async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
}

const OPEN = { locked: false, node_ids: [], allow_one_until: null, refused: [] };
const PATH = "/api/tenants/t-1/machine-lock";

beforeEach(() => {
  vi.clearAllMocks();
  session = { userId: "u-1" };
  h.member = true;
  h.coordinatorTenantId = "coord-1";
  h.proofOk = true;
  h.devices = [
    { id: "1", name: "mac", online: true, ownerId: "u-1" },
    { id: "2", name: "old-laptop", online: false, ownerId: "u-1" },
  ];
  h.coord.getOwnerLock.mockResolvedValue(OPEN);
});

describe("machine lock", () => {
  it("needs a session and membership", async () => {
    session = {};
    expect((await call("GET", PATH)).status).toBe(401);
    session = { userId: "u-1" };
    h.member = false;
    expect((await call("GET", PATH)).status).toBe(404);
    expect((await call("PUT", PATH, { deviceIds: ["1"] })).status).toBe(404);
  });

  it("reports unsupported outside coordinator mode and refuses changes", async () => {
    h.coordinatorTenantId = null;
    expect((await call("GET", PATH)).json).toMatchObject({ supported: false, locked: false });
    expect((await call("PUT", PATH, { deviceIds: ["1"] })).json.code).toBe("unsupported");
  });

  it("shows the member's devices, which are allowed, and refused attempts newest first", async () => {
    h.coord.getOwnerLock.mockResolvedValue({
      locked: true,
      node_ids: [1],
      allow_one_until: null,
      refused: [
        { at: "2026-11-20T10:00:00Z", hostname: "first", os: "linux", fingerprint: "aa" },
        { at: "2026-11-20T11:00:00Z", hostname: "second", os: "linux", fingerprint: "bb" },
      ],
    });
    const { json } = await call("GET", PATH);
    expect(json.locked).toBe(true);
    expect(json.devices).toEqual([
      { id: "1", name: "mac", online: true, allowed: true },
      { id: "2", name: "old-laptop", online: false, allowed: false },
    ]);
    expect(json.refused.map((r: any) => r.hostname)).toEqual(["second", "first"]);
    expect(h.coord.getOwnerLock).toHaveBeenCalledWith("u-1");
  });

  it("locks to the chosen devices of the member, re-syncs access and writes the audit log", async () => {
    h.coord.setOwnerLock.mockResolvedValue({ locked: true, node_ids: [1], allow_one_until: null, refused: [], removed_nodes: 1 });
    const r = await call("PUT", PATH, { deviceIds: ["1", "1"] });
    expect(r.status).toBe(200);
    expect(h.coord.setOwnerLock).toHaveBeenCalledWith("u-1", [1], undefined);
    expect(h.sync).toHaveBeenCalledWith("t-1");
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "device_locked", metadata: { self: true, devices: 1, removed: 1 } }));
  });

  it("refuses devices of somebody else, bad ids and an empty choice", async () => {
    expect((await call("PUT", PATH, { deviceIds: ["1", "99"] })).status).toBe(400);
    expect((await call("PUT", PATH, { deviceIds: ["../x"] })).status).toBe(400);
    expect((await call("PUT", PATH, { deviceIds: [] })).status).toBe(400);
    expect((await call("PUT", PATH, {})).status).toBe(400);
    expect(h.coord.setOwnerLock).not.toHaveBeenCalled();
  });

  it("a member with no devices can lock to none", async () => {
    h.devices = [];
    h.coord.setOwnerLock.mockResolvedValue({ locked: true, node_ids: [], allow_one_until: null, refused: [] });
    expect((await call("PUT", PATH, { deviceIds: [] })).status).toBe(200);
  });

  it("every change needs a fresh device proof", async () => {
    h.proofOk = false;
    for (const [method, path, body] of [
      ["PUT", PATH, { deviceIds: ["1"] }],
      ["POST", `${PATH}/allow-one`, undefined],
      ["DELETE", PATH, undefined],
    ] as const) {
      expect((await call(method, path, body)).json.code).toBe("step_up_required");
    }
    expect(h.coord.setOwnerLock).not.toHaveBeenCalled();
    expect(h.coord.allowOneMachine).not.toHaveBeenCalled();
    expect(h.coord.deleteOwnerLock).not.toHaveBeenCalled();
  });

  it("allow-one opens a 10 minute window and fails without a lock", async () => {
    h.coord.allowOneMachine.mockResolvedValueOnce(null);
    expect((await call("POST", `${PATH}/allow-one`)).status).toBe(409);
    h.coord.allowOneMachine.mockResolvedValueOnce({ locked: true, node_ids: [1], allow_one_until: "2026-11-20T12:10:00Z", refused: [] });
    const r = await call("POST", `${PATH}/allow-one`);
    expect(r.json.allowOneUntil).toBe("2026-11-20T12:10:00Z");
    expect(h.coord.allowOneMachine).toHaveBeenLastCalledWith("u-1", 600);
  });

  it("passes the device limit on, refuses one below the kept devices, and reports a full lock", async () => {
    h.coord.setOwnerLock.mockResolvedValue({ locked: true, node_ids: [1, 2], allow_one_until: null, refused: [], max_machines: 3 });
    const ok = await call("PUT", PATH, { deviceIds: ["1", "2"], maxDevices: 3 });
    expect(ok.json.maxDevices).toBe(3);
    expect(h.coord.setOwnerLock).toHaveBeenCalledWith("u-1", [1, 2], 3);
    expect((await call("PUT", PATH, { deviceIds: ["1", "2"], maxDevices: 1 })).status).toBe(400);
    expect((await call("PUT", PATH, { deviceIds: ["1"], maxDevices: 99 })).status).toBe(400);

    h.coord.allowOneMachine.mockResolvedValueOnce("full");
    const full = await call("POST", `${PATH}/allow-one`);
    expect([full.status, full.json.code]).toEqual([409, "lock_full"]);
  });

  it("unlock removes the lock", async () => {
    const r = await call("DELETE", PATH);
    expect(r.json.locked).toBe(false);
    expect(h.coord.deleteOwnerLock).toHaveBeenCalledWith("u-1");
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "device_unlocked" }));
  });
});
