/**
 * Regression tests for the public-surface / abuse hardening:
 * sub-collective creation gating, join-request spam limits, public slug
 * lookup, invitations on suspended/deleted tailnets, invite-by-handle SSRF
 * guard + DID normalisation, anonymous /invite/:id, suspended tenants on
 * public board / DID endpoints, and the TLS ask check.
 *
 * The DB is a chainable mock (same shape as operator.test.ts): each awaited
 * query resolves to the next entry of `results`; `.set()`/`.values()`/
 * `.where()` arguments are recorded in `writes`.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { AddressInfo } from "node:net";

vi.hoisted(() => {
  process.env.OPERATOR_DIDS = "did:plc:operator";
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
          if (prop === "set" || prop === "values" || prop === "where") {
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

const { notify, resolvesToPublicAddresses } = vi.hoisted(() => ({
  notify: vi.fn(),
  resolvesToPublicAddresses: vi.fn(async (_h: string) => false),
}));
vi.mock("../notifications/service.js", async (orig) => ({
  ...(await orig<typeof import("../notifications/service.js")>()),
  notify,
}));
vi.mock("../identity/resolver.js", async (orig) => ({
  ...(await orig<typeof import("../identity/resolver.js")>()),
  resolvesToPublicAddresses,
}));
vi.mock("node:dns/promises", async (orig) => ({
  ...(await orig<typeof import("node:dns/promises")>()),
  resolveTxt: vi.fn(async () => {
    throw new Error("ENOTFOUND");
  }),
}));
vi.mock("../routes/audit.js", () => ({ logAudit: vi.fn() }));
vi.mock("../orchestrator/headscale.js", () => ({
  startInstance: vi.fn(),
  stopInstance: vi.fn(),
  destroyInstance: vi.fn(),
  adoptInstance: vi.fn(),
  createInstance: vi.fn(),
}));
vi.mock("../orchestrator/caddy.js", () => ({ syncTenantRoutes: vi.fn(async () => {}) }));
vi.mock("../orchestrator/ports.js", async (orig) => ({
  ...(await orig<typeof import("../orchestrator/ports.js")>()),
  releaseTenantPort: vi.fn(async () => {}),
}));
vi.mock("../auth/atproto.js", () => ({
  getOAuthClient: async () => ({}),
  getClientMetadata: () => ({}),
  getPublicJwks: async () => ({}),
}));

import express from "express";
import type { Request, Response, NextFunction } from "express";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  apiRouter,
  deleteTenantInstance,
  tlsCertAllowedForSlug,
  MAX_PENDING_JOIN_REQUESTS,
} from "../routes/api.js";
import { collectivesRouter } from "../routes/collectives.js";
import { invitationsRouter, normalizeAccountDid, resolveHandleToDid } from "../routes/invitations.js";
import { dashboardRouter } from "../routes/dashboard.js";
import { boardRouter, findPublicBoardTenant } from "../routes/board.js";
import { federationRouter } from "../routes/federation.js";

beforeEach(() => {
  results.length = 0;
  writes.length = 0;
  vi.clearAllMocks();
});

// ── Test HTTP app with a fake session (x-user: "<userId>|<did>") ──
type FakeSession = Record<string, unknown>;
const sessions: FakeSession[] = [];
const app = express();
app.use(express.json());
app.use((req: Request, _res: Response, next: NextFunction) => {
  const s: FakeSession = {};
  const h = req.headers["x-user"];
  if (typeof h === "string") {
    const [userId, did] = h.split("|");
    s.userId = userId;
    s.did = did;
  }
  sessions.push(s);
  (req as unknown as { session: FakeSession }).session = s;
  next();
});
app.use(apiRouter);
app.use(collectivesRouter);
app.use(invitationsRouter);
app.use(dashboardRouter);
app.use(boardRouter);
app.use(federationRouter);
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
  return {
    status: res.status,
    json: json as Record<string, unknown>,
    text,
    headers: res.headers,
  };
}

const dialect = new PgDialect();
/** SQL text of the most recent recorded `.where()` (optionally for one table). */
function lastWhereSql(table?: string): string {
  const w = [...writes].reverse().find((x) => x.method === "where" && (!table || x.table === table));
  if (!w) throw new Error("no where() recorded");
  return dialect.sqlToQuery(w.arg as SQL).sql;
}

const TENANT = "11111111-1111-4111-8111-111111111111";
const OP = "u-op|did:plc:operator";
const BOB = "u-bob|did:plc:bob";

