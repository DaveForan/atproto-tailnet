/** Devices that wait for admission (ADR-0039): the owner admits their own machine, then an approver if the tailnet asks. */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { AddressInfo } from "node:net";

vi.hoisted(() => {
  process.env.COORDINATOR_URL = "http://coordinator:9443";
  process.env.COORDINATOR_API_KEY = "k".repeat(40);
});

const { results, coord, nodes, notify, logAudit } = vi.hoisted(() => ({
  results: [] as unknown[],
  coord: { setNodeHold: vi.fn(async () => true), deleteNode: vi.fn(async () => {}) },
  nodes: [] as Record<string, unknown>[],
  notify: vi.fn(),
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
        if (prop === "catch") return () => chain();
        return () => chain();
      },
    });
  return { db: { select: () => chain(), insert: () => chain(), update: () => chain(), delete: () => chain() }, pool: {} };
});
vi.mock("../orchestrator/control-client.js", () => ({
  getCoordinatorClient: () => ({ listNodes: async () => nodes, setNodeHold: coord.setNodeHold, deleteNode: coord.deleteNode }),
}));
vi.mock("../notifications/service.js", () => ({ notify }));
vi.mock("../audit/log.js", () => ({ logAudit }));

import express from "express";
import type { Request, Response, NextFunction } from "express";
import { deviceHoldsRouter } from "../routes/device-holds.js";
import { admitStep, holdAfterOwner } from "../access/device-holds.js";

const T = "11111111-1111-4111-8111-111111111111";
const tenant = (over: Record<string, unknown> = {}) => ({
  id: T, name: "Harbor", coordinatorTenantId: "c-1", suspended: false, lockdownMode: false,
  requireDeviceApproval: false, maxDevices: 0, ...over,
});
/** The tenant lookup, then the member list of the tailnet. */
const as = (t: Record<string, unknown> = {}, opts: { originator?: boolean; permissions?: string[]; approvers?: string[] } = {}) => {
  // A request that ends early leaves its answers unread
  results.length = 0;
  results.push(
    [{ tenant: tenant(t), membership: { id: "m", isOriginator: !!opts.originator }, role: { permissions: opts.permissions ?? [] } }],
    [
      { userId: "u-1", handle: "alice.test", isOriginator: false, permissions: (opts.approvers ?? []).includes("u-1") ? ["approve_devices"] : [] },
      { userId: "u-2", handle: "bob.test", isOriginator: (opts.approvers ?? []).includes("u-2"), permissions: [] },
    ],
  );
};
const node = (id: string, owner: string | null, hold: string) => ({
  id, name: `box-${id}`, givenName: `box-${id}`, user: owner ? { id: owner, name: owner } : null, hold, fingerprint: `fp-${id}`, os: "linux",
});

const app = express();
app.use(express.json());
app.use((req: Request, _res: Response, next: NextFunction) => {
  (req as unknown as { session: Record<string, unknown> }).session = req.headers["x-anon"]
    ? {}
    : {
        userId: String(req.headers["x-user"] ?? "u-1"),
        did: "did:plc:x",
        ...(req.headers["x-stale-device"] ? { trustedDeviceId: "dev-1", deviceVerifiedAt: Date.now() - 60 * 60_000 } : {}),
      };
  if (req.headers["x-agent"]) (req as unknown as { agentToken: unknown }).agentToken = { id: "a", permissions: [] };
  next();
});
app.use(deviceHoldsRouter);
const server = app.listen(0);
afterAll(() => server.close());

