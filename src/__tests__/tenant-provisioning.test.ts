/** createTenantRecord: one transaction per attempt, both callers, provisioning after commit. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  log: [] as string[],
  inserts: [] as Array<{ via: "db" | "tx"; values: Record<string, unknown> }>,
  failNextTenantInsert: null as null | { code: string },
  transactions: 0,
  claimDefaultTailnet: vi.fn(async () => {}),
  createTenant: vi.fn(async () => ({ id: "coord-1" })),
  syncTenantAccess: vi.fn(async () => {}),
}));

vi.mock("../db/index.js", async () => {
  const { getTableName } = await import("drizzle-orm");
  let nextId = 0;
  const executor = (via: "db" | "tx") => ({
    insert: (table: never) => ({
      values: (values: Record<string, unknown>) => {
        const name = getTableName(table);
        h.log.push(`${via}:insert:${name}`);
        h.inserts.push({ via, values: { table: name, ...values } });
        const row = { id: `${name}-${++nextId}`, ...values };
        const fail = name === "tenants" ? h.failNextTenantInsert : null;
        if (fail) h.failNextTenantInsert = null;
        const result = fail ? Promise.reject(fail) : Promise.resolve([row]);
        result.catch(() => {});
        return Object.assign(result, {
          returning: () => result,
          onConflictDoNothing: () => result,
        });
      },
    }),
    update: (table: never) => ({
      set: (set: Record<string, unknown>) => ({
        where: () => {
          h.log.push(`${via}:update:${getTableName(table)}:${JSON.stringify(Object.keys(set))}`);
          const p = Promise.resolve([{ id: "tenants-1", ...set }]);
          return Object.assign(p, { returning: () => p });
        },
      }),
    }),
  });
  return {
    pool: {},
    db: {
      ...executor("db"),
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        h.transactions++;
        h.log.push("begin");
        try {
          const out = await fn(executor("tx"));
          h.log.push("commit");
          return out;
        } catch (err) {
          h.log.push("rollback");
          throw err;
        }
      },
    },
  };
});
vi.mock("../orchestrator/prefix-allocator.js", () => ({
  allocateTenantPrefixes: vi.fn(async () => ({ ipv4Prefix: "100.64.0.0/24", ipv6Prefix: "fd7a::/64" })),
}));
vi.mock("../orchestrator/caddy.js", () => ({ syncTenantRoutes: vi.fn(async () => {}) }));
vi.mock("../orchestrator/control-client.js", () => ({
  getCoordinatorClient: () => ({ createTenant: h.createTenant, setAclPolicyFile: vi.fn(), deleteTenant: vi.fn() }),
}));
vi.mock("../orchestrator/hostnames.js", async (orig) => {
  const real = await orig<typeof import("../orchestrator/hostnames.js")>();
  let n = 0;
  return {
    ...real,
    generateInternalSlug: () => `t-slug${++n}`,
    generateAvailableFriendlyName: vi.fn(async () => `friendly-${n}`),
    hostnameAvailableFor: vi.fn(async () => true),
  };
});
vi.mock("../access/sync.js", () => ({ syncTenantAccess: h.syncTenantAccess }));
vi.mock("../operator/policy.js", () => ({ claimDefaultTailnet: h.claimDefaultTailnet }));

import { createTenantRecord, provisionTenant } from "../orchestrator/tenant-provisioning.js";
import type { users, tenants } from "../db/schema.js";

const user = { id: "u-1", did: "did:plc:owner" } as typeof users.$inferSelect;
const tick = (): Promise<unknown> => new Promise((resolve) => setImmediate(resolve));

beforeEach(async () => {
  await tick();
  h.log.length = 0;
  h.inserts.length = 0;
  h.transactions = 0;
  h.failNextTenantInsert = null;
  h.createTenant.mockReset().mockResolvedValue({ id: "coord-1" });
  h.claimDefaultTailnet.mockClear();
});

describe("provisionTenant", () => {
  it("writes tenant, address, roles, default role and membership in one transaction", async () => {
    await provisionTenant(user, "Dave");
    expect(h.transactions).toBe(1);
    const writes = h.log.slice(h.log.indexOf("begin"), h.log.indexOf("commit") + 1);
    expect(writes).toEqual([
      "begin",
      "tx:insert:tenants",
      "tx:insert:tenant_hostnames",
      "tx:insert:roles",
      "tx:insert:roles",
      'tx:update:tenants:["defaultRoleId","updatedAt"]',
      "tx:insert:memberships",
      "commit",
    ]);
    expect(h.inserts.every((i) => i.via === "tx")).toBe(true);
    const membership = h.inserts.find((i) => i.values.table === "memberships")!.values;
    expect(membership).toMatchObject({ userId: "u-1", isOriginator: true });
    expect(membership).not.toHaveProperty("role");
    const tenant = h.inserts.find((i) => i.values.table === "tenants")!.values;
    expect(tenant).toMatchObject({ name: "Dave's tailnet", ownerUserId: "u-1", accessMode: "member" });
    expect(tenant).not.toHaveProperty("port");
    expect(tenant).not.toHaveProperty("parentId");
    expect(h.claimDefaultTailnet).toHaveBeenCalledWith(expect.stringMatching(/^tenants-/), "did:plc:owner");
  });

  it("provisions the control plane after the commit", async () => {
    await provisionTenant(user, "Dave");
    expect(h.createTenant).not.toHaveBeenCalled();
    await tick();
    expect(h.createTenant).toHaveBeenCalledWith(expect.stringMatching(/^t-slug/), null);
  });

  it("marks the tenant as error when provisioning fails", async () => {
    h.createTenant.mockRejectedValue(new Error("coordinator down"));
    await provisionTenant(user, "Dave");
    await tick();
    await tick();
    expect(h.log.at(-1)).toBe('db:update:tenants:["status","updatedAt"]');
  });

  it("retries the whole transaction with fresh values on a unique violation", async () => {
    h.failNextTenantInsert = { code: "23505" };
    await provisionTenant(user, "Dave");
    expect(h.transactions).toBe(2);
    expect(h.log.filter((l) => l === "rollback")).toHaveLength(1);
    const [first, second] = h.inserts.filter((i) => i.values.table === "tenants").map((i) => i.values.slug);
    expect(first).not.toBe(second);
  });

  it("does not retry other errors", async () => {
    h.failNextTenantInsert = { code: "42P01" };
    await expect(provisionTenant(user, "Dave")).rejects.toEqual({ code: "42P01" });
    expect(h.transactions).toBe(1);
  });
});

describe("createTenantRecord with a parent", () => {
  const parent = {
    id: "p-1",
    path: "t-root",
    depth: 1,
    maxDevices: 20,
    maxMembers: 5,
  } as typeof tenants.$inferSelect;

  it("inherits hierarchy and caps and uses the given slug as address", async () => {
    await createTenantRecord({ ownerUserId: "u-1", name: "Eng", parent, slug: "eng", hostname: "eng" });
    expect(h.transactions).toBe(1);
    const tenant = h.inserts.find((i) => i.values.table === "tenants")!.values;
    expect(tenant).toMatchObject({
      slug: "eng",
      parentId: "p-1",
      path: "t-root.eng",
      depth: 2,
      maxDevices: 20,
      maxMembers: 5,
      maxSubCollectives: 10,
    });
    expect(h.inserts.find((i) => i.values.table === "tenant_hostnames")!.values).toMatchObject({ slug: "eng", isPrimary: true });
    const roleNames = h.inserts.filter((i) => i.values.table === "roles").map((i) => i.values.name);
    expect(roleNames).toEqual(["originator", "citizen"]);
  });
});