function tenantRow(over: Record<string, unknown> = {}) {
  return {
    id: TENANT,
    slug: "acme",
    name: "Acme",
    status: "running",
    suspended: false,
    allowJoinRequests: true,
    lockdownMode: false,
    depth: 0,
    path: "acme",
    maxSubCollectives: 10,
    coordinatorTenantId: null,
    apiKey: "k",
    defaultRoleId: "r1",
    lastActivityAt: new Date(),
    ...over,
  };
}

// ── 1. Sub-collectives require tailnet-creation rights ──
describe("sub-collective creation", () => {
  const membership = (over: Record<string, unknown> = {}) => [
    { tenant: tenantRow(over), membership: { isOriginator: true, roleId: null }, role: null },
  ];
  const settings = [{ singleTailnet: false, defaultTailnetId: null }];

  it("refuses an originator who may not create tailnets (403 cannot_create_tailnet)", async () => {
    results.push(membership(), settings, [] /* not a designated creator */);
    const r = await call("POST", `/api/tenants/${TENANT}/collectives`, BOB, { name: "Sub", slug: "sub" });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("cannot_create_tailnet");
    expect(writes.some((w) => w.op === "insert" && w.table === "tenants")).toBe(false);
  });

  it("lets operators and designated creators past the gate", async () => {
    // depth 5 → the next check (400) proves the creation gate passed
    results.push(membership({ depth: 5 }), settings);
    let r = await call("POST", `/api/tenants/${TENANT}/collectives`, OP, { name: "Sub", slug: "sub" });
    expect(r.status).toBe(400);

    results.push(membership({ depth: 5 }), settings, [{ id: "c1" }], settings);
    r = await call("POST", `/api/tenants/${TENANT}/collectives`, BOB, { name: "Sub", slug: "sub" });
    expect(r.status).toBe(400);
  });

  it("single-tailnet mode still answers 409 first", async () => {
    results.push(membership(), [{ singleTailnet: true, defaultTailnetId: null }], []);
    const r = await call("POST", `/api/tenants/${TENANT}/collectives`, OP, { name: "Sub", slug: "sub" });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("single_tailnet");
  });
});

