/**
 * Sub-collectives: slug validation of the create route, path rebuilding after
 * detach/eject, and creation through createTenantRecord.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { AddressInfo } from "node:net";

const h = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; slug: string; parentId: string | null; status: string; path: string | null; depth: number }>,
  updates: [] as Array<{ id: unknown; set: Record<string, unknown> }>,
  selectQueue: [] as unknown[][],
  guardTenant: null as Record<string, unknown> | null,
  createTenantRecord: vi.fn(),
  provisionTenantInstance: vi.fn(async () => true),
}));

vi.mock("../db/index.js", async () => {
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();
  const paramsOf = (cond: unknown) => dialect.sqlToQuery(cond as never).params;
  return {
    pool: {},
    db: {
      // rebuildDescendantPaths: children of params[0]; route: queued results
      select: () => ({
        from: () => ({
          where: (cond: unknown) => {
            if (h.selectQueue.length) return Promise.resolve(h.selectQueue.shift());
            const parentId = paramsOf(cond)[0];
            return Promise.resolve(h.rows.filter((r) => r.parentId === parentId && r.status !== "deleted"));
          },
        }),
      }),
      update: () => ({
        set: (set: Record<string, unknown>) => ({
          where: (cond: unknown) => {
            const id = paramsOf(cond)[0];
            h.updates.push({ id, set });
            const row = h.rows.find((r) => r.id === id);
            if (row) Object.assign(row, set);
            return Object.assign(Promise.resolve(), { catch: () => undefined });
          },
        }),
      }),
    },
  };
});
vi.mock("../audit/log.js", () => ({ logAudit: vi.fn() }));
vi.mock("../orchestrator/control-client.js", () => ({ useCoordinator: false }));
vi.mock("../orchestrator/tenant-provisioning.js", () => ({
  createTenantRecord: h.createTenantRecord,
  provisionTenantInstance: h.provisionTenantInstance,
}));
vi.mock("../orchestrator/hostnames.js", async (orig) => ({
  ...(await orig<typeof import("../orchestrator/hostnames.js")>()),
  hostnameAvailableFor: vi.fn(async () => true),
}));
vi.mock("../operator/policy.js", () => ({
  canCreateTailnet: vi.fn(async () => true),
  getInstanceSettings: vi.fn(async () => ({ singleTailnet: false })),
  isOperatorDid: () => true,
  listTopLevelTenants: vi.fn(async () => []),
}));
vi.mock("../routes/helpers.js", async (orig) => ({
  ...(await orig<typeof import("../routes/helpers.js")>()),
  authUserDid: vi.fn(async () => "did:plc:owner"),
  getTenantForUser: vi.fn(async () =>
    h.guardTenant ? { tenant: h.guardTenant, membership: { isOriginator: true }, role: null } : null,
  ),
}));

import express, { type Request, type Response, type NextFunction } from "express";
import { createSubCollectiveBody, collectivesRouter } from "../routes/collectives.js";
import { rebuildDescendantPaths } from "../orchestrator/tenant-hierarchy.js";

describe("sub-collective slug validation", () => {
  const ok = (slug: string) => createSubCollectiveBody.safeParse({ name: "N", slug }).success;

  it("accepts DNS labels", () => {
    expect(ok("acme")).toBe(true);
    expect(ok("my-team")).toBe(true);
    expect(ok("a1")).toBe(true);
    expect(ok("x".repeat(40))).toBe(true);
  });

  it("rejects dots, which separate materialized path segments", () => {
    expect(ok("my.collective")).toBe(false);
  });

  it("rejects characters a DNS label cannot hold", () => {
    for (const s of ["MyTeam", "my_team", "my team", "my@team", "my/team", "-team", "team-"]) {
      expect(ok(s), s).toBe(false);
    }
  });

  it("rejects slugs shorter than 2 or longer than 40 characters", () => {
    expect(ok("a")).toBe(false);
    expect(ok("x".repeat(41))).toBe(false);
  });
});

describe("rebuildDescendantPaths", () => {
  beforeEach(() => {
    h.updates.length = 0;
    h.selectQueue.length = 0;
    h.rows = [
      { id: "root", slug: "acme", parentId: null, status: "running", path: "acme", depth: 0 },
      { id: "eng", slug: "eng", parentId: null, status: "running", path: "eng", depth: 0 },
      { id: "fe", slug: "fe", parentId: "eng", status: "running", path: "acme.eng.fe", depth: 2 },
      { id: "web", slug: "web", parentId: "fe", status: "running", path: "acme.eng.fe.web", depth: 3 },
      { id: "old", slug: "old", parentId: "eng", status: "deleted", path: "acme.eng.old", depth: 2 },
      { id: "sales", slug: "sales", parentId: "root", status: "running", path: "acme.sales", depth: 1 },
    ];
  });

  it("repaths every live descendant under the new root", async () => {
    await rebuildDescendantPaths("eng", "eng", 0);
    const byId = Object.fromEntries(h.rows.map((r) => [r.id, r]));
    expect(byId.fe).toMatchObject({ path: "eng.fe", depth: 1 });
    expect(byId.web).toMatchObject({ path: "eng.fe.web", depth: 2 });
  });

  it("leaves deleted children and other branches alone", async () => {
    await rebuildDescendantPaths("eng", "eng", 0);
    expect(h.updates.map((u) => u.id)).toEqual(["fe", "web"]);
    expect(h.rows.find((r) => r.id === "old")!.path).toBe("acme.eng.old");
    expect(h.rows.find((r) => r.id === "sales")!.path).toBe("acme.sales");
  });
});

describe("POST /api/tenants/:tenantId/collectives", () => {
  const T = "11111111-1111-4111-8111-111111111111";
  const parent = {
    id: T,
    slug: "t-parent",
    path: "t-parent",
    depth: 0,
    suspended: false,
    maxSubCollectives: 0,
    coordinatorTenantId: "coord-parent",
    status: "running",
  };
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: unknown }).session = { userId: "u-1" };
    next();
  });
  app.use(collectivesRouter);
  const server = app.listen(0);
  afterAll(() => server.close());
  const post = (body: unknown) =>
    fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tenants/${T}/collectives`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    h.guardTenant = { ...parent };
    h.selectQueue.length = 0;
    h.createTenantRecord.mockReset();
    h.provisionTenantInstance.mockClear();
  });

  it("creates the record in one call and provisions the control plane after it", async () => {
    h.selectQueue.push([]); // slug not taken
    h.createTenantRecord.mockResolvedValue({
      id: "child-1",
      slug: "eng",
      name: "Engineering",
      port: -5,
      path: "t-parent.eng",
      depth: 1,
      status: "provisioning",
    });
    const r = await post({ name: "Engineering", slug: "eng" });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ id: "child-1", path: "t-parent.eng", depth: 1, parentId: T });
    expect(h.createTenantRecord).toHaveBeenCalledWith({
      ownerUserId: "u-1",
      name: "Engineering",
      parent: expect.objectContaining({ id: T }),
      slug: "eng",
      hostname: "eng",
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.provisionTenantInstance).toHaveBeenCalledWith("child-1", "eng", -5, {
      parentCoordinatorTenantId: "coord-parent",
    });
  });

  it("refuses an invalid slug before creating anything", async () => {
    const r = await post({ name: "Bad", slug: "a.b" });
    expect(r.status).toBe(400);
    expect(h.createTenantRecord).not.toHaveBeenCalled();
  });

  it("refuses a child below the maximum depth", async () => {
    h.guardTenant = { ...parent, depth: 5 };
    const r = await post({ name: "Deep", slug: "deep" });
    expect(r.status).toBe(400);
    expect(h.createTenantRecord).not.toHaveBeenCalled();
  });

  it("answers 500 when the record cannot be created", async () => {
    h.selectQueue.push([]);
    h.createTenantRecord.mockRejectedValue(new Error("db down"));
    const r = await post({ name: "Engineering", slug: "eng" });
    expect(r.status).toBe(500);
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.provisionTenantInstance).not.toHaveBeenCalled();
  });
});