async function call(method: string, path: string, headers: Record<string, string> = {}) {
  const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tenants/${T}/devices/${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
}

beforeEach(() => {
  results.length = 0;
  nodes.length = 0;
  vi.clearAllMocks();
  coord.setNodeHold.mockResolvedValue(true);
});

describe("admitStep", () => {
  const base = { isOwner: false, ownerIsMember: true, canApprove: false, secondApproval: false, otherApprover: false };
  it("only the owner takes the owner's step", () => {
    expect(admitStep({ ...base, hold: "owner", isOwner: true })).toEqual({ to: "none" });
    expect(admitStep({ ...base, hold: "owner", canApprove: true })).toEqual({ refusal: "not_owner" });
    expect(admitStep({ ...base, hold: "owner" })).toEqual({ refusal: "not_owner" });
  });
  it("the second approval sends the owner's device to an approver", () => {
    expect(admitStep({ ...base, hold: "owner", isOwner: true, secondApproval: true })).toEqual({ to: "approver" });
    expect(admitStep({ ...base, hold: "owner", isOwner: true, secondApproval: true, canApprove: true })).toEqual({ to: "none" });
    expect(admitStep({ ...base, hold: "approver", isOwner: true, secondApproval: true })).toEqual({ refusal: "not_approver" });
    // The tailnet dropped the second step: the owner finishes a device that still waits for it
    expect(admitStep({ ...base, hold: "approver", isOwner: true })).toEqual({ to: "none" });
    expect(admitStep({ ...base, hold: "approver" })).toEqual({ refusal: "not_approver" });
    expect(admitStep({ ...base, hold: "approver", canApprove: true })).toEqual({ to: "none" });
  });
  it("an approver admits a device that has no owner in the tailnet", () => {
    expect(admitStep({ ...base, hold: "owner", canApprove: true, ownerIsMember: false })).toEqual({ to: "none" });
    expect(admitStep({ ...base, hold: "owner", ownerIsMember: false })).toEqual({ refusal: "not_owner" });
  });
  it("an admitted device has no step", () => {
    expect(admitStep({ ...base, hold: "none", isOwner: true, canApprove: true })).toEqual({ refusal: "not_waiting" });
    expect(holdAfterOwner(false, false, true)).toBe("none");
  });
  it("an approver does not approve their own device when another approver exists", () => {
    const mine = { ...base, isOwner: true, canApprove: true, secondApproval: true };
    expect(admitStep({ ...mine, hold: "owner", otherApprover: true })).toEqual({ to: "approver" });
    expect(admitStep({ ...mine, hold: "approver", otherApprover: true })).toEqual({ refusal: "not_approver" });
    // The only approver: nobody else can take the step
    expect(admitStep({ ...mine, hold: "owner" })).toEqual({ to: "none" });
    expect(admitStep({ ...mine, hold: "approver" })).toEqual({ to: "none" });
    // The other approver takes it
    expect(admitStep({ ...base, canApprove: true, secondApproval: true, otherApprover: true, hold: "approver" })).toEqual({ to: "none" });
  });
});

describe("waiting devices", () => {
  it("a member sees only their own waiting devices", async () => {
    nodes.push(node("1", "u-1", "none"), node("2", "u-1", "owner"), node("3", "u-2", "owner"), node("4", "u-2", "approver"));
    as();
    const r = await call("GET", "waiting");
    expect(r.status).toBe(200);
    expect(r.json.mine).toEqual([
      { id: "2", name: "box-2", os: "linux", fingerprint: "fp-2", hold: "owner", canAdmit: true, expiresAt: null, owner: { userId: "u-1", handle: "alice.test" } },
    ]);
    expect(r.json.queue).toEqual([]);
  });

  it("an approver sees the devices their owners admitted, and devices without an owner", async () => {
    nodes.push(node("2", "u-1", "approver"), node("3", "u-2", "owner"), node("4", "u-2", "approver"), node("5", null, "owner"), node("6", "u-gone", "owner"));
    as({}, { permissions: ["approve_devices"] });
    const r = await call("GET", "waiting");
    expect(r.json.mine.map((d: any) => d.id)).toEqual(["2"]);
    // u-2's device 3 still waits for u-2
    expect(r.json.queue.map((d: any) => d.id)).toEqual(["4", "5", "6"]);
  });

  it("the owner admits their own machine", async () => {
    nodes.push(node("2", "u-1", "owner"));
    as();
    const r = await call("POST", "2/admit");
    expect(r.json).toEqual({ status: "admitted" });
    expect(coord.setNodeHold).toHaveBeenCalledWith("2", "owner", "none");
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "device_admitted", metadata: expect.objectContaining({ fingerprint: "fp-2" }) }));
    expect(notify).not.toHaveBeenCalled();
  });

  it("nobody admits the machine of another member: not an approver, not the originator", async () => {
    for (const opts of [{}, { permissions: ["approve_devices", "manage_devices"] }, { originator: true }]) {
      nodes.length = 0;
      nodes.push(node("3", "u-2", "owner"));
      as({}, opts);
      const r = await call("POST", "3/admit");
      expect(r.status).toBe(403);
      expect(r.json.code).toBe("not_owner");
    }
    expect(coord.setNodeHold).not.toHaveBeenCalled();
  });

  it("with the second approval the device goes to the approvers, who are told", async () => {
    nodes.push(node("2", "u-1", "owner"));
    as({ requireDeviceApproval: true });
    expect((await call("POST", "2/admit")).json).toEqual({ status: "waiting_for_approver" });
    expect(coord.setNodeHold).toHaveBeenCalledWith("2", "owner", "approver");
    expect(notify).toHaveBeenCalledWith(T, "device_approval_requested", expect.objectContaining({ body: expect.stringContaining("fp-2") }));

    // The owner cannot take the approver's step
    nodes[0].hold = "approver";
    as({ requireDeviceApproval: true });
    expect((await call("POST", "2/admit")).status).toBe(403);

    as({ requireDeviceApproval: true }, { originator: true });
    expect((await call("POST", "2/admit", { "x-user": "u-9" })).json).toEqual({ status: "admitted" });
    expect(coord.setNodeHold).toHaveBeenLastCalledWith("2", "approver", "none");
  });

  it("an approver's own device waits for the other approver", async () => {
    const both = { permissions: ["approve_devices"], approvers: ["u-1", "u-2"] };
    nodes.push(node("2", "u-1", "owner"));
    as({ requireDeviceApproval: true }, both);
    expect((await call("POST", "2/admit")).json).toEqual({ status: "waiting_for_approver" });
    nodes[0].hold = "approver";
    as({ requireDeviceApproval: true }, both);
    expect((await call("POST", "2/admit")).status).toBe(403);
    as({ requireDeviceApproval: true }, both);
    expect((await call("GET", "waiting")).json.mine).toMatchObject([{ id: "2", canAdmit: false }]);
    // The other approver (the originator here) admits it
    as({ requireDeviceApproval: true }, { originator: true, approvers: ["u-1", "u-2"] });
    expect((await call("POST", "2/admit", { "x-user": "u-2" })).json).toEqual({ status: "admitted" });

    // The only approver admits their own device in one step
    nodes[0].hold = "owner";
    as({ requireDeviceApproval: true }, { permissions: ["approve_devices"], approvers: ["u-1"] });
    expect((await call("POST", "2/admit")).json).toEqual({ status: "admitted" });
  });

  it("refuses an admitted device, an unknown device and a device that changed meanwhile", async () => {
    nodes.push(node("1", "u-1", "none"), node("2", "u-1", "owner"));
    as();
    expect((await call("POST", "1/admit")).status).toBe(409);
    as();
    expect((await call("POST", "404/admit")).status).toBe(404);
    coord.setNodeHold.mockResolvedValueOnce(false);
    as();
    expect((await call("POST", "2/admit")).status).toBe(409);
  });

  it("the device limit counts admitted devices", async () => {
    nodes.push(node("1", "u-2", "none"), node("2", "u-1", "owner"), node("3", "u-1", "owner"));
    as({ maxDevices: 2 });
    expect((await call("POST", "2/admit")).status).toBe(200);
    nodes[1].hold = "none";
    as({ maxDevices: 2 });
    const r = await call("POST", "3/admit");
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("device_limit");
  });

  it("lockdown, agent tokens, visitors and a stale trusted device cannot admit", async () => {
    nodes.push(node("2", "u-1", "owner"));
    as({ lockdownMode: true });
    expect((await call("POST", "2/admit")).status).toBe(403);
    expect((await call("POST", "2/admit", { "x-anon": "1" })).status).toBe(401);
    expect((await call("POST", "2/admit", { "x-agent": "1" })).status).toBe(401);
    const stale = await call("POST", "2/admit", { "x-stale-device": "1" });
    expect(stale.json.code).toBe("step_up_required");
    expect(coord.setNodeHold).not.toHaveBeenCalled();
  });

  it("the owner or an approver refuses a waiting device, and it is removed", async () => {
    nodes.push(node("2", "u-1", "owner"), node("3", "u-2", "approver"), node("1", "u-2", "none"));
    as();
    expect((await call("POST", "2/refuse")).json).toEqual({ status: "refused" });
    expect(coord.deleteNode).toHaveBeenCalledWith("2");
    as();
    expect((await call("POST", "3/refuse")).status).toBe(403);
    as({}, { permissions: ["approve_devices"] });
    expect((await call("POST", "3/refuse")).status).toBe(200);
    as({}, { originator: true });
    expect((await call("POST", "1/refuse")).status).toBe(409);
    expect(coord.deleteNode).toHaveBeenCalledTimes(2);
  });
});
