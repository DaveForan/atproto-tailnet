/**
 * Security fixes on sensitive routes:
 * - ADR-0035 step-up on every sensitive route, before the tenant guard;
 * - GET /api/tenants for an agent token lists only its own tailnet and never
 *   the coordinator's internal tenant id;
 * - constant-time CSRF token check.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { AddressInfo } from "node:net";

const { results, wheres } = vi.hoisted(() => ({ results: [] as unknown[], wheres: [] as unknown[] }));

vi.mock("../db/index.js", () => {
  const chain = (): unknown => {
    const proxy: unknown = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === "then") {
          const next = results.length ? results.shift() : [];
          return (res: (v: unknown) => unknown) => Promise.resolve(next).then(res);
        }
        return (...args: unknown[]) => {
          if (prop === "where") wheres.push(args[0]);
          return proxy;
        };
      },
    });
    return proxy;
  };
  return { db: { select: () => chain(), insert: () => chain(), update: () => chain(), delete: () => chain() }, pool: {} };
});
vi.mock("../audit/log.js", () => ({ logAudit: vi.fn() }));
vi.mock("../orchestrator/headscale.js", () => ({
  startInstance: vi.fn(),
  stopInstance: vi.fn(),
  destroyInstance: vi.fn(),
  adoptInstance: vi.fn(),
  createInstance: vi.fn(),
}));
vi.mock("../orchestrator/caddy.js", () => ({ syncTenantRoutes: vi.fn(async () => {}) }));
vi.mock("../auth/atproto.js", () => ({
  getOAuthClient: async () => ({}),
  getClientMetadata: () => ({}),
  getPublicJwks: async () => ({}),
}));
vi.mock("../orchestrator/hostnames.js", async (orig) => ({
  ...(await orig<typeof import("../orchestrator/hostnames.js")>()),
  liveHostnamesByTenant: vi.fn(async () => new Map()),
}));

import express, { type Router, type Request, type Response, type NextFunction } from "express";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { stepUpForSession } from "../auth/step-up.js";
import { apiRouter } from "../routes/api.js";
import { devicesRouter } from "../routes/devices.js";
import { securityRouter } from "../routes/security.js";
import { aclRouter } from "../routes/acl.js";
import { derpRouter } from "../routes/derp.js";
import { deviceSignInRouter } from "../routes/device-signin.js";
import { agentsRouter } from "../routes/agents.js";
import { hostnamesRouter } from "../routes/hostnames.js";
import { sharingRouter } from "../routes/sharing.js";
import { csrfTokenMatches } from "../routes/helpers.js";

type Layer = {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> };
  /** A mounted sub-router (`router.use(subRouter)`) carries its own stack. */
  handle?: { stack?: Layer[] };
};

/** The route layer for `method path`, searching mounted sub-routers too. */
function findRoute(stack: Layer[], method: string, path: string): Layer | undefined {
  for (const l of stack) {
    if (l.route?.path === path && l.route.methods[method]) return l;
    const nested = l.handle?.stack ? findRoute(l.handle.stack, method, path) : undefined;
    if (nested) return nested;
  }
  return undefined;
}

/** Handlers in the order the route runs them. */
function chain(router: Router, method: string, path: string): unknown[] {
  const layer = findRoute(router.stack as unknown as Layer[], method, path);
  if (!layer?.route) throw new Error(`route not found: ${method} ${path}`);
  return layer.route.stack.map((l) => l.handle);
}

/** True when `method path` on the router runs `stepUpForSession` before its handler. */
function hasStepUp(router: Router, method: string, path: string): boolean {
  return chain(router, method, path).includes(stepUpForSession);
}

/** Index of the tenantGuard middleware in the chain, or -1. */
function guardIndex(handles: unknown[]): number {
  return handles.findIndex((h) => (h as { name?: string }).name === "tenantGuardMiddleware");
}

