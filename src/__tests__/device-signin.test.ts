/** Interactive device sign-in (ADR-0032): the dashboard side applies every key-path check. */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { AddressInfo } from "node:net";

vi.hoisted(() => {
  process.env.COORDINATOR_URL = "http://coordinator:9443";
  process.env.COORDINATOR_API_KEY = "k".repeat(40);
});

const { results, coord, enforceDeviceLimit } = vi.hoisted(() => ({
  results: [] as unknown[],
  coord: {
    getDeviceAuth: vi.fn(),
    approveDeviceAuth: vi.fn(async () => {}),
    denyDeviceAuth: vi.fn(async () => {}),
  },
  enforceDeviceLimit: vi.fn(async (..._args: unknown[]) => true),
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
vi.mock("../orchestrator/coordinator-api.js", () => ({
  CoordinatorApiClient: class {
    getDeviceAuth = coord.getDeviceAuth;
    approveDeviceAuth = coord.approveDeviceAuth;
    denyDeviceAuth = coord.denyDeviceAuth;
  },
}));
vi.mock("../orchestrator/control-client.js", () => ({ useCoordinator: true, getControlClient: () => ({}) }));
vi.mock("../orchestrator/coordinator-identity.js", () => ({ pushTenantIdentity: vi.fn(async () => {}) }));
vi.mock("../routes/limits.js", () => ({ enforceDeviceLimit }));
const { logAudit } = vi.hoisted(() => ({ logAudit: vi.fn() }));
vi.mock("../routes/audit.js", () => ({ logAudit }));

import express from "express";
import type { Request, Response, NextFunction } from "express";
import { deviceSignInRouter, DEVICE_SIGNIN_APPROVE_LIMIT } from "../routes/device-signin.js";

const ID = "0123456789abcdef0123456789abcdef";
const T = "11111111-1111-4111-8111-111111111111";
const tenant = (over: Record<string, unknown> = {}) => ({
  id: T, name: "Harbor", slug: "t-x", coordinatorTenantId: "c-1", suspended: false, lockdownMode: false,
  requireDeviceApproval: false, lastActivityAt: new Date(), ...over,
});
const ctx = (t: Record<string, unknown> = {}, originator = false) => [
  { tenant: tenant(t), membership: { id: "m", isOriginator: originator }, role: null },
];

const app = express();
app.use(express.json());
app.use((req: Request, _res: Response, next: NextFunction) => {
  const user = String(req.headers["x-user"] ?? "u-1");
  (req as unknown as { session: Record<string, unknown> }).session = req.headers["x-anon"]
    ? {}
    : {
        userId: user,
        did: "did:plc:x",
        // A trusted-device session whose proof is old (ADR-0035 step-up)
        ...(req.headers["x-stale-device"] ? { trustedDeviceId: "dev-1", deviceVerifiedAt: Date.now() - 60 * 60_000 } : {}),
      };
  if (req.headers["x-agent"]) (req as unknown as { agentToken: unknown }).agentToken = { id: "a" };
  next();
});
app.use(deviceSignInRouter);
const server = app.listen(0);
afterAll(() => server.close());

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/device-auth/${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
}

beforeEach(() => {
  results.length = 0;
  vi.clearAllMocks();
  enforceDeviceLimit.mockResolvedValue(true);
  coord.getDeviceAuth.mockResolvedValue({
    hostname: "phone", os: "iOS", fingerprint: "aaaa-bbbb-cccc-dddd", pending: true, registered_tenant_id: null,
    requester_ip: "203.0.113.7", requested_at: new Date(Date.now() - 30_000).toISOString(),
  });
});

describe("device sign-in", () => {
  it("needs a dashboard session: anonymous visitors and agent tokens are refused", async () => {
    expect((await call("GET", ID, undefined, { "x-anon": "1" })).status).toBe(401);
    expect((await call("POST", `${ID}/approve`, { tenantId: T, confirm: true }, { "x-agent": "1" })).status).toBe(401);
    expect(coord.approveDeviceAuth).not.toHaveBeenCalled();
  });

  it("shows the device and the tailnets it can join, with reasons for blocked ones", async () => {
    results.push([
      { tenant: tenant(), isOriginator: false },
      { tenant: tenant({ id: "t2", name: "Locked", lockdownMode: true }), isOriginator: true },
      { tenant: tenant({ id: "t3", name: "Approval", requireDeviceApproval: true }), isOriginator: false },
      { tenant: tenant({ id: "t4", name: "Suspended", suspended: true }), isOriginator: true },
    ]);
    const r = await call("GET", ID);
    expect(r.status).toBe(200);
    expect(r.json.device.fingerprint).toBe("aaaa-bbbb-cccc-dddd");
    expect(r.json.tailnets.map((t: any) => [t.name, t.blocked === null])).toEqual([
      ["Harbor", true],
      ["Locked", false],
      ["Approval", false],
    ]);
  });

  it("a machine already in a tailnet can only sign in to that tailnet", async () => {
    coord.getDeviceAuth.mockResolvedValue({ hostname: "h", os: "", fingerprint: "f", pending: true, registered_tenant_id: "c-other" });
    results.push([{ tenant: tenant(), isOriginator: true }]);
    expect((await call("GET", ID)).json.tailnets).toEqual([]);
  });

  it("an unknown, expired or answered link is 404", async () => {
    coord.getDeviceAuth.mockRejectedValue(new Error("failed (404)"));
    expect((await call("GET", ID)).status).toBe(404);
    expect((await call("GET", "not-an-id")).status).toBe(404);
  });

  it("approves for a member and binds the device to that member", async () => {
    results.push(ctx(), []); // tenant, no device lock
    const r = await call("POST", `${ID}/approve`, { tenantId: T, confirm: true });
    expect(r.status).toBe(200);
    expect(coord.approveDeviceAuth).toHaveBeenCalledWith(ID, "c-1", "u-1");
  });

  it.each([
    ["a non-member", [], 404],
    ["lockdown", ctx({ lockdownMode: true }), 403],
    ["a tailnet that requires device approval", ctx({ requireDeviceApproval: true }), 403],
  ])("refuses %s", async (_label, first, status) => {
    results.push(first);
    expect((await call("POST", `${ID}/approve`, { tenantId: T, confirm: true })).status).toBe(status);
    expect(coord.approveDeviceAuth).not.toHaveBeenCalled();
  });

  it("the originator may add a device where approval is required for others", async () => {
    results.push(ctx({ requireDeviceApproval: true }, true), []);
    expect((await call("POST", `${ID}/approve`, { tenantId: T, confirm: true })).status).toBe(200);
  });

  it("refuses a device-locked member and a tailnet at its device limit", async () => {
    results.push(ctx(), [{ id: "lock" }]);
    expect((await call("POST", `${ID}/approve`, { tenantId: T, confirm: true })).status).toBe(403);

    enforceDeviceLimit.mockImplementation(async (...args: unknown[]) => {
      const res = args[0] as { status: (c: number) => { json: (b: unknown) => void } };
      res.status(403).json({ error: "limit", code: "device_limit" });
      return false;
    });
    results.push(ctx(), []);
    expect((await call("POST", `${ID}/approve`, { tenantId: T, confirm: true })).json.code).toBe("device_limit");
    expect(coord.approveDeviceAuth).not.toHaveBeenCalled();
  });

  it("a link the coordinator no longer knows is 404", async () => {
    coord.approveDeviceAuth.mockRejectedValueOnce(new Error("failed (404)"));
    results.push(ctx(), []);
    expect((await call("POST", `${ID}/approve`, { tenantId: T, confirm: true })).status).toBe(404);
  });

  it("refusing tells the coordinator", async () => {
    expect((await call("POST", `${ID}/deny`)).status).toBe(200);
    expect(coord.denyDeviceAuth).toHaveBeenCalledWith(ID);
  });
  it("shows where and when the device asked (phishing check)", async () => {
    results.push([{ tenant: tenant(), isOriginator: true }]);
    const r = await call("GET", ID);
    expect(r.json.requesterIp).toBe("203.0.113.7");
    expect(typeof r.json.requestedAt).toBe("string");
  });

  it("approval needs confirm: true from the person who started the sign-in", async () => {
    for (const body of [{ tenantId: T }, { tenantId: T, confirm: false }, { tenantId: T, confirm: "true" }]) {
      const r = await call("POST", `${ID}/approve`, body, { "x-user": "u-confirm" });
      expect(r.status).toBe(400);
      expect(r.json.code).toBe("confirm_required");
    }
    expect(coord.approveDeviceAuth).not.toHaveBeenCalled();
  });

  it("a sign-in older than the coordinator's expiry is refused, even if still listed", async () => {
    coord.getDeviceAuth.mockResolvedValue({
      hostname: "h", os: "", fingerprint: "f", pending: true, registered_tenant_id: null,
      requester_ip: null, requested_at: new Date(Date.now() - 11 * 60_000).toISOString(),
    });
    expect((await call("GET", ID, undefined, { "x-user": "u-old" })).status).toBe(404);
    results.push(ctx(), []);
    expect((await call("POST", `${ID}/approve`, { tenantId: T, confirm: true }, { "x-user": "u-old" })).status).toBe(404);
    expect(coord.approveDeviceAuth).not.toHaveBeenCalled();
  });

  it("a trusted-device session needs a fresh step-up to approve", async () => {
    results.push(ctx(), []);
    const r = await call("POST", `${ID}/approve`, { tenantId: T, confirm: true }, { "x-user": "u-step", "x-stale-device": "1" });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("step_up_required");
    expect(coord.approveDeviceAuth).not.toHaveBeenCalled();
  });

  it("an approval is audited as device_signin_approved with the requester address", async () => {
    results.push(ctx(), []);
    expect((await call("POST", `${ID}/approve`, { tenantId: T, confirm: true }, { "x-user": "u-audit" })).status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "device_signin_approved", metadata: expect.objectContaining({ requesterIp: "203.0.113.7" }) }),
    );
  });

  it("approvals are rate-limited per user", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < DEVICE_SIGNIN_APPROVE_LIMIT + 1; i++) {
      statuses.push((await call("POST", `${ID}/approve`, { tenantId: T }, { "x-user": "u-flood" })).status);
    }
    expect(statuses.slice(0, DEVICE_SIGNIN_APPROVE_LIMIT).every((st) => st === 400)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    // Another user is not affected
    expect((await call("POST", `${ID}/approve`, { tenantId: T }, { "x-user": "u-other" })).status).toBe(400);
  });
});
