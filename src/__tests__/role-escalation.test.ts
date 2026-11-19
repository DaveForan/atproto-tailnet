/**
 * Role escalation through the default role: a member with manage_roles must
 * not be able to (a) make a broader role the default, or (b) delete a role so
 * its holders — possibly themselves — fall onto a broader default role.
 *
 * DB is a chainable mock (same pattern as operator.test.ts): each awaited
 * query resolves to the next entry of `results`; writes are recorded.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { AddressInfo } from "node:net";

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
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(next).then(res, rej);
        }
        if (prop === "catch") return () => proxy;
        return (...args: unknown[]) => {
          if (prop === "from") tbl = tableName(args[0]);
          if (prop === "set" || prop === "values") writes.push({ op, table: tbl, method: String(prop), arg: args[0] });
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
    insert: (t: unknown) => chain("insert", tableName(t)),
    update: (t: unknown) => chain("update", tableName(t)),
    delete: (t: unknown) => chain("delete", tableName(t)),
  },
  pool: {},
}));

import express from "express";
import type { Request, Response, NextFunction } from "express";
import { securityRouter } from "../routes/security.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const tenant = { id: TENANT, defaultRoleId: "44444444-4444-4444-8444-444444444444", lastActivityAt: new Date(), lockdownMode: false };
const managerRole = { id: "22222222-2222-4222-8222-222222222222", tenantId: TENANT, name: "Role manager", isSystem: false, permissions: ["manage_roles", "invite"] };
const adminRole = { id: "33333333-3333-4333-8333-333333333333", tenantId: TENANT, name: "Admin", isSystem: false, permissions: ["manage_roles", "invite", "kick", "manage_settings", "manage_acl"] };
const citizenRole = { id: "44444444-4444-4444-8444-444444444444", tenantId: TENANT, name: "citizen", isSystem: true, permissions: ["invite"] };
const membership = { id: "m-1", userId: "u-mallory", tenantId: TENANT, roleId: "22222222-2222-4222-8222-222222222222", isOriginator: false };
const tenantForUser = () => [{ tenant, membership, role: managerRole }];

const app = express();
app.use(express.json());
app.use((req: Request, _res: Response, next: NextFunction) => {
  (req as unknown as { session: Record<string, unknown> }).session = { userId: "u-mallory", did: "did:plc:mallory" };
  next();
});
app.use(securityRouter);
const server = app.listen(0);
afterAll(() => server.close());

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> };
}

beforeEach(() => {
  results.length = 0;
  writes.length = 0;
});

describe("PATCH default-role", () => {
  it("refuses to make a role with permissions the caller lacks the default", async () => {
    results.push(tenantForUser(), [adminRole]);
    const r = await call("PATCH", `/api/tenants/${TENANT}/default-role`, { roleId: adminRole.id });
    expect(r.status).toBe(403);
    expect(r.json.permissions).toEqual(["kick", "manage_settings", "manage_acl"]);
    expect(writes.some((w) => w.table === "tenants")).toBe(false);
  });

  it("allows a default role within the caller's own permissions", async () => {
    results.push(tenantForUser(), [citizenRole]);
    const r = await call("PATCH", `/api/tenants/${TENANT}/default-role`, { roleId: citizenRole.id });
    expect(r.status).toBe(200);
  });
});

describe("DELETE role", () => {
  it("refuses when holders would fall onto a default role broader than the caller", async () => {
    const broadDefaultTenant = { ...tenant, defaultRoleId: adminRole.id };
    results.push(tenantForUser(), [managerRole], [broadDefaultTenant], [adminRole]);
    const r = await call("DELETE", `/api/tenants/${TENANT}/roles/${managerRole.id}`);
    expect(r.status).toBe(403);
    expect(writes.some((w) => w.table === "memberships")).toBe(false);
  });

  it("allows deleting when the default role is within the caller's permissions", async () => {
    results.push(tenantForUser(), [managerRole], [tenant], [citizenRole]);
    const r = await call("DELETE", `/api/tenants/${TENANT}/roles/${managerRole.id}`);
    expect(r.status).toBe(200);
  });
});
