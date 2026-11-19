/**
 * Instance-operator features: tailnet-creation gating, no-access sign-in,
 * default tailnet claim, operator guard, suspension/disable enforcement,
 * disable cascade, invitations by DID with invite links.
 *
 * The DB is a chainable mock: every query (select/insert/update/delete chain)
 * resolves, when awaited, to the next entry of `results`; `.set()`/`.values()`
 * payloads are recorded in `writes`.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { AddressInfo } from "node:net";

vi.hoisted(() => {
  process.env.OPERATOR_DIDS = "did:plc:operator, did:plc:operator2";
});

const { results, writes, chain, tableName } = vi.hoisted(() => {
const results: unknown[] = [];
const writes: Array<{ op: string; table?: string; method: string; arg: unknown }> = [];

  function tableName(t: unknown): string | undefined {
    if (!t || typeof t !== "object") return undefined;
    const sym = Object.getOwnPropertySymbols(t).find((s) => s.description === "drizzle:Name");
    return sym ? (t as Record<symbol, string>)[sym] : undefined;
  }

function chain(op: string, table?: string): unknown {
  let tbl = table;
  const proxy: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") {
        const next = results.length ? results.shift() : [];
        return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve(next).then(res, rej);
      }
      return (...args: unknown[]) => {
        if (prop === "from") tbl = tableName(args[0]);
        if (prop === "set" || prop === "values") {
          writes.push({ op, table: tbl, method: String(prop), arg: args[0] });
        }
        return proxy;
      };
    },
  });
  return proxy;
}

  return { results, writes, chain, tableName };
});

vi.mock("../db/index.js", () => ({
  db: {
    select: () => chain("select"),
    selectDistinctOn: () => chain("select"),
    insert: (t: unknown) => chain("insert", tableName(t)),
    update: (t: unknown) => chain("update", tableName(t)),
    delete: (t: unknown) => chain("delete", tableName(t)),
  },
  pool: {},
}));

const { removeMemberCascade, revokeMemberAccess, oauthCallback } = vi.hoisted(() => ({
  removeMemberCascade: vi.fn(async (..._a: unknown[]) => ({
    removedUser: { handle: "bob.test" },
    access: { devicesDeleted: 2, keysRevoked: 1, errors: [] as string[] },
  })),
  revokeMemberAccess: vi.fn(async (..._a: unknown[]) => ({ devicesDeleted: 1, keysRevoked: 0, errors: [] as string[] })),
  oauthCallback: vi.fn(),
}));
vi.mock("../routes/devices.js", () => ({ removeMemberCascade }));
vi.mock("../routes/access.js", async (orig) => ({
  ...(await orig<typeof import("../routes/access.js")>()),
  revokeMemberAccess,
}));
vi.mock("../orchestrator/headscale.js", () => ({
  startInstance: vi.fn(),
  stopInstance: vi.fn(),
  destroyInstance: vi.fn(),
  adoptInstance: vi.fn(),
  createInstance: vi.fn(),
}));
vi.mock("../orchestrator/caddy.js", () => ({ syncTenantRoutes: vi.fn(async () => {}) }));

vi.mock("../auth/atproto.js", () => ({
  getOAuthClient: async () => ({ callback: oauthCallback }),
  getClientMetadata: () => ({}),
  getPublicJwks: async () => ({}),
}));
vi.mock("@atproto/api", () => ({
  Agent: class {
    async getProfile({ actor }: { actor: string }) {
      return { data: { handle: `${actor.slice(8)}.test`, displayName: null, avatar: null } };
    }
  },
}));

import express from "express";
import type { Request, Response, NextFunction } from "express";
import { decideCanCreateTailnet, canCreateTailnet, claimDefaultTailnet, withTailnetCreationLock } from "../operator/policy.js";
import { requireOperator } from "../operator/auth.js";
import { enforceOperatorState } from "../operator/access.js";
import { disableUser } from "../operator/lifecycle.js";
import { operatorRouter } from "../routes/operator.js";
import { invitationsRouter } from "../routes/invitations.js";
import { authRouter } from "../routes/auth.js";

beforeEach(() => {
  results.length = 0;
  writes.length = 0;
  vi.clearAllMocks();
});

// ── Test HTTP app with a fake session (x-user: "<userId>|<did>") ──
type FakeSession = Record<string, unknown> & { destroyed?: boolean };
const app = express();
app.use(express.json());
app.use((req: Request, _res: Response, next: NextFunction) => {
  const s: FakeSession = {
    regenerate: (cb: (e?: unknown) => void) => cb(),
    save: (cb: (e?: unknown) => void) => cb(),
    destroy: (cb: () => void) => {
      s.destroyed = true;
      cb();
    },
  };
  const h = req.headers["x-user"];
  if (typeof h === "string") {
    const [userId, did] = h.split("|");
    s.userId = userId;
    s.did = did;
  }
  (req as unknown as { session: FakeSession }).session = s;
  next();
});
app.use(authRouter);
app.use(enforceOperatorState);
app.use(operatorRouter);
app.use(invitationsRouter);
const server = app.listen(0);
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
afterAll(() => server.close());

async function call(method: string, path: string, user?: string, body?: unknown) {
  const res = await fetch(base() + path, {
    method,
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      ...(user ? { "x-user": user } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // html / empty
  }
  return { status: res.status, json: json as Record<string, unknown>, text, location: res.headers.get("location") };
}

const OP = "u-op|did:plc:operator";
const BOB = "u-bob|did:plc:bob";

// ── canCreateTailnet ──
describe("canCreateTailnet", () => {
  const who = {
    operator: { isOperator: true, isCreator: false },
    creator: { isOperator: false, isCreator: true },
    other: { isOperator: false, isCreator: false },
  };
  const cases: Array<[keyof typeof who, boolean, number, boolean]> = [
    ["operator", false, 0, true],
    ["operator", false, 3, true],
    ["operator", true, 0, true],
    ["operator", true, 1, false],
    ["creator", false, 0, true],
    ["creator", false, 5, true],
    ["creator", true, 0, true],
    ["creator", true, 1, false],
    ["other", false, 0, false],
    ["other", true, 0, false],
    ["other", false, 2, false],
  ];
  it.each(cases)("%s, singleTailnet=%s, %i top-level → %s", (w, singleTailnet, topLevelTenants, expected) => {
    expect(decideCanCreateTailnet({ ...who[w], singleTailnet, topLevelTenants })).toBe(expected);
  });

  it("operator from OPERATOR_DIDS; single-tailnet mode counts existing tenants", async () => {
    results.push([{ singleTailnet: true, defaultTailnetId: null }], [{ count: 1 }]);
    expect(await canCreateTailnet({ did: "did:plc:operator" })).toBe(false);
    results.push([{ singleTailnet: true, defaultTailnetId: null }], [{ count: 0 }]);
    expect(await canCreateTailnet({ did: "did:plc:operator2" })).toBe(true);
  });

  it("designated creator allowed; everybody else refused without reading settings", async () => {
    results.push([{ id: "c1" }], [{ singleTailnet: false, defaultTailnetId: null }]);
    expect(await canCreateTailnet({ did: "did:plc:creator" })).toBe(true);
    results.push([]); // not a creator
    expect(await canCreateTailnet({ did: "did:plc:stranger" })).toBe(false);
    expect(results).toHaveLength(0);
  });
});

// ── Sign-in ──
describe("auth callback", () => {
  it("no membership and no right to create → no tenant provisioned, redirect to /", async () => {
    oauthCallback.mockResolvedValue({ session: { did: "did:plc:stranger" } });
    results.push(
      [], // users by did → new user
      [{ id: "u-new", did: "did:plc:stranger", handle: "stranger.test", disabledAt: null }], // insert returning
      [], // memberships → none
      [], // tailnet_creators → not a creator
    );
    const r = await call("GET", "/auth/callback?code=x&state=y");
    expect(r.status).toBe(302);
    expect(r.location).toBe("/");
    expect(writes.some((w) => w.table === "tenants" && w.op === "insert")).toBe(false);
    expect(writes.some((w) => w.table === "memberships")).toBe(false);
  });

  it("disabled users are refused with a page, no session", async () => {
    oauthCallback.mockResolvedValue({ session: { did: "did:plc:bob" } });
    results.push([{ id: "u-bob", did: "did:plc:bob", handle: "bob.test", disabledAt: new Date() }]);
    const r = await call("GET", "/auth/callback?code=x&state=y");
    expect(r.status).toBe(403);
    expect(r.text).toMatch(/Account disabled/);
  });
});

// ── Default tailnet ──
describe("claimDefaultTailnet", () => {
  it("first operator tailnet becomes default and accepts join requests", async () => {
    results.push([], [{ id: 1 }], []);
    expect(await claimDefaultTailnet("t-1", "did:plc:operator")).toBe(true);
    expect(writes).toContainEqual(expect.objectContaining({ op: "update", table: "instance_settings", arg: expect.objectContaining({ defaultTailnetId: "t-1" }) }));
    expect(writes).toContainEqual(expect.objectContaining({ op: "update", table: "tenants", arg: expect.objectContaining({ allowJoinRequests: true }) }));
  });

  it("does nothing once a default exists", async () => {
    results.push([], []); // conditional update matched no row
    expect(await claimDefaultTailnet("t-2", "did:plc:operator")).toBe(false);
    expect(writes.some((w) => w.table === "tenants")).toBe(false);
  });

  it("non-operator tailnets never become the default", async () => {
    expect(await claimDefaultTailnet("t-3", "did:plc:creator")).toBe(false);
    expect(writes).toHaveLength(0);
  });
});

// ── requireOperator ──
describe("requireOperator", () => {
  function run(req: Partial<Request>) {
    const res = { code: 0, body: null as unknown, status(c: number) { this.code = c; return this; }, json(b: unknown) { this.body = b; return this; } };
    const next = vi.fn();
    return requireOperator(req as Request, res as unknown as Response, next).then(() => ({ res, next }));
  }

  it("accepts an operator session", async () => {
    const { next } = await run({ session: { userId: "u-op", did: "did:plc:operator" } } as never);
    expect(next).toHaveBeenCalled();
  });

  it("rejects agent tokens even for an operator's own token", async () => {
    const { res, next } = await run({
      session: {} as never,
      agentToken: { id: "a", tenantId: "t", userId: "u-op", permissions: [] },
    } as never);
    expect(next).not.toHaveBeenCalled();
    expect(res.code).toBe(403);
  });

  it("rejects non-operators (403) and anonymous requests (401)", async () => {
    let r = await run({ session: { userId: "u-bob", did: "did:plc:bob" } } as never);
    expect(r.res.code).toBe(403);
    r = await run({ session: {} } as never);
    expect(r.res.code).toBe(401);
  });

  it("guards every /api/operator route", async () => {
    const r = await call("GET", "/api/operator/settings", BOB);
    // enforceOperatorState user lookup consumes one result first
    expect(r.status).toBe(403);
  });
});

// ── Request-time enforcement ──
describe("enforceOperatorState", () => {
  const TENANT = "11111111-2222-3333-4444-555555555555";

  it("suspended tenant: members get 403 tenant_suspended", async () => {
    results.push([{ did: "did:plc:bob", disabledAt: null }], [{ suspended: true, membershipId: "m1" }]);
    const r = await call("GET", `/api/tenants/${TENANT}/invitations`, BOB);
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("tenant_suspended");
  });

  it("operators bypass suspension", async () => {
    results.push(
      [{ did: "did:plc:operator", disabledAt: null }],
      [{ suspended: true, membershipId: "m1" }],
      [], // getTenantForUser → not a member → 404 from the route
    );
    const r = await call("GET", `/api/tenants/${TENANT}/invitations`, OP);
    expect(r.status).toBe(404);
  });

  it("non-members of a suspended tenant still get the route's 404", async () => {
    results.push([{ did: "did:plc:bob", disabledAt: null }], [{ suspended: true, membershipId: null }], []);
    const r = await call("GET", `/api/tenants/${TENANT}/invitations`, BOB);
    expect(r.status).toBe(404);
  });

  it("disabled users are refused on every authenticated request", async () => {
    results.push([{ did: "did:plc:bob", disabledAt: new Date() }]);
    const r = await call("GET", "/api/invitations", BOB);
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("account_disabled");
  });
});

// ── Disable user ──
describe("disable user", () => {
  it("runs the kick cascade for every membership; originated tenants keep the membership but lose access", async () => {
    const t1 = { id: "t1", status: "running", apiKey: "k", port: 1 };
    const t2 = { id: "t2", status: "running", apiKey: "k", port: 2 };
    results.push(
      [{ did: "did:plc:bob" }], // users.disabledAt (returning did)
      [{ id: "tok1" }], // agent tokens revoked
      [{ id: "g1" }, { id: "g2" }], // MCP grants revoked
      [], // their MCP tokens revoked
      [{ id: "j1", tenantId: "t9" }], // pending join requests → rejected
      [{ id: "i1", tenantId: "t8" }], // pending invitations to their DID → revoked
      [{ tenant: t1, isOriginator: false }, { tenant: t2, isOriginator: true }],
      [{ id: "u-bob", handle: "bob.test" }], // user lookup for originated tenant
    );
    const out = await disableUser("u-bob", "u-op");
    expect(writes[0]).toMatchObject({ op: "update", table: "users", arg: { disabledAt: expect.any(Date) } });
    expect(removeMemberCascade).toHaveBeenCalledWith(t1, "u-bob");
    expect(removeMemberCascade).toHaveBeenCalledTimes(1);
    expect(revokeMemberAccess).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t2", userId: "u-bob" }));
    expect(writes).toContainEqual(expect.objectContaining({ op: "update", table: "mcp_oauth_grants", arg: { revokedAt: expect.any(Date) } }));
    expect(writes).toContainEqual(expect.objectContaining({ op: "update", table: "mcp_oauth_tokens", arg: { revokedAt: expect.any(Date) } }));
    expect(writes).toContainEqual(expect.objectContaining({ op: "update", table: "join_requests", arg: expect.objectContaining({ status: "rejected" }) }));
    expect(writes).toContainEqual(expect.objectContaining({ op: "update", table: "invitations", arg: expect.objectContaining({ status: "revoked" }) }));
    expect(out).toMatchObject({
      agentTokensRevoked: 1,
      mcpGrantsRevoked: 2,
      joinRequestsCancelled: 1,
      invitationsRevoked: 1,
      removedFrom: [{ tenantId: "t1", devicesDeleted: 2, keysRevoked: 1 }],
      ownedTenants: [{ tenantId: "t2" }],
    });
  });

  it("operators cannot disable themselves or other operators", async () => {
    const SELF = "00000000-0000-0000-0000-00000000000a";
    const OTHER = "00000000-0000-0000-0000-00000000000b";
    results.push([{ did: "did:plc:operator", disabledAt: null }], [{ id: SELF, did: "did:plc:operator" }]);
    let r = await call("POST", `/api/operator/users/${SELF}/disable`, `${SELF}|did:plc:operator`);
    expect(r.status).toBe(400);
    results.push([{ did: "did:plc:operator", disabledAt: null }], [{ id: OTHER, did: "did:plc:operator2" }]);
    r = await call("POST", `/api/operator/users/${OTHER}/disable`, `${SELF}|did:plc:operator`);
    expect(r.status).toBe(403);
    expect(removeMemberCascade).not.toHaveBeenCalled();
  });
});

// ── Invitations ──
describe("invitations", () => {
  const TENANT = "11111111-2222-3333-4444-555555555555";
  const INV = "99999999-8888-7777-6666-555555555555";
  const member = {
    tenant: { id: TENANT, lockdownMode: false, lastActivityAt: new Date() },
    membership: { isOriginator: true },
    role: null,
  };

  it("invites by DID, resolving the handle, and returns inviteUrl", async () => {
    results.push(
      [{ did: "did:plc:operator", disabledAt: null }], // enforceOperatorState user
      [{ suspended: false, membershipId: "m" }], // enforceOperatorState tenant
      [member], // getTenantForUser
      [{ handle: "carol.test" }], // resolveDidToHandle: known user
      [], // existing user by did → none
      [], // pending invitation → none
      [{ id: INV, tenantId: TENANT, inviteeDid: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", inviteeHandle: "carol.test", status: "pending" }],
    );
    const r = await call("POST", `/api/tenants/${TENANT}/invitations`, OP, { did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa" });
    expect(r.status).toBe(201);
    expect(r.json.inviteUrl).toBe(`http://localhost:3000/invite/${INV}`);
    expect(writes).toContainEqual(expect.objectContaining({
      op: "insert",
      table: "invitations",
      arg: expect.objectContaining({ inviteeDid: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", inviteeHandle: "carol.test" }),
    }));
  });

  it("rejects both/neither of handle and did, and malformed DIDs", async () => {
    for (const body of [{}, { handle: "a.test", did: "did:plc:x" }, { did: "not-a-did" }]) {
      results.push([{ did: "did:plc:operator", disabledAt: null }], [{ suspended: false, membershipId: "m" }], [member]);
      const r = await call("POST", `/api/tenants/${TENANT}/invitations`, OP, body);
      expect(r.status).toBe(400);
    }
  });

  it("list includes inviteUrl", async () => {
    results.push([{ did: "did:plc:operator", disabledAt: null }], [{ suspended: false, membershipId: "m" }], [member], [{ id: INV, inviteeHandle: "carol.test" }]);
    const r = await call("GET", `/api/tenants/${TENANT}/invitations`, OP);
    expect((r.json as unknown as Array<{ inviteUrl: string }>)[0].inviteUrl).toMatch(new RegExp(`/invite/${INV}$`));
  });

  it("GET /api/invitations/:id is for the invitee only", async () => {
    results.push(
      [{ did: "did:plc:carol", disabledAt: null }],
      [{ id: INV, status: "pending", tenantId: TENANT, tenantName: "Acme", tenantSlug: "acme", tenantStatus: "running", inviterHandle: "op.test" }],
    );
    let r = await call("GET", `/api/invitations/${INV}`, "u-carol|did:plc:carol");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      id: INV,
      tenant: { id: TENANT, name: "Acme", slug: "acme" },
      inviterHandle: "op.test",
      status: "pending",
    });

    // Someone else: the invitee-DID filter matches no row → 404
    results.push([{ did: "did:plc:bob", disabledAt: null }], []);
    r = await call("GET", `/api/invitations/${INV}`, BOB);
    expect(r.status).toBe(404);
  });
});

describe("withTailnetCreationLock", () => {
  it("runs check-then-create sections one at a time, even if one throws", async () => {
    let active = 0;
    let maxActive = 0;
    const created: number[] = [];
    const section = (i: number, fail = false) =>
      withTailnetCreationLock(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        const allowed = created.length === 0;
        if (allowed) created.push(i);
        active--;
        if (fail) throw new Error("boom");
        return allowed;
      });
    const results = await Promise.allSettled([section(1, true), section(2), section(3)]);
    expect(maxActive).toBe(1);
    expect(created).toEqual([1]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
  });
});

// ── Security fixes ──
import { setTenantSuspendedCascade, OperatorActionError } from "../operator/lifecycle.js";
import { memberAccess } from "../operator/policy.js";
import { tenantIdFromPath } from "../operator/access.js";
import { startInstance, stopInstance } from "../orchestrator/headscale.js";

describe("suspension check uses the decoded tenant id", () => {
  const TENANT = "11111111-2222-3333-4444-555555555555";

  it("tenantIdFromPath decodes like Express and flags encoded slashes", () => {
    expect(tenantIdFromPath(`/api/tenants/${TENANT}/devices`)).toBe(TENANT);
    expect(tenantIdFromPath(`/api/tenants/%31${TENANT.slice(1)}/devices`)).toBe(TENANT);
    expect(tenantIdFromPath(`/API/TENANTS/${TENANT.toUpperCase()}`)).toBe(TENANT);
    expect(tenantIdFromPath(`/api/tenants/${TENANT}%2Fdevices`)).toBe("invalid");
    expect(tenantIdFromPath(`/api/tenants/a%5Cb`)).toBe("invalid");
    expect(tenantIdFromPath(`/api/tenants/%E0%A4%A`)).toBe("invalid");
    expect(tenantIdFromPath(`/api/tenants/mine`)).toBeNull();
    expect(tenantIdFromPath(`/api/me`)).toBeNull();
  });

  it("a percent-encoded tenant id still gets 403 tenant_suspended", async () => {
    results.push([{ did: "did:plc:bob", disabledAt: null }], [{ suspended: true, membershipId: "m1" }]);
    const r = await call("GET", `/api/tenants/%31${TENANT.slice(1)}/invitations`, BOB);
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("tenant_suspended");
  });

  it("malformed encoding and encoded slashes are 400", async () => {
    results.push([{ did: "did:plc:bob", disabledAt: null }]);
    let r = await call("GET", `/api/tenants/${TENANT}%2Finvitations`, BOB);
    expect(r.status).toBe(400);
    results.push([{ did: "did:plc:bob", disabledAt: null }]);
    r = await call("GET", `/api/tenants/%E0%A4%A/invitations`, BOB);
    expect(r.status).toBe(400);
  });
});

describe("suspension cascades to sub-tailnets", () => {
  const P = { id: "p", parentId: null, status: "running", containerId: "c-p", suspended: false, suspendedByParentId: null };
  const C1 = { id: "c1", parentId: "p", status: "running", containerId: "c-c1", suspended: false, suspendedByParentId: null };
  const C2 = { id: "c2", parentId: "p", status: "stopped", containerId: "c-c2", suspended: true, suspendedByParentId: null };
  const G = { id: "g", parentId: "c1", status: "running", containerId: null, suspended: false, suspendedByParentId: null };

  it("suspending a parent suspends unsuspended descendants and records the cascade", async () => {
    results.push(
      [{ ...P, suspended: true }], // root update
      [C1, C2], // children of p
      [G], // children of c1, c2
      [], // children of g
      [{ ...C1, suspended: true }], // c1 update
      [{ ...G, suspended: true }], // g update
    );
    const r = await setTenantSuspendedCascade(P as never, true);
    expect(r.cascaded).toEqual(["c1", "g"]);
    expect(r.failed).toEqual([]);
    expect(stopInstance).toHaveBeenCalledWith("c-p");
    expect(stopInstance).toHaveBeenCalledWith("c-c1");
    expect(stopInstance).not.toHaveBeenCalledWith("c-c2");
    const tenantWrites = writes.filter((w) => w.table === "tenants").map((w) => w.arg as Record<string, unknown>);
    expect(tenantWrites[0]).toMatchObject({ suspended: true, suspendedByParentId: null });
    expect(tenantWrites.slice(1)).toEqual([
      expect.objectContaining({ suspended: true, suspendedByParentId: "p" }),
      expect.objectContaining({ suspended: true, suspendedByParentId: "p" }),
    ]);
  });

  it("unsuspending restores only the tenants its suspension cascaded to", async () => {
    results.push(
      [{ ...P, suspended: false }], // root update
      [{ ...C1, suspended: true, suspendedByParentId: "p" }, { ...G, suspended: true, suspendedByParentId: "p" }], // restore set
      [C1],
      [G],
    );
    const r = await setTenantSuspendedCascade({ ...P, suspended: true } as never, false);
    expect(r.cascaded).toEqual(["c1", "g"]);
    expect(startInstance).toHaveBeenCalledWith("c-p");
    expect(startInstance).toHaveBeenCalledWith("c-c1");
    expect(startInstance).not.toHaveBeenCalledWith("c-c2");
    const tenantWrites = writes.filter((w) => w.table === "tenants").map((w) => w.arg as Record<string, unknown>);
    expect(tenantWrites.every((w) => w.suspended === false && w.suspendedByParentId === null)).toBe(true);
  });

  it("a child of a suspended parent cannot be unsuspended on its own", async () => {
    results.push([{ suspended: true }]);
    await expect(
      setTenantSuspendedCascade({ ...C1, suspended: true, suspendedByParentId: "p" } as never, false),
    ).rejects.toBeInstanceOf(OperatorActionError);
    expect(startInstance).not.toHaveBeenCalled();
  });

  it("descendant control-plane failures are reported (502) and retryable", async () => {
    vi.mocked(stopInstance).mockImplementation(async (id: string) => {
      if (id === "c-c1") throw new Error("docker down");
    });
    const SUSP = "11111111-2222-3333-4444-555555555555";
    results.push(
      [{ did: "did:plc:operator", disabledAt: null }], // enforceOperatorState
      [{ ...P, id: SUSP }], // loadTenant
      [{ ...P, id: SUSP, suspended: true }], // root update
      [{ ...C1, parentId: SUSP }],
      [],
    );
    const r = await call("POST", `/api/operator/tenants/${SUSP}/suspend`, OP);
    expect(r.status).toBe(502);
    expect(r.json.code).toBe("cascade_incomplete");
    expect(r.json.failed).toEqual([{ tenantId: "c1", error: "docker down" }]);
    vi.mocked(stopInstance).mockReset();
  });
});

describe("/api/me access", () => {
  it("memberships only in suspended tailnets count as no_access", async () => {
    results.push([]); // no live, unsuspended membership
    expect(await memberAccess("u-bob")).toBe("no_access");
    results.push([{ id: "m1" }]);
    expect(await memberAccess("u-bob")).toBe("member");
  });
});

describe("GET /api/operator/audit", () => {
  const row = (i: number) => ({
    id: `a${i}`,
    tenantId: null,
    tenantSlug: null,
    actorUserId: "u-op",
    actorHandle: "op.test",
    action: "user_disabled",
    targetType: "user",
    targetId: "u-bob",
    metadata: null,
    createdAt: new Date().toISOString(),
  });

  it("returns a page of instance activity with hasMore", async () => {
    results.push([{ did: "did:plc:operator", disabledAt: null }], [row(1), row(2), row(3)]);
    const r = await call("GET", "/api/operator/audit?limit=2&offset=0", OP);
    expect(r.status).toBe(200);
    expect((r.json.entries as unknown[]).length).toBe(2);
    expect(r.json).toMatchObject({ limit: 2, offset: 0, hasMore: true });
  });

  it("validates paging and is operator-only", async () => {
    results.push([{ did: "did:plc:operator", disabledAt: null }]);
    expect((await call("GET", "/api/operator/audit?limit=500", OP)).status).toBe(400);
    results.push([{ did: "did:plc:bob", disabledAt: null }]);
    expect((await call("GET", "/api/operator/audit", BOB)).status).toBe(403);
  });
});

describe("operator suspension bypass via MCP", () => {
  it("an operator's MCP token without the operator scope does not bypass suspension", async () => {
    const TENANT = "11111111-2222-3333-4444-555555555555";
    results.push([{ did: "did:plc:operator", disabledAt: null }], [{ suspended: true, membershipId: "m1" }]);
    const res = { code: 0, body: null as unknown, status(c: number) { this.code = c; return this; }, json(b: unknown) { this.body = b; return this; } };
    const next = vi.fn();
    await enforceOperatorState(
      { path: `/api/tenants/${TENANT}/devices`, session: {}, mcpAuth: { userId: "u-op", clientId: "c", grantId: "g", operator: false } } as never,
      res as never,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.code).toBe(403);
  });
});
