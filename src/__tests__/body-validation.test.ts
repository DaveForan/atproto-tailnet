/** Federation body limit, parseBody, permission helpers and notifyUser limits. */
import { describe, it, expect, vi } from "vitest";
import type { AddressInfo } from "node:net";

const inserted = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("../db/index.js", () => ({
  pool: {},
  db: {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return Promise.resolve();
      },
    }),
  },
}));

import express, { type Request, type Response } from "express";
import { z } from "zod";
import { federationBodyParser } from "../routes/federation-messages.js";
import { MAX_FEDERATION_BODY_BYTES } from "../federation/abuse.js";
import { parseBody } from "../routes/validation.js";
import { effectivePermissions, permissionsSchema, ALL_PERMISSIONS } from "../members/permissions.js";
import { notifyUser } from "../notifications/service.js";

async function serve(app: express.Express, fn: (url: string) => Promise<void>): Promise<void> {
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

describe("federation message body limit", () => {
  // Same mount order as index.ts: the federation parser, then the global one
  const app = express();
  app.use("/api/federation/messages", federationBodyParser);
  app.use(express.json({ limit: "1mb" }));
  app.post("/api/federation/messages/hello", (req: Request, res: Response) => res.json({ size: JSON.stringify(req.body).length }));
  app.post("/api/other", (req: Request, res: Response) => res.json({ size: JSON.stringify(req.body).length }));

  const body = (bytes: number) => JSON.stringify({ pad: "x".repeat(bytes) });

  it("accepts a message under the limit", () =>
    serve(app, async (url) => {
      const r = await fetch(`${url}/api/federation/messages/hello`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body(1000),
      });
      expect(r.status).toBe(200);
    }));

  it("refuses a message over the limit with 413, before the global parser", () =>
    serve(app, async (url) => {
      const big = body(MAX_FEDERATION_BODY_BYTES);
      const r = await fetch(`${url}/api/federation/messages/hello`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: big,
      });
      expect(r.status).toBe(413);
      const other = await fetch(`${url}/api/other`, { method: "POST", headers: { "content-type": "application/json" }, body: big });
      expect(other.status).toBe(200);
    }));
});

describe("parseBody", () => {
  const schema = z.object({ n: z.number().optional() });
  const app = express();
  app.use(express.json());
  app.post("/strict", (req, res) => {
    const parsed = parseBody(schema, req, res);
    if (parsed) res.json(parsed.data);
  });
  app.post("/lenient", (req, res) => {
    const parsed = parseBody(schema, req, res, { emptyAsObject: true });
    if (parsed) res.json(parsed.data);
  });

  it("sends the one 400 body on invalid input", () =>
    serve(app, async (url) => {
      const r = await fetch(`${url}/strict`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"n":"x"}' });
      expect(r.status).toBe(400);
      const json = (await r.json()) as { error: string; details: unknown[] };
      expect(json.error).toBe("Invalid body");
      expect(json.details.length).toBeGreaterThan(0);
    }));

  it("treats a missing body as {} only when asked", () =>
    serve(app, async (url) => {
      expect((await fetch(`${url}/strict`, { method: "POST" })).status).toBe(400);
      expect((await fetch(`${url}/lenient`, { method: "POST" })).status).toBe(200);
    }));
});

describe("permission helpers", () => {
  it("originators hold all, members their known role permissions, tokens narrow both", () => {
    expect(effectivePermissions({ isOriginator: true }, null)).toEqual([...ALL_PERMISSIONS]);
    expect(effectivePermissions({ isOriginator: false }, { permissions: ["invite", "bogus"] })).toEqual(["invite"]);
    expect(effectivePermissions({ isOriginator: true }, null, ["kick"])).toEqual(["kick"]);
    expect(effectivePermissions({ isOriginator: false }, { permissions: ["invite"] }, ["kick"])).toEqual([]);
    expect(effectivePermissions({ isOriginator: false }, null)).toEqual([]);
  });

  it("permissionsSchema accepts only known names", () => {
    expect(permissionsSchema.safeParse(["invite", "kick"]).success).toBe(true);
    expect(permissionsSchema.safeParse(["root"]).success).toBe(false);
  });
});

describe("notifyUser", () => {
  it("truncates like createNotification", async () => {
    notifyUser("t", "u", "friend_request", { title: "t".repeat(300), body: "b".repeat(3000) });
    await Promise.resolve();
    const row = inserted.at(-1)!;
    expect((row.title as string).length).toBe(200);
    expect((row.body as string).length).toBe(2000);
    expect(row).toMatchObject({ type: "friend_request", link: null });
  });
});