describe("step-up on sensitive routes (ADR-0035)", () => {
  const tenantRoutes = [
    [devicesRouter, "post", "/api/tenants/:tenantId/devices/auth-key"],
    [securityRouter, "post", "/api/tenants/:tenantId/roles"],
    [securityRouter, "patch", "/api/tenants/:tenantId/roles/:roleId"],
    [securityRouter, "delete", "/api/tenants/:tenantId/roles/:roleId"],
    [securityRouter, "put", "/api/tenants/:tenantId/members/:userId/role"],
    [securityRouter, "patch", "/api/tenants/:tenantId/default-role"],
    [securityRouter, "post", "/api/tenants/:tenantId/device-locks"],
    [securityRouter, "delete", "/api/tenants/:tenantId/device-locks"],
    [securityRouter, "post", "/api/tenants/:tenantId/device-approvals/:approvalId/approve"],
    [aclRouter, "put", "/api/tenants/:tenantId/acl"],
    [derpRouter, "put", "/api/tenants/:tenantId/derp"],
    [apiRouter, "delete", "/api/tenants/:id"],
    [agentsRouter, "post", "/api/tenants/:tenantId/agent-tokens"],
    [hostnamesRouter, "put", "/api/tenants/:tenantId/hostnames/primary"],
    [hostnamesRouter, "delete", "/api/tenants/:tenantId/hostnames/:name"],
    [sharingRouter, "post", "/api/tenants/:tenantId/shares"],
    [sharingRouter, "post", "/api/tenants/:tenantId/shares/:shareId/accept"],
  ] as const;

  it.each([...tenantRoutes, [deviceSignInRouter, "post", "/api/device-auth/:id/approve"]] as const)(
    "%#: %s %s needs a fresh device proof",
    (router, method, path) => {
      expect(hasStepUp(router as unknown as Router, method, path)).toBe(true);
    },
  );

  it.each(tenantRoutes)("%#: %s %s runs step-up before tenantGuard", (router, method, path) => {
    const handles = chain(router as unknown as Router, method, path);
    const guard = guardIndex(handles);
    expect(guard).toBeGreaterThan(-1);
    expect(handles.indexOf(stepUpForSession)).toBeLessThan(guard);
  });

  it("reads stay without step-up", () => {
    expect(hasStepUp(aclRouter, "get", "/api/tenants/:tenantId/acl")).toBe(false);
    expect(hasStepUp(deviceSignInRouter, "get", "/api/device-auth/:id")).toBe(false);
  });

  it("a trusted-device session with an old proof is refused before the handler runs", async () => {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { session: unknown }).session = {
        userId: "u-1",
        trustedDeviceId: "dev-1",
        deviceVerifiedAt: Date.now() - 60 * 60_000,
      };
      next();
    });
    app.use(aclRouter);
    const server = app.listen(0);
    try {
      const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tenants/${T}/acl`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(r.status).toBe(403);
      expect(((await r.json()) as { code: string }).code).toBe("step_up_required");
    } finally {
      server.close();
    }
  });
});

const T = "11111111-1111-4111-8111-111111111111";
const dialect = new PgDialect();

describe("GET /api/tenants", () => {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: unknown }).session = req.headers["x-agent"] ? {} : { userId: "u-1" };
    if (req.headers["x-agent"]) {
      (req as unknown as { agentToken: unknown }).agentToken = { id: "a", tenantId: T, userId: "u-1", permissions: [] };
    }
    next();
  });
  app.use(apiRouter);
  const server = app.listen(0);
  afterAll(() => server.close());
  const get = async (headers: Record<string, string> = {}) => {
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tenants`, { headers });
    return (await r.json()) as Array<Record<string, unknown>>;
  };
  const rows = [{ id: T, slug: "t-a", name: "A", status: "running", suspended: false, isOriginator: true, roleName: null, coordinatorTenantId: "c-a" }];

  beforeEach(() => {
    results.length = 0;
    wheres.length = 0;
  });

  it("an agent token is limited to its own tailnet and never sees the coordinator id", async () => {
    results.push(rows);
    const list = await get({ "x-agent": "1" });
    const where = dialect.sqlToQuery(wheres[0] as SQL);
    expect(where.sql).toContain('"tenants"."id" = $');
    expect(where.params).toContain(T);
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("coordinatorTenantId");
  });

  it("a dashboard session sees all its tailnets with the coordinator id", async () => {
    results.push(rows);
    const list = await get();
    expect(dialect.sqlToQuery(wheres[0] as SQL).sql).not.toContain('"tenants"."id"');
    expect(list[0].coordinatorTenantId).toBe("c-a");
  });
});

describe("sensitive settings", () => {
  const tenantRow = { id: T, slug: "t-a", lockdownMode: false, lastActivityAt: new Date(), requireDeviceApproval: false };
  const guardRow = (perms: string[]) => [{ tenant: tenantRow, membership: { id: "m", isOriginator: false }, role: { permissions: perms } }];
  let ctx: { session: Record<string, unknown>; agent?: Record<string, unknown> } = { session: {} };
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: unknown }).session = ctx.session;
    if (ctx.agent) (req as unknown as { agentToken: unknown }).agentToken = ctx.agent;
    next();
  });
  app.use(securityRouter);
  const server = app.listen(0);
  afterAll(() => server.close());
  const patch = async (body: Record<string, unknown>) => {
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tenants/${T}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };

  beforeEach(() => {
    results.length = 0;
  });

  it.each([
    { lockdownMode: false },
    { allowAgentTokens: true },
    { allowMemberAgentTokens: true },
    { notificationWebhookUrl: "https://hooks.example.com/x" },
    { notificationWebhookSecret: "s" },
    { requireDeviceApproval: false },
    { allowJoinRequests: true },
  ])("an agent token with manage_settings cannot change %j", async (body) => {
    ctx = { session: {}, agent: { id: "a", tenantId: T, userId: "u-1", permissions: ["manage_settings"] } };
    results.push(guardRow(["manage_settings"]));
    const r = await patch(body);
    expect(r.status).toBe(403);
    expect(r.json.error).toMatch(/Agent tokens/);
  });

  it("an agent token can still change plain settings", async () => {
    ctx = { session: {}, agent: { id: "a", tenantId: T, userId: "u-1", permissions: ["manage_settings"] } };
    results.push(guardRow(["manage_settings"]), [], [tenantRow]);
    expect((await patch({ boardEnabled: true, hibernateAfterDays: 3 })).status).toBe(200);
  });

  it("a trusted-device session needs step-up for security settings only", async () => {
    ctx = { session: { userId: "u-1", trustedDeviceId: "dev-1", deviceVerifiedAt: Date.now() - 60 * 60_000 } };
    results.push(guardRow(["manage_settings"]));
    expect((await patch({ allowJoinRequests: true })).json.code).toBe("step_up_required");
    results.push(guardRow(["manage_settings"]), [], [tenantRow]);
    expect((await patch({ boardEnabled: true })).status).toBe(200);
  });
});

describe("CSRF token check", () => {
  it("matches only the exact token, in constant time", () => {
    expect(csrfTokenMatches("abc123", "abc123")).toBe(true);
    expect(csrfTokenMatches("abc124", "abc123")).toBe(false);
    expect(csrfTokenMatches("abc", "abc123")).toBe(false);
    expect(csrfTokenMatches(undefined, "abc123")).toBe(false);
    expect(csrfTokenMatches(["abc123"], "abc123")).toBe(false);
    expect(csrfTokenMatches("", undefined)).toBe(false);
  });
});
