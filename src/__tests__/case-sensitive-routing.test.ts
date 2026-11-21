/**
 * Path-prefix middlewares (CSRF, enrolment gate, agent scope) must not be skipped by
 * spelling a route in another case, and routers must not match other spellings.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import type { AddressInfo } from "node:net";

vi.mock("../db/index.js", () => ({ db: {}, pool: {} }));

import express, { Router, type Request, type Response, type NextFunction } from "express";
import { csrfProtection, enforceAgentScope } from "../auth/middleware.js";
import { enforceDeviceEnrollment } from "../auth/session.js";

const T = "11111111-1111-4111-8111-111111111111";

function appWith(session: Record<string, unknown>, agentToken?: Record<string, unknown>) {
  const app = express();
  app.set("case sensitive routing", true);
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: unknown }).session = session;
    if (agentToken) (req as unknown as { agentToken: unknown }).agentToken = agentToken;
    next();
  });
  app.use(enforceDeviceEnrollment);
  app.use(csrfProtection);
  app.use(enforceAgentScope);
  const router = Router({ caseSensitive: true });
  router.post("/api/tenants/:tenantId/settings", (_req, res) => {
    res.json({ reached: true });
  });
  router.get("/api/tenants/:tenantId/devices", (_req, res) => {
    res.json({ reached: true });
  });
  app.use(router);
  return app;
}

const servers: Array<ReturnType<ReturnType<typeof express>["listen"]>> = [];
afterAll(() => servers.forEach((s) => s.close()));

async function call(app: ReturnType<typeof express>, method: string, path: string, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  servers.push(server);
  const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: method === "GET" ? undefined : "{}",
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

describe("case-insensitive path bypass", () => {
  it("CSRF applies to /API/... and the uppercase route is not served", async () => {
    const app = appWith({ userId: "u", csrfToken: "tok" });
    for (const path of [`/API/tenants/${T}/settings`, `/Api/tenants/${T}/settings`]) {
      const r = await call(app, "POST", path);
      expect(r.status).toBe(403);
      expect(r.json.error).toMatch(/CSRF/);
    }
    // With the token, the other spelling still finds no route
    expect((await call(app, "POST", `/API/tenants/${T}/settings`, { "x-csrf-token": "tok" })).status).toBe(404);
    expect((await call(app, "POST", `/api/tenants/${T}/settings`, { "x-csrf-token": "tok" })).json.reached).toBe(true);
  });

  it("the enrolment gate applies to /API/...", async () => {
    const app = appWith({ userId: "u", mustEnrollDevice: true });
    const r = await call(app, "GET", `/API/tenants/${T}/devices`);
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("enroll_required");
  });

  it("agent scope compares the tenant id and the allow-list case-insensitively", async () => {
    const token = { id: "a", tenantId: T, userId: "u", permissions: [] };
    const other = "22222222-2222-4222-8222-222222222222";
    const app = appWith({}, token);
    expect((await call(app, "GET", `/API/TENANTS/${other.toUpperCase()}/devices`)).status).toBe(403);
    expect((await call(app, "GET", `/api/tenants/${T.toUpperCase()}/devices`)).json.reached).toBe(true);
    expect((await call(app, "GET", "/API/operator/overview")).status).toBe(403);
  });

  it("every router in src is created case-sensitive", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (name === "__tests__" || name === "client") continue;
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/.test(name) && /\bRouter\(\s*\)/.test(readFileSync(p, "utf8"))) offenders.push(p);
      }
    };
    walk(join(import.meta.dirname, ".."));
    expect(offenders).toEqual([]);
  });
});
