/**
 * Tailnet public addresses: validation, availability, primary changes, Caddy aliases and the API.
 * The DB is a chainable mock: each awaited query resolves to the next `results` entry.
 * `.set()/.values()` payloads and deletes are recorded in `writes`.
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
    if (op === "delete") writes.push({ op, table: tbl, method: "delete", arg: null });
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

vi.mock("../db/index.js", () => {
  const db = {
    select: () => chain("select"),
    insert: (t: unknown) => chain("insert", tableName(t)),
    update: (t: unknown) => chain("update", tableName(t)),
    delete: (t: unknown) => chain("delete", tableName(t)),
    transaction: async (cb: (tx: unknown) => unknown) => cb(db),
  };
  return { db, pool: {} };
});
const { syncTenantRoutes } = vi.hoisted(() => ({ syncTenantRoutes: vi.fn(async () => {}) }));
vi.mock("../orchestrator/caddy.js", async (orig) => ({
  ...(await orig<typeof import("../orchestrator/caddy.js")>()),
  syncTenantRoutes,
}));

import express from "express";
import type { Request, Response, NextFunction } from "express";
import {
  validateHostname,
  hostnameAvailableFor,
  setPrimaryHostname,
  RETIRED_QUARANTINE_MS,
  MAX_LIVE_HOSTNAMES,
  generateInternalSlug,
  generateFriendlyName,
  tenantIdForPublicLink,
} from "../orchestrator/hostnames.js";
import { buildTenantRouter } from "../orchestrator/caddy.js";
import { hostnamesRouter } from "../routes/hostnames.js";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-11-20T00:00:00Z");

beforeEach(() => {
  results.length = 0;
  writes.length = 0;
  vi.clearAllMocks();
});

describe("validateHostname", () => {
  it.each(["dave", "my-tailnet", "a", "x1", "a".repeat(63), "DAVE "])("accepts %s", (n) => {
    expect(validateHostname(n).ok).toBe(true);
  });
  it.each(["", "-dave", "dave-", "da--ve", "da.ve", "da_ve", "a".repeat(64), "dävé", 42])("rejects %s", (n) => {
    expect(validateHostname(n)).toEqual({ ok: false, error: "invalid" });
  });
  it.each(["www", "api", "admin", "derp", "login"])("reserves %s", (n) => {
    expect(validateHostname(n)).toEqual({ ok: false, error: "reserved" });
  });
  it("normalises case and whitespace", () => {
    expect(validateHostname("  MyNet ")).toEqual({ ok: true, name: "mynet" });
  });
});

describe("hostnameAvailableFor", () => {
  it("free name", async () => {
    results.push([], []);
    expect(await hostnameAvailableFor("free", T1, NOW)).toBe(true);
  });
  it("live name of another tailnet is taken", async () => {
    results.push([{ tenantId: T2, retiredAt: null }]);
    expect(await hostnameAvailableFor("theirs", T1, NOW)).toBe(false);
  });
  it("another tailnet's recently retired name stays reserved", async () => {
    results.push([{ tenantId: T2, retiredAt: new Date(NOW.getTime() - RETIRED_QUARANTINE_MS + 1000) }]);
    expect(await hostnameAvailableFor("old", T1, NOW)).toBe(false);
  });
  it("is released after the quarantine", async () => {
    results.push([{ tenantId: T2, retiredAt: new Date(NOW.getTime() - RETIRED_QUARANTINE_MS - 1000) }], []);
    expect(await hostnameAvailableFor("old", T1, NOW)).toBe(true);
  });
  it("another tailnet's internal slug is taken", async () => {
    results.push([], [{ id: T2 }]);
    expect(await hostnameAvailableFor("internal", T1, NOW)).toBe(false);
  });
  it("a tailnet may re-claim its own names", async () => {
    results.push([{ tenantId: T1, retiredAt: NOW }], [{ id: T1 }]);
    expect(await hostnameAvailableFor("mine", T1, NOW)).toBe(true);
  });
});

describe("setPrimaryHostname", () => {
  const own = (n: Array<{ slug: string; isPrimary: boolean; retiredAt?: Date | null }>) =>
    n.map((h) => ({ tenantId: T1, createdAt: NOW, retiredAt: null, ...h }));

  it("refuses invalid names without touching the DB", async () => {
    expect(await setPrimaryHostname(T1, "bad name", NOW)).toEqual({ ok: false, error: "invalid" });
    expect(writes).toHaveLength(0);
  });

  it("refuses a name another tailnet holds", async () => {
    results.push(own([{ slug: "dave", isPrimary: true }]), [{ tenantId: T2, retiredAt: null }]);
    expect(await setPrimaryHostname(T1, "taken", NOW)).toEqual({ ok: false, error: "taken" });
    expect(writes.some((w) => w.op === "update" || w.op === "insert")).toBe(false);
  });

  it("caps live names", async () => {
    const many = Array.from({ length: MAX_LIVE_HOSTNAMES }, (_, i) => ({ slug: `n${i}`, isPrimary: i === 0 }));
    results.push(own(many), [], []);
    expect(await setPrimaryHostname(T1, "one-more", NOW)).toEqual({ ok: false, error: "too_many" });
  });

  it("new name: demotes the old primary (kept as alias) and inserts the new primary", async () => {
    results.push(own([{ slug: "daveforan-bsky-social", isPrimary: true }]), [], []);
    expect(await setPrimaryHostname(T1, "dave", NOW)).toEqual({ ok: true, name: "dave" });
    const demote = writes.find((w) => w.op === "update" && w.table === "tenant_hostnames");
    expect(demote?.arg).toEqual({ isPrimary: false });
    const insert = writes.find((w) => w.op === "insert" && w.table === "tenant_hostnames");
    expect(insert?.arg).toEqual({ slug: "dave", tenantId: T1, isPrimary: true });
  });

  it("re-activating its own alias needs no availability check", async () => {
    results.push(own([{ slug: "new", isPrimary: true }, { slug: "old", isPrimary: false }]));
    expect(await setPrimaryHostname(T1, "old", NOW)).toEqual({ ok: true, name: "old" });
    expect(writes.filter((w) => w.op === "update")).toHaveLength(2);
    expect(writes.some((w) => w.op === "insert")).toBe(false);
  });
});

describe("Caddy routing", () => {
  it("routes every live name and tells the coordinator the internal slug", () => {
    const route = buildTenantRouter(
      [{ slug: "daveforan-bsky-social", port: -1, hostnames: ["dave", "daveforan-bsky-social"] }],
      { baseDomain: "ts.example.com", coordinator: true, network: undefined },
    ) as unknown as { handle: Array<{ routes: Array<Record<string, any>> }> };
    const tenantRoute = route.handle[0].routes[0];
    expect(tenantRoute.match[0].host).toEqual(["dave.ts.example.com", "daveforan-bsky-social.ts.example.com"]);
    expect(tenantRoute.handle[0].headers.request.set["X-Tenant-Slug"]).toEqual(["daveforan-bsky-social"]);
  });
});

describe("hostnames API", () => {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: Record<string, unknown> }).session = { userId: "u-1", did: "did:plc:x" };
    if (req.headers["x-agent"]) (req as unknown as { agentToken: unknown }).agentToken = { id: "a", tenantId: T1, userId: "u-1", permissions: [] };
    next();
  });
  app.use(hostnamesRouter);
  const server = app.listen(0);
  afterAll(() => server.close());
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
  const member = (isOriginator: boolean) => [
    { tenant: { id: T1, slug: "daveforan-bsky-social", lastActivityAt: new Date() }, membership: { isOriginator }, role: null },
  ];

  it("only the originator may change the address", async () => {
    results.push(member(false));
    expect((await call("PUT", `/api/tenants/${T1}/hostnames/primary`, { name: "dave" })).status).toBe(403);
  });

  it("agent tokens may not change the address", async () => {
    results.push(member(true));
    expect((await call("PUT", `/api/tenants/${T1}/hostnames/primary`, { name: "dave" }, { "x-agent": "1" })).status).toBe(403);
  });

  it("maps refusals to status codes", async () => {
    results.push(member(true));
    const r = await call("PUT", `/api/tenants/${T1}/hostnames/primary`, { name: "www" });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("reserved");
  });

  it("re-syncs Caddy after a change", async () => {
    results.push(member(true), [{ slug: "daveforan-bsky-social", isPrimary: true, retiredAt: null, tenantId: T1 }], [], []);
    const r = await call("PUT", `/api/tenants/${T1}/hostnames/primary`, { name: "dave" });
    expect(r.status).toBe(200);
    expect(syncTenantRoutes).toHaveBeenCalled();
  });

  it("refuses to retire the primary", async () => {
    results.push(member(true), []);
    expect((await call("DELETE", `/api/tenants/${T1}/hostnames/dave`)).status).toBe(404);
  });
});

describe("generated names", () => {
  it("internal ids are opaque, valid and never handle-like", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = generateInternalSlug();
      expect(id).toMatch(/^t-[a-z2-9]{10}$/);
      expect(validateHostname(id).ok).toBe(true);
      seen.add(id);
    }
    expect(seen.size).toBe(200);
  });

  it("friendly public names are valid DNS labels and not reserved", () => {
    for (let i = 0; i < 200; i++) {
      const n = generateFriendlyName();
      expect(n).toMatch(/^[a-z]+-[a-z]+-\d{4}$/);
      expect(validateHostname(n)).toEqual({ ok: true, name: n });
    }
  });
});

describe("public links", () => {
  it("resolve live public names only — never the internal slug", async () => {
    results.push([]); // not a live hostname
    expect(await tenantIdForPublicLink("daveforan-bsky-social")).toBeNull();
    expect(results).toHaveLength(0);
  });
});