// ── 2. Join-request spam ──
describe("join requests", () => {
  const path = `/api/tenants/${TENANT}/join-requests`;
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);

  it("refuses suspended and deleted tenants", async () => {
    results.push([tenantRow({ suspended: true })]);
    expect((await call("POST", path, BOB, {})).status).toBe(404);
    results.push([tenantRow({ status: "deleted" })]);
    expect((await call("POST", path, BOB, {})).status).toBe(404);
  });

  it("one pending request per requester (409)", async () => {
    results.push([tenantRow()], [], [{ status: "pending", requestedAt: hoursAgo(1), reviewedAt: null }]);
    const r = await call("POST", path, BOB, {});
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("join_request_pending");
  });

  it("a concurrent duplicate hitting the partial unique index is a 409, not a 500", async () => {
    const dup = Promise.reject(Object.assign(new Error("duplicate key"), { code: "23505" }));
    dup.catch(() => {});
    results.push([tenantRow()], [], [], [{ pending: 0 }], dup);
    const r = await call("POST", path, BOB, {});
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("join_request_pending");
    expect(notify).not.toHaveBeenCalled();
  });

  it("cooldown after rejection (429 join_cooldown + retryAfter)", async () => {
    results.push([tenantRow()], [], [{ status: "rejected", requestedAt: hoursAgo(2), reviewedAt: hoursAgo(1) }]);
    const r = await call("POST", path, BOB, {});
    expect(r.status).toBe(429);
    expect(r.json.code).toBe("join_cooldown");
    expect(r.json.retryAfter).toBeGreaterThan(22 * 3600);
    expect(r.json.retryAfter).toBeLessThanOrEqual(23 * 3600);
    expect(r.headers.get("retry-after")).toBe(String(r.json.retryAfter));
  });

  it("caps the pending queue per tailnet (429 join_queue_full)", async () => {
    results.push([tenantRow()], [], [], [{ pending: MAX_PENDING_JOIN_REQUESTS }]);
    const r = await call("POST", path, BOB, {});
    expect(r.status).toBe(429);
    expect(r.json.code).toBe("join_queue_full");
    expect(writes.some((w) => w.op === "insert" && w.table === "join_requests")).toBe(false);
  });

  it("notifies on a first request, but not again for the same requester within the window", async () => {
    results.push([tenantRow()], [], [], [{ pending: 0 }], [{ id: "jr1" }], [{ handle: "bob.test" }]);
    let r = await call("POST", path, BOB, {});
    expect(r.status).toBe(201);
    expect(notify).toHaveBeenCalledTimes(1);

    notify.mockClear();
    // previous request (approved, then removed) an hour ago → no new notification
    results.push(
      [tenantRow()],
      [],
      [{ status: "approved", requestedAt: hoursAgo(1), reviewedAt: hoursAgo(1) }],
      [{ pending: 0 }],
      [{ id: "jr2" }],
    );
    r = await call("POST", path, BOB, {});
    expect(r.status).toBe(201);
    expect(notify).not.toHaveBeenCalled();

    // rejection older than the cooldown → allowed and notified again
    results.push(
      [tenantRow()],
      [],
      [{ status: "rejected", requestedAt: hoursAgo(30), reviewedAt: hoursAgo(25) }],
      [{ pending: 0 }],
      [{ id: "jr3" }],
      [{ handle: "bob.test" }],
    );
    r = await call("POST", path, BOB, {});
    expect(r.status).toBe(201);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

// ── 3. Public slug lookup ──
describe("GET /api/tenants/by-slug/:slug/public", () => {
  it("is 404 unless the tailnet accepts join requests", async () => {
    // Each lookup resolves the public name first (tenant_hostnames), then loads the tenant
    const byName = [{ tenantId: TENANT }];
    results.push(byName, [tenantRow({ allowJoinRequests: false })]);
    expect((await call("GET", "/api/tenants/by-slug/acme/public")).status).toBe(404);
    results.push(byName, [tenantRow({ suspended: true })]);
    expect((await call("GET", "/api/tenants/by-slug/acme/public")).status).toBe(404);
    results.push(byName, [tenantRow({ lockdownMode: true })]);
    expect((await call("GET", "/api/tenants/by-slug/acme/public")).status).toBe(404);

    results.push(byName, [tenantRow()], [{ slug: "acme-public" }]);
    const r = await call("GET", "/api/tenants/by-slug/acme-public/public");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ id: TENANT, address: "acme-public", name: "Acme", joinOpen: true });
  });
});

// ── 4. Invitations on suspended / deleted tailnets ──
describe("invitations and tenant state", () => {
  const INV = "22222222-2222-4222-8222-222222222222";
  const invitation = [{ id: INV, tenantId: TENANT, inviteeDid: "did:plc:bob", status: "pending" }];

  it("accept is 404 for a suspended or deleted tailnet", async () => {
    results.push(invitation, [tenantRow({ suspended: true })]);
    expect((await call("POST", `/api/invitations/${INV}/accept`, BOB)).status).toBe(404);
    results.push(invitation, [tenantRow({ status: "deleted" })]);
    expect((await call("POST", `/api/invitations/${INV}/accept`, BOB)).status).toBe(404);
    expect(writes.some((w) => w.op === "insert" && w.table === "memberships")).toBe(false);
  });

  it("deleting a tenant revokes its pending invitations", async () => {
    await deleteTenantInstance(tenantRow({ containerId: null }) as never);
    const revoke = writes.find((w) => w.op === "update" && w.table === "invitations" && w.method === "set");
    expect(revoke?.arg).toMatchObject({ status: "revoked" });
    const where = writes.find((w) => w.op === "update" && w.table === "invitations" && w.method === "where");
    expect(dialect.sqlToQuery(where!.arg as SQL).sql).toContain('"invitations"."status" = $');
  });
});

// ── 5. Invite-by-handle SSRF guard + DID normalisation ──
describe("handle resolution and DID normalisation", () => {
  it("never fetches .well-known on a handle resolving to non-public addresses", async () => {
    resolvesToPublicAddresses.mockResolvedValueOnce(false);
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 404 }));
    try {
      expect(await resolveHandleToDid("internal.example")).toBeNull();
      const urls = spy.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("internal.example/.well-known"))).toBe(false);
      for (const [, init] of spy.mock.calls) {
        expect(init?.redirect).toBe("error");
        expect(init?.signal).toBeInstanceOf(AbortSignal);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("fetches .well-known for public hosts with a timeout and no redirects", async () => {
    resolvesToPublicAddresses.mockResolvedValueOnce(true);
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("did:plc:abcdefghijklmnopqrstuvwx\n", { status: 200 }));
    try {
      expect(await resolveHandleToDid("alice.example")).toBe("did:plc:abcdefghijklmnopqrstuvwx");
      expect(String(spy.mock.calls[0][0])).toBe("https://alice.example/.well-known/atproto-did");
      expect(spy.mock.calls[0][1]?.redirect).toBe("error");
      expect(spy.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      spy.mockRestore();
    }
  });

  it("lowercases the did:web host only", () => {
    expect(normalizeAccountDid("did:web:Example.COM")).toBe("did:web:example.com");
    expect(normalizeAccountDid("did:web:Example.com%3a8080:User:Bob")).toBe("did:web:example.com%3A8080:User:Bob");
    expect(normalizeAccountDid("did:plc:abcdefghijklmnopqrstuvwx")).toBe("did:plc:abcdefghijklmnopqrstuvwx");
  });

  it("invite-by-DID stores the normalised did:web", async () => {
    const membership = [{ tenant: tenantRow(), membership: { isOriginator: true, roleId: null }, role: null }];
    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
      String(input).startsWith(base()) ? realFetch(input, init) : Promise.resolve(new Response("{}", { status: 404 })),
    );
    try {
      results.push(membership, [] /* known user for handle */, [] /* existing user */, [] /* pending */, [{ id: "inv1" }]);
      const r = await call("POST", `/api/tenants/${TENANT}/invitations`, OP, { did: "did:web:Alice.Example.com" });
      expect(r.status).toBe(201);
    } finally {
      spy.mockRestore();
    }
    const ins = writes.find((w) => w.op === "insert" && w.table === "invitations");
    expect(ins?.arg).toMatchObject({ inviteeDid: "did:web:alice.example.com" });
  });
});

