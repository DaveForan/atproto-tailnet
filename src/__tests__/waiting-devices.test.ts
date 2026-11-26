/** Waiting devices: the owner is told about a new one, and one that waits too long is removed (ADR-0039). */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.COORDINATOR_URL = "http://coordinator:9443";
  process.env.COORDINATOR_API_KEY = "k".repeat(40);
});

const h = vi.hoisted(() => ({
  results: [] as unknown[],
  writes: [] as { op: string; arg?: unknown }[],
  nodes: [] as Record<string, unknown>[],
  deleteNode: vi.fn(async (_id: string) => {}),
  notifyUser: vi.fn(),
  notify: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock("../db/index.js", () => {
  const chain = (op: string): unknown =>
    new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === "then") {
          const next = op === "select" && h.results.length ? h.results.shift() : [];
          return (res: (v: unknown) => unknown) => Promise.resolve(next).then(res);
        }
        if (prop === "values") return (arg: unknown) => (h.writes.push({ op, arg }), chain(op));
        if (prop === "where" && op === "delete") return () => (h.writes.push({ op }), chain(op));
        return () => chain(op);
      },
    });
  return { db: { select: () => chain("select"), insert: () => chain("insert"), update: () => chain("update"), delete: () => chain("delete") }, pool: {} };
});
vi.mock("../orchestrator/control-client.js", () => ({
  useCoordinator: true,
  getCoordinatorClient: () => ({ listNodes: async () => h.nodes, deleteNode: h.deleteNode }),
}));
vi.mock("../notifications/service.js", () => ({ notifyUser: h.notifyUser, notify: h.notify }));
vi.mock("../audit/log.js", () => ({ logAudit: h.logAudit }));

import { planWaiting, sweepWaitingDevices, waitExpiry } from "../orchestrator/waiting-devices.js";

const NOW = new Date("2026-12-01T12:00:00Z");
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000);
const node = (id: string, owner: string | null, hold: string) =>
  ({ id, name: `box-${id}`, givenName: `box-${id}`, user: owner ? { id: owner, name: owner } : null, hold, fingerprint: `fp-${id}`, os: "linux" }) as never;
const row = (nodeId: string, ownerId: string | null, hours: number) => ({ nodeId, ownerId, firstSeenAt: hoursAgo(hours) });
const ids = (list: { id?: unknown }[]) => list.map((n) => String(n.id));

beforeEach(() => {
  h.results.length = 0;
  h.writes.length = 0;
  h.nodes.length = 0;
  vi.clearAllMocks();
});

describe("planWaiting", () => {
  it("starts a wait for a new waiting device and ignores admitted ones", () => {
    const plan = planWaiting([node("1", "a", "none"), node("2", "a", "owner"), node("3", "b", "approver")], [], 168, NOW);
    expect([ids(plan.started), plan.ended, ids(plan.expired)]).toEqual([["2", "3"], [], []]);
  });

  it("ends the wait of a device that was admitted or removed", () => {
    const plan = planWaiting([node("2", "a", "none")], [row("2", "a", 1), row("9", "a", 1)], 168, NOW);
    expect([ids(plan.started), plan.ended, ids(plan.expired)]).toEqual([[], ["2", "9"], []]);
  });

  it("another owner on the same device starts a new wait", () => {
    const plan = planWaiting([node("2", "mallory", "owner")], [row("2", "a", 500)], 168, NOW);
    expect([ids(plan.started), plan.ended, ids(plan.expired)]).toEqual([["2"], ["2"], []]);
  });

  it("expires a device at the limit of the tailnet, at either step", () => {
    const nodes = [node("2", "a", "owner"), node("3", "a", "approver"), node("4", "a", "owner")];
    const rows = [row("2", "a", 168), row("3", "a", 200), row("4", "a", 167)];
    expect(ids(planWaiting(nodes, rows, 168, NOW).expired)).toEqual(["2", "3"]);
    expect(ids(planWaiting(nodes, rows, 1, NOW).expired)).toEqual(["2", "3", "4"]);
    expect(waitExpiry(hoursAgo(1), 2).getTime()).toBe(NOW.getTime() + 3_600_000);
  });
});

describe("sweepWaitingDevices", () => {
  const tenant = { id: "t", name: "Harbor", ownerUserId: "u-orig", coordinatorTenantId: "c-1", waitingDeviceHours: 168 };
  const members = [{ userId: "a", handle: "alice.test", isOriginator: false, permissions: [] }];

  it("tells the owner about a device that their key registered", async () => {
    h.nodes.push(node("2", "a", "owner"), node("3", "a", "approver"), node("4", null, "owner"));
    h.results.push([tenant], [], members);
    await sweepWaitingDevices(NOW);
    expect(h.writes).toEqual([{ op: "insert", arg: [
      { tenantId: "t", nodeId: "2", ownerId: "a", firstSeenAt: NOW },
      { tenantId: "t", nodeId: "3", ownerId: "a", firstSeenAt: NOW },
      { tenantId: "t", nodeId: "4", ownerId: null, firstSeenAt: NOW },
    ] }]);
    expect(h.notifyUser).toHaveBeenCalledTimes(1);
    expect(h.notifyUser).toHaveBeenCalledWith("t", "a", "device_waiting", expect.objectContaining({ body: expect.stringContaining("fp-2") }));
    // A device without an owner goes to the approvers
    expect(h.notify).toHaveBeenCalledWith("t", "device_approval_requested", expect.objectContaining({ body: expect.stringContaining("fp-4") }));
  });

  it("tells nobody twice", async () => {
    h.nodes.push(node("2", "a", "owner"));
    h.results.push([tenant], [row("2", "a", 3)]);
    await sweepWaitingDevices(NOW);
    expect(h.notifyUser).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it("removes a device that waited too long", async () => {
    h.nodes.push(node("2", "a", "owner"), node("5", "a", "none"));
    h.results.push([tenant], [row("2", "a", 169)]);
    await sweepWaitingDevices(NOW);
    expect(h.deleteNode).toHaveBeenCalledWith("2");
    expect(h.deleteNode).toHaveBeenCalledTimes(1);
    expect(h.writes).toEqual([{ op: "delete" }]);
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "device_expired", targetId: "2", metadata: expect.objectContaining({ fingerprint: "fp-2", hours: 168 }) }));
  });
});
