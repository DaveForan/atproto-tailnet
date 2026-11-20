/**
 * tenantGuard (routes/guard.ts): the shared tenant guard keeps the inline
 * guards' status codes, bodies and order — 404 for non-members, originator /
 * agent-token refusals, permission (with agent-token scope), lockdown — and
 * hands the handler its context.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { AddressInfo } from "node:net";

const h = vi.hoisted(() => ({
  lookup: vi.fn(),
}));

vi.mock("../db/index.js", () => ({ db: {}, pool: {} }));
vi.mock("../routes/helpers.js", async (orig) => ({
  ...(await orig<typeof import("../routes/helpers.js")>()),
  getTenantForUser: h.lookup,
}));

import express, { type Request, type Response, type NextFunction } from "express";
import { tenantGuard, tenantCtx, type TenantGuardOptions } from "../routes/guard.js";

const T = "11111111-1111-4111-8111-111111111111";

type Caller = { userId: string; agentPermissions?: string[] };
let caller: Caller = { userId: "u-1" };

function member(opts: { originator?: boolean; perms?: string[]; lockdown?: boolean } = {}) {
  return {
    tenant: { id: T, lockdownMode: opts.lockdown ?? false },
    membership: { id: "m-1", isOriginator: opts.originator ?? false },
    role: opts.perms ? { id: "r-1", permissions: opts.perms } : null,
  };
}

const routes: Array<[string, TenantGuardOptions]> = [
  ["plain", {}],
  ["perm", { permission: "manage_settings" }],
  ["anyof", { permission: ["approve_devices", "manage_devices"] }],
  ["custom-perm", { permission: "invite", permissionError: "You do not have permission to invite" }],
  ["lock", { notLockedDown: true }],
  ["perm-lock", { permission: "manage_settings", notLockedDown: true }],
  ["lock-msg", { notLockedDown: "Tenant is in lockdown mode — cannot accept invitations" }],
  ["session", { noAgentToken: "Agent tokens cannot manage friends or shares" }],
  ["origin", { originatorOnly: "Only the originator can change limits", noAgentToken: "Agent tokens cannot change limits" }],
];

const app = express();
app.use((req: Request, _res: Response, next: NextFunction) => {
  (req as unknown as { session: unknown }).session = caller.agentPermissions ? {} : { userId: caller.userId };
  if (caller.agentPermissions) {
    req.agentToken = { id: "tok", tenantId: T, userId: caller.userId, permissions: caller.agentPermissions };
  }
  next();
});
for (const [name, opts] of routes) {
  app.get(`/api/tenants/:tenantId/${name}`, tenantGuard(opts), (_req, res) => {
    const ctx = tenantCtx(res);
    res.json({ tenant: ctx.tenant.id, userId: ctx.userId, membership: ctx.membership.id });
  });
}
app.get("/api/x/:id", tenantGuard({ param: "id" }), (_req, res) => {
  res.json({ tenant: tenantCtx(res).tenant.id });
});
const server = app.listen(0);
afterAll(() => server.close());

async function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

beforeEach(() => {
  h.lookup.mockReset();
  caller = { userId: "u-1" };
});

describe("tenantGuard", () => {
  it("answers 404 Tenant not found for a non-member, never 403", async () => {
    h.lookup.mockResolvedValue(null);
    for (const name of ["plain", "perm", "lock", "session", "origin"]) {
      expect(await get(`/api/tenants/${T}/${name}`)).toEqual({ status: 404, body: { error: "Tenant not found" } });
    }
    expect(h.lookup).toHaveBeenCalledWith(T, "u-1");
  });

  it("sets the context for the handler (tenant, membership, caller)", async () => {
    h.lookup.mockResolvedValue(member());
    expect(await get(`/api/tenants/${T}/plain`)).toEqual({
      status: 200,
      body: { tenant: T, userId: "u-1", membership: "m-1" },
    });
  });

  it("reads the tenant id from the named param", async () => {
    h.lookup.mockResolvedValue(member());
    expect((await get(`/api/x/${T}`)).status).toBe(200);
    expect(h.lookup).toHaveBeenCalledWith(T, "u-1");
  });

  it("answers 403 Insufficient permissions without the permission", async () => {
    h.lookup.mockResolvedValue(member({ perms: ["invite"] }));
    expect(await get(`/api/tenants/${T}/perm`)).toEqual({ status: 403, body: { error: "Insufficient permissions" } });
    h.lookup.mockResolvedValue(member({ perms: ["manage_settings"] }));
    expect((await get(`/api/tenants/${T}/perm`)).status).toBe(200);
  });

  it("accepts any one of several permissions", async () => {
    h.lookup.mockResolvedValue(member({ perms: ["manage_devices"] }));
    expect((await get(`/api/tenants/${T}/anyof`)).status).toBe(200);
    h.lookup.mockResolvedValue(member({ perms: ["invite"] }));
    expect((await get(`/api/tenants/${T}/anyof`)).status).toBe(403);
  });

  it("uses a custom permission error when given", async () => {
    h.lookup.mockResolvedValue(member({ perms: [] }));
    expect(await get(`/api/tenants/${T}/custom-perm`)).toEqual({
      status: 403,
      body: { error: "You do not have permission to invite" },
    });
  });

  it("applies agent-token scope to the permission check (originators included)", async () => {
    caller = { userId: "u-1", agentPermissions: ["invite"] };
    h.lookup.mockResolvedValue(member({ originator: true }));
    expect(await get(`/api/tenants/${T}/perm`)).toEqual({ status: 403, body: { error: "Insufficient permissions" } });
    caller = { userId: "u-1", agentPermissions: ["manage_settings"] };
    expect((await get(`/api/tenants/${T}/perm`)).status).toBe(200);
  });

  it("refuses lockdown with the exact body, after the permission check", async () => {
    h.lookup.mockResolvedValue(member({ originator: true, lockdown: true }));
    expect(await get(`/api/tenants/${T}/lock`)).toEqual({ status: 403, body: { error: "Tenant is in lockdown mode" } });
    expect(await get(`/api/tenants/${T}/lock-msg`)).toEqual({
      status: 403,
      body: { error: "Tenant is in lockdown mode — cannot accept invitations" },
    });
    // Permission comes before lockdown
    h.lookup.mockResolvedValue(member({ perms: [], lockdown: true }));
    expect(await get(`/api/tenants/${T}/perm-lock`)).toEqual({ status: 403, body: { error: "Insufficient permissions" } });
    h.lookup.mockResolvedValue(member({ originator: true }));
    expect((await get(`/api/tenants/${T}/perm-lock`)).status).toBe(200);
  });

  it("refuses agent tokens with the route's message after the lookup", async () => {
    caller = { userId: "u-1", agentPermissions: ["manage_settings"] };
    h.lookup.mockResolvedValue(null);
    expect((await get(`/api/tenants/${T}/session`)).status).toBe(404);
    h.lookup.mockResolvedValue(member({ originator: true }));
    expect(await get(`/api/tenants/${T}/session`)).toEqual({
      status: 403,
      body: { error: "Agent tokens cannot manage friends or shares" },
    });
    caller = { userId: "u-1" };
    expect((await get(`/api/tenants/${T}/session`)).status).toBe(200);
  });

  it("checks originator before the agent-token refusal", async () => {
    caller = { userId: "u-1", agentPermissions: [] };
    h.lookup.mockResolvedValue(member({ perms: ["manage_settings"] }));
    expect(await get(`/api/tenants/${T}/origin`)).toEqual({
      status: 403,
      body: { error: "Only the originator can change limits" },
    });
    h.lookup.mockResolvedValue(member({ originator: true }));
    expect(await get(`/api/tenants/${T}/origin`)).toEqual({ status: 403, body: { error: "Agent tokens cannot change limits" } });
    caller = { userId: "u-1" };
    expect((await get(`/api/tenants/${T}/origin`)).status).toBe(200);
  });
});
