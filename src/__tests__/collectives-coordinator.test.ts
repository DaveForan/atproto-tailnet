/**
 * Sub-collective hierarchy in coordinator mode: detach and eject clear the parent on the
 * coordinator first (restored if the database write fails); list and quota rules.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { AddressInfo } from "node:net";

const h = vi.hoisted(() => ({
  results: [] as unknown[],
  writes: [] as Array<{ op: string; arg: unknown }>,
  wheres: [] as unknown[],
  setParent: vi.fn(async (_parent: string | null) => {}),
  clientFor: [] as unknown[],
  guard: null as null | { tenant: Record<string, unknown>; membership: Record<string, unknown>; role: unknown },
}));

vi.mock("../db/index.js", () => {
  const chain = (op: string): unknown => {
    const proxy: unknown = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === "then") {
          const next = h.results.length ? h.results.shift() : [];
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            (next instanceof Error ? Promise.reject(next) : Promise.resolve(next)).then(res, rej);
        }
        if (prop === "catch") return () => proxy;
        return (...args: unknown[]) => {
          if (prop === "set") h.writes.push({ op, arg: args[0] });
          if (prop === "where") h.wheres.push(args[0]);
          return proxy;
        };
      },
    });
    return proxy;
  };
  return { db: { select: () => chain("select"), update: () => chain("update"), insert: () => chain("insert") }, pool: {} };
});
vi.mock("../audit/log.js", () => ({ logAudit: vi.fn() }));
vi.mock("../orchestrator/control-client.js", () => ({
  useCoordinator: true,
  getCoordinatorClient: (tenant: unknown) => {
    h.clientFor.push(tenant);
    return { setParent: h.setParent };
  },
}));
vi.mock("../orchestrator/tenant-provisioning.js", () => ({ createTenantRecord: vi.fn(), provisionTenantInstance: vi.fn() }));
vi.mock("../routes/helpers.js", async (orig) => ({
  ...(await orig<typeof import("../routes/helpers.js")>()),
  getTenantForUser: vi.fn(async () => h.guard),
}));

import express, { type Request, type Response, type NextFunction } from "express";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { collectivesRouter } from "../routes/collectives.js";

const PARENT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
const child = { id: CHILD, slug: "t-child", parentId: PARENT, coordinatorTenantId: "c-child", status: "running", depth: 1, path: "t-parent.t-child" };
const parent = { id: PARENT, slug: "t-parent", parentId: null, coordinatorTenantId: "c-parent", status: "running", depth: 0, path: "t-parent", maxSubCollectives: 3, maxDevices: 0, maxMembers: 0 };

const app = express();
app.use(express.json());
app.use((req: Request, _res: Response, next: NextFunction) => {
  (req as unknown as { session: unknown }).session = { userId: "u-1", did: "did:plc:x" };
  next();
});
app.use(collectivesRouter);
const server = app.listen(0);
afterAll(() => server.close());

async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

const originatorOf = (tenant: Record<string, unknown>) => ({ tenant, membership: { id: "m", isOriginator: true }, role: null });

beforeEach(() => {
  h.results.length = 0;
  h.writes.length = 0;
  h.wheres.length = 0;
  h.clientFor.length = 0;
  h.setParent.mockReset();
  h.setParent.mockResolvedValue(undefined);
});

describe("detach and eject in coordinator mode", () => {
  it("detach clears the parent on the coordinator, then in the database", async () => {
    h.guard = originatorOf(child);
    h.results.push([{ coordinatorTenantId: "c-parent" }]);
    const r = await call("POST", `/api/tenants/${CHILD}/detach`);
    expect(r.status).toBe(200);
    expect(h.setParent).toHaveBeenCalledWith(null);
    expect(h.clientFor[0]).toMatchObject({ coordinatorTenantId: "c-child" });
    expect(h.writes[0].arg).toMatchObject({ parentId: null, depth: 0 });
  });

  it("a coordinator failure changes nothing", async () => {
    h.guard = originatorOf(child);
    h.results.push([{ coordinatorTenantId: "c-parent" }]);
    h.setParent.mockRejectedValueOnce(new Error("down"));
    const r = await call("POST", `/api/tenants/${CHILD}/detach`);
    expect(r.status).toBe(502);
    expect(h.writes).toHaveLength(0);
  });

  it("a failed database write restores the coordinator parent", async () => {
    h.guard = originatorOf(child);
    h.results.push([{ coordinatorTenantId: "c-parent" }], new Error("db down"));
    const r = await call("POST", `/api/tenants/${CHILD}/detach`);
    expect(r.status).toBe(500);
    expect(h.setParent.mock.calls).toEqual([[null], ["c-parent"]]);
  });

  it("eject clears the child's parent on the coordinator", async () => {
    h.guard = originatorOf(parent);
    h.results.push([child], [{ coordinatorTenantId: "c-parent" }]);
    const r = await call("POST", `/api/tenants/${PARENT}/collectives/${CHILD}/eject`);
    expect(r.status).toBe(200);
    expect(h.setParent).toHaveBeenCalledWith(null);
    expect(h.clientFor[0]).toMatchObject({ coordinatorTenantId: "c-child" });
  });

  it("a child not yet on the coordinator cannot be moved", async () => {
    h.guard = originatorOf(parent);
    h.results.push([{ ...child, coordinatorTenantId: null }]);
    expect((await call("POST", `/api/tenants/${PARENT}/collectives/${CHILD}/eject`)).status).toBe(409);
    expect(h.setParent).not.toHaveBeenCalled();
    expect(h.writes).toHaveLength(0);
  });
});

describe("children list and quotas", () => {
  const dialect = new PgDialect();

  it("listing children needs manage_sub_collectives and hides suspended children", async () => {
    h.guard = { tenant: parent, membership: { id: "m", isOriginator: false }, role: { permissions: [] } };
    expect((await call("GET", `/api/tenants/${PARENT}/collectives`)).status).toBe(403);

    h.guard = { tenant: parent, membership: { id: "m", isOriginator: false }, role: { permissions: ["manage_sub_collectives"] } };
    h.results.push([]);
    expect((await call("GET", `/api/tenants/${PARENT}/collectives`)).status).toBe(200);
    expect(dialect.sqlToQuery(h.wheres.at(-1) as SQL).sql).toContain('"tenants"."suspended" = $');
  });

  it("a child's sub-collective cap cannot exceed a capped parent's", async () => {
    h.guard = originatorOf(parent);
    h.results.push([child]);
    const over = await call("PUT", `/api/tenants/${PARENT}/collectives/${CHILD}/quota`, { maxSubCollectives: 4 });
    expect(over.status).toBe(400);
    h.results.push([child]);
    expect((await call("PUT", `/api/tenants/${PARENT}/collectives/${CHILD}/quota`, { maxSubCollectives: 0 })).status).toBe(400);
    h.results.push([child]);
    expect((await call("PUT", `/api/tenants/${PARENT}/collectives/${CHILD}/quota`, { maxSubCollectives: 2 })).status).toBe(200);
  });
});