// ── 6. Anonymous /invite/:id doesn't write the session ──
describe("GET /invite/:id", () => {
  it("serves the shell without touching an anonymous session", async () => {
    sessions.length = 0;
    const r = await call("GET", "/invite/22222222-2222-4222-8222-222222222222");
    expect(r.status).toBe(200);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual({});
  });
});

// ── 7. Suspended / deleted tenants on public endpoints ──
describe("public board and DID endpoints", () => {
  it("board lookup filters deleted and suspended tenants", async () => {
    results.push([]);
    expect(await findPublicBoardTenant("acme")).toBeNull();
    const sql = lastWhereSql("tenants");
    expect(sql).toContain('"tenants"."status" <> $');
    expect(sql).toContain('"tenants"."suspended" = $');
  });

  it("/board/:slug and the board API are 404 when the tenant isn't public", async () => {
    results.push([]);
    expect((await call("GET", "/board/acme")).status).toBe(404);
    results.push([]);
    expect((await call("GET", "/api/tenants/by-slug/acme/board")).status).toBe(404);

    results.push([{ tenantId: TENANT }], [{ ...tenantRow(), boardEnabled: true, maxBoardPostsDisplayed: 10 }]);
    expect((await call("GET", "/board/acme")).status).toBe(200);
  });

  it("collective DID document is not served for suspended or deleted tenants", async () => {
    results.push([]);
    expect((await call("GET", "/collective/acme/did.json")).status).toBe(404);
    let sql = lastWhereSql();
    expect(sql).toContain('"tenants"."suspended" = $');
    expect(sql).toContain('"tenants"."status" <> $');

    results.push([]);
    expect((await call("GET", "/.well-known/did.json?collective=acme")).status).toBe(404);
    sql = lastWhereSql();
    expect(sql).toContain('"tenants"."suspended" = $');
  });
});

// ── 8. TLS ask check ──
describe("tlsCertAllowedForSlug", () => {
  it("only live tenants get certificates", async () => {
    // Not a live public name → refused without looking at tenants
    results.push([]);
    expect(await tlsCertAllowedForSlug("retired-name")).toBe(false);

    results.push([{ tenantId: TENANT }], []);
    expect(await tlsCertAllowedForSlug("gone")).toBe(false);
    const sql = lastWhereSql("tenants");
    expect(sql).toContain('"tenants"."status" <> $');
    expect(sql).toContain('"tenants"."suspended" = $');

    results.push([{ tenantId: TENANT }], [{ id: TENANT }]);
    expect(await tlsCertAllowedForSlug("acme")).toBe(true);
  });
});
