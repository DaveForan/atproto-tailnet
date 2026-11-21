/**
 * /auth/login takes a user-chosen handle, DID or PDS URL: every OAuth lookup must go through
 * the SSRF-safe fetch, and the query must be single strings.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import type { AddressInfo } from "node:net";

const h = vi.hoisted(() => {
  // A production (non-loopback) deployment
  process.env.PUBLIC_URL = "https://tailnet.example.com";
  process.env.SESSION_SECRET = "a-strong-session-secret-for-tests-0123456789";
  process.env.ATPROTO_PRIVATE_KEY = "{}";
  return { ctorOpts: [] as Array<Record<string, unknown>>, authorize: vi.fn(async () => new URL("https://pds.example.com/authorize")) };
});

vi.mock("../db/index.js", () => ({ db: {}, pool: {} }));
vi.mock("@atproto/jwk-jose", () => ({ JoseKey: { fromImportable: vi.fn(async () => ({})) } }));
vi.mock("@atproto/oauth-client-node", () => ({
  NodeOAuthClient: class {
    authorize = h.authorize;
    constructor(opts: Record<string, unknown>) {
      h.ctorOpts.push(opts);
    }
  },
}));

import express, { type Request as ExpressRequest, type Response as ExpressResponse, type NextFunction } from "express";
import { createOAuthFetch, getOAuthClient, type OAuthFetch } from "../auth/atproto.js";
import { authRouter } from "../routes/auth.js";

type FetchInput = Parameters<OAuthFetch>[0];

function recordingBase() {
  const calls: Request[] = [];
  const base = vi.fn(async (input: FetchInput, init?: RequestInit) => {
    calls.push(input instanceof Request ? input : new Request(input, init));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
  return { base: base as unknown as OAuthFetch, calls, mock: base };
}

describe("OAuth client fetch", () => {
  it("the production client is built with the SSRF-safe fetch", async () => {
    await getOAuthClient();
    expect(h.ctorOpts).toHaveLength(1);
    const fetch = h.ctorOpts[0].fetch as OAuthFetch;
    expect(typeof fetch).toBe("function");
    await expect(fetch("https://127.0.0.1/.well-known/oauth-protected-resource")).rejects.toThrow();
    await expect(fetch("https://10.0.0.1/xrpc")).rejects.toThrow();
  });

  it.each([
    "https://127.0.0.1/",
    "https://10.1.2.3/",
    "https://169.254.169.254/latest/meta-data",
    "https://100.64.0.1/",
    "https://[::1]/",
    "https://[fd00::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://[2002:7f00:1::]/",
    "http://pds.example.com/",
  ])("refuses %s before any request", async (url) => {
    const { base, mock } = recordingBase();
    await expect(createOAuthFetch(false, base)(url)).rejects.toThrow();
    expect(mock).not.toHaveBeenCalled();
  });

  it("refuses local names at connect time (real fetch, no request leaves the host)", async () => {
    const fetch = createOAuthFetch(false);
    for (const url of ["https://localhost/.well-known/did.json", "https://pds.internal.local/xrpc"]) {
      const err = (await fetch(url).catch((e: unknown) => e)) as { cause?: { message?: string } };
      expect(err.cause?.message).toMatch(/not a public domain/);
    }
  });

  it("never follows redirects: an implicit follow becomes error, manual stays manual", async () => {
    const { base, calls } = recordingBase();
    const fetch = createOAuthFetch(false, base);
    await fetch("https://93.184.216.34/oauth/token", { method: "POST", body: "x" });
    await fetch(new Request("https://93.184.216.34/.well-known/oauth-protected-resource", { redirect: "manual" }));
    expect(calls.map((r) => r.redirect)).toEqual(["error", "manual"]);
  });

  it("a loopback deployment may reach local servers (development PDS)", async () => {
    const { base, mock } = recordingBase();
    await createOAuthFetch(true, base)("http://127.0.0.1:2583/xrpc/com.atproto.server.describeServer");
    expect(mock).toHaveBeenCalledOnce();
  });
});

describe("/auth/login query", () => {
  const app = express();
  app.use((req: ExpressRequest, _res: ExpressResponse, next: NextFunction) => {
    (req as unknown as { session: unknown }).session = { save: (cb: (e?: unknown) => void) => cb() };
    next();
  });
  app.use(authRouter);
  const server = app.listen(0);
  afterAll(() => server.close());
  const get = async (qs: string) =>
    (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/login?${qs}`, { redirect: "manual" })).status;

  it("refuses repeated (array) handle or redirect parameters before resolving anything", async () => {
    h.authorize.mockClear();
    expect(await get("handle=a.bsky.social&handle=b.bsky.social")).toBe(400);
    expect(await get("handle=a.bsky.social&redirect=/x&redirect=/y")).toBe(400);
    expect(await get("")).toBe(400);
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it("a single handle starts the flow", async () => {
    expect(await get("handle=alice.bsky.social&redirect=/invite/abc")).toBe(302);
    expect(h.authorize).toHaveBeenCalledWith("alice.bsky.social", expect.objectContaining({ scope: "atproto" }));
  });
});
