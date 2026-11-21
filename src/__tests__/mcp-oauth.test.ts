/** MCP OAuth and /mcp against a real Express app on an ephemeral port, with MemoryOAuthStore. */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import session from "express-session";
import type { Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

vi.mock("../oauth/index.js", async () => {
  const { MemoryOAuthStore } = await import("../oauth/memory-store.js");
  const { TailnetOAuthProvider } = await import("../oauth/provider.js");
  const tokens = await import("../oauth/tokens.js");
  const MCP_RESOURCE_URL = "http://localhost:3000/mcp";
  const oauthProvider = new TailnetOAuthProvider({
    store: new MemoryOAuthStore(),
    resourceUrl: MCP_RESOURCE_URL,
    isOperatorDid: (did: string) => did === "did:plc:alice",
  });
  return { MCP_RESOURCE_URL, oauthProvider, ...tokens };
});

import { oauthProvider, MCP_RESOURCE_URL } from "../oauth/index.js";
import type { MemoryOAuthStore } from "../oauth/memory-store.js";
import { createOAuthRouter, protectedResourceMetadataUrl } from "../oauth/router.js";
import { validateRedirectUri } from "../oauth/provider.js";
import { hashToken } from "../oauth/tokens.js";
import { createMcpRouter } from "../mcp/server.js";
import { ApiError, HttpApiClient, assertSamePath, type ApiClient } from "../mcp/api-client.js";
import { TOOL_DEFS, seg } from "../mcp/tools.js";
import { INTERNAL_MCP_HEADER, INTERNAL_MCP_SECRET, isInternalMcpCall } from "../mcp/internal.js";
import { createMcpConnectionsRouter } from "../routes/mcp-connections.js";
import { resolveAgentToken, enforceAgentScope, requireAuth, authUserId } from "../routes/helpers.js";

const PUBLIC_URL = "http://localhost:3000";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const store = oauthProvider.store as MemoryOAuthStore;

let server: Server;
let base = "";
let operatorMode = false;
const apiCalls: Array<{ method: string; path: string; body?: unknown; token: string }> = [];

/** Mocked in-process API used by the /mcp tools. */
function mockApi(token: string): ApiClient {
  return {
    async call<T>(method: string, path: string, body?: unknown): Promise<T> {
      apiCalls.push({ method, path, body, token });
      if (path === "/api/me") return { id: "u1", handle: "alice.test", isOperator: operatorMode } as T;
      if (path === "/api/tenants") return [{ id: "11111111-1111-4111-8111-111111111111", name: "Alice net" }] as T;
      throw new ApiError(403, "You do not have permission to kick [HTTP 403]", { error: "You do not have permission to kick" });
    },
  };
}

beforeAll(async () => {
  store.users.set("u1", { id: "u1", did: "did:plc:alice", handle: "alice.test", disabledAt: null });
  store.users.set("u2", { id: "u2", did: "did:plc:bob", handle: "bob.test", disabledAt: null });

  const app = express();
  app.use(express.json());
  app.use(session({ secret: "test-secret", resave: false, saveUninitialized: false }));
  app.get("/test/login", (req, res) => {
    req.session.userId = String(req.query.user);
    // A recovery-code session (ADR-0035): must enrol a trusted device first
    if (req.query.mustEnroll) req.session.mustEnrollDevice = true;
    res.json({ ok: true });
  });
  app.use(createOAuthRouter({ provider: oauthProvider, publicUrl: PUBLIC_URL, disableRateLimits: true }));
  app.use(
    createMcpRouter({
      verifier: oauthProvider,
      resourceUrl: MCP_RESOURCE_URL,
      resourceMetadataUrl: protectedResourceMetadataUrl(PUBLIC_URL),
      apiBaseUrl: "http://127.0.0.1:1",
      apiClientFactory: mockApi,
      disableRateLimits: true,
    }),
  );
  app.use(resolveAgentToken);
  app.use(enforceAgentScope);
  app.get("/api/me", requireAuth, (req, res) => {
    res.json({ userId: authUserId(req), agentToken: req.agentToken ?? null, mcpAuth: req.mcpAuth ?? null });
  });
  app.use(createMcpConnectionsRouter(oauthProvider));

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(() => {
  server?.close();
});


function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function register(body: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Claude", ...body }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function login(user: string): Promise<string> {
  const res = await fetch(`${base}/test/login?user=${user}`);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

function authorizeUrl(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st-123",
    resource: MCP_RESOURCE_URL,
    ...extra,
  });
  return `${base}/oauth/authorize?${q}`;
}

function unescapeHtml(s: string) {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

async function getConsent(cookie: string, clientId: string, challenge: string) {
  const res = await fetch(authorizeUrl(clientId, challenge), { headers: { cookie }, redirect: "manual" });
  const html = await res.text();
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const csrf = /name="csrf_token" value="([^"]+)"/.exec(html)?.[1] ?? "";
  return { status: res.status, html, requestId, csrf };
}

async function consent(cookie: string, requestId: string, csrf: string, decision = "allow", extra: Record<string, string> = {}) {
  const res = await fetch(`${base}/oauth/consent`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request_id: requestId, csrf_token: csrf, decision, ...extra }),
    redirect: "manual",
  });
  return { status: res.status, location: res.headers.get("location") ?? "" };
}

async function tokenRequest(params: Record<string, string>) {
  const res = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  return { status: res.status, json: (await res.json()) as Record<string, string> };
}

/** Full flow: register → login → consent → code. */
async function obtainCode(user = "u1", opts: { operator?: boolean } = {}) {
  const { json: client } = await register();
  const clientId = String(client.client_id);
  const cookie = await login(user);
  const { verifier, challenge } = pkce();
  const c = await getConsent(cookie, clientId, challenge);
  const r = await consent(cookie, c.requestId, c.csrf, "allow", opts.operator ? { operator: "1" } : {});
  const code = new URL(r.location).searchParams.get("code") ?? "";
  return { clientId, cookie, verifier, code, location: r.location };
}

async function obtainTokens(user = "u1", opts: { operator?: boolean } = {}) {
  const f = await obtainCode(user, opts);
  const t = await tokenRequest({
    grant_type: "authorization_code",
    code: f.code,
    code_verifier: f.verifier,
    client_id: f.clientId,
    redirect_uri: REDIRECT,
    resource: MCP_RESOURCE_URL,
  });
  expect(t.status).toBe(200);
  return { ...f, tokens: t.json };
}

/** REST call as an internal /mcp tool call (secret header + MCP bearer). */
async function me(token: string) {
  return fetch(`${base}/api/me`, {
    headers: { Authorization: `Bearer ${token}`, [INTERNAL_MCP_HEADER]: INTERNAL_MCP_SECRET },
  });
}


describe("discovery metadata", () => {
  it("serves authorization server metadata with /oauth endpoints and S256", async () => {
    const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
    const m = (await res.json()) as Record<string, unknown>;
    expect(m.authorization_endpoint).toBe(`${PUBLIC_URL}/oauth/authorize`);
    expect(m.token_endpoint).toBe(`${PUBLIC_URL}/oauth/token`);
    expect(m.registration_endpoint).toBe(`${PUBLIC_URL}/oauth/register`);
    expect(m.revocation_endpoint).toBe(`${PUBLIC_URL}/oauth/revoke`);
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("serves protected resource metadata at the root and /mcp-scoped paths", async () => {
    for (const p of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const m = (await (await fetch(`${base}${p}`)).json()) as Record<string, unknown>;
      expect(m.resource).toBe(MCP_RESOURCE_URL);
      expect(m.authorization_servers).toEqual([`${PUBLIC_URL}/`]);
    }
  });
});

describe("dynamic client registration", () => {
  it("accepts https and loopback http redirect URIs and issues a public client", async () => {
    const { status, json } = await register({
      redirect_uris: [REDIRECT, "http://127.0.0.1:33418/callback", "http://localhost/cb"],
      token_endpoint_auth_method: "client_secret_post",
    });
    expect(status).toBe(201);
    expect(json.client_id).toBeTruthy();
    expect(json.client_secret).toBeUndefined();
    expect(json.token_endpoint_auth_method).toBe("none");
  });

  it.each([
    "http://evil.example.com/cb",
    "javascript:alert(1)",
    "myapp://callback",
    "https://user:pw@example.com/cb",
    "https://example.com/cb#frag",
  ])("rejects redirect URI %s", async (uri) => {
    const { status, json } = await register({ redirect_uris: [uri] });
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_client_metadata");
  });

  it("rejects unsupported grant types", async () => {
    const { status } = await register({ grant_types: ["client_credentials"] });
    expect(status).toBe(400);
  });

  it("validateRedirectUri allows [::1]", () => {
    expect(() => validateRedirectUri("http://[::1]:8080/cb")).not.toThrow();
  });
});

describe("authorize", () => {
  it("without a session renders the Bluesky sign-in with a local return path preserving the query", async () => {
    const { json } = await register();
    const { challenge } = pkce();
    const res = await fetch(authorizeUrl(String(json.client_id), challenge));
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('action="/auth/login"');
    expect(html).not.toMatch(/<script|style=/);
    const redirect = unescapeHtml(/name="redirect" value="([^"]+)"/.exec(html)![1]);
    expect(redirect).toMatch(/^\/[a-z0-9]/); // the /auth/login local-path check
    const q = new URL(redirect, PUBLIC_URL).searchParams;
    expect(new URL(redirect, PUBLIC_URL).pathname).toBe("/oauth/authorize");
    expect(q.get("client_id")).toBe(json.client_id);
    expect(q.get("code_challenge")).toBe(challenge);
    expect(q.get("state")).toBe("st-123");
    expect(q.get("redirect_uri")).toBe(REDIRECT);
    expect(q.get("resource")).toBe(MCP_RESOURCE_URL);
  });

  it("requires PKCE S256", async () => {
    const { json } = await register();
    const cookie = await login("u1");
    const noChallenge = authorizeUrl(String(json.client_id), "x").replace(/&code_challenge=x/, "");
    let res = await fetch(noChallenge, { headers: { cookie }, redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=invalid_request");
    res = await fetch(authorizeUrl(String(json.client_id), "abc", { code_challenge_method: "plain" }), {
      headers: { cookie },
      redirect: "manual",
    });
    expect(res.headers.get("location")).toContain("error=invalid_request");
  });

  it("rejects a foreign resource indicator", async () => {
    const { json } = await register();
    const cookie = await login("u1");
    const res = await fetch(authorizeUrl(String(json.client_id), "abc", { resource: "https://other.example/mcp" }), {
      headers: { cookie },
      redirect: "manual",
    });
    expect(res.headers.get("location")).toContain("error=invalid_target");
  });

  it("consent page shows the client and handle; deny redirects with access_denied", async () => {
    const { json } = await register();
    const cookie = await login("u1");
    const c = await getConsent(cookie, String(json.client_id), pkce().challenge);
    expect(c.html).toContain("Allow <strong>Claude</strong> at <strong>claude.ai</strong> to manage atproto-tailnet as");
    expect(c.html).toContain("@alice.test");
    const r = await consent(cookie, c.requestId, c.csrf, "deny");
    expect(r.status).toBe(302);
    const loc = new URL(r.location);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("st-123");
    expect(loc.searchParams.get("code")).toBeNull();
  });

  it("a recovery-code session cannot allow a connection (step-up as for other sensitive actions)", async () => {
    const { json: client } = await register();
    const res = await fetch(`${base}/test/login?user=u1&mustEnroll=1`);
    const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const { challenge } = pkce();
    const c = await getConsent(cookie, String(client.client_id), challenge);
    const r = await consent(cookie, c.requestId, c.csrf, "allow", { operator: "1" });
    expect(r.status).toBe(403);
    expect(r.location).toBe("");
  });

  it("consent POST requires the session CSRF token and is single use", async () => {
    const { json } = await register();
    const cookie = await login("u1");
    const c = await getConsent(cookie, String(json.client_id), pkce().challenge);
    expect((await consent(cookie, c.requestId, "wrong")).status).toBe(403);
    const ok = await consent(cookie, c.requestId, c.csrf);
    expect(ok.status).toBe(302);
    expect(new URL(ok.location).searchParams.get("code")).toBeTruthy();
    expect((await consent(cookie, c.requestId, c.csrf)).status).toBe(400);
  });

  it("disabled users cannot authorize", async () => {
    const { json } = await register();
    const cookie = await login("u2");
    store.users.get("u2")!.disabledAt = new Date();
    try {
      const res = await fetch(authorizeUrl(String(json.client_id), pkce().challenge), {
        headers: { cookie },
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("error=access_denied");
    } finally {
      store.users.get("u2")!.disabledAt = null;
    }
  });
});

describe("token endpoint", () => {
  it("rejects a wrong PKCE verifier", async () => {
    const f = await obtainCode();
    const t = await tokenRequest({
      grant_type: "authorization_code",
      code: f.code,
      code_verifier: pkce().verifier,
      client_id: f.clientId,
      redirect_uri: REDIRECT,
    });
    expect(t.status).toBe(400);
    expect(t.json.error).toBe("invalid_grant");
  });

  it("issues mcp_ tokens with 1h access lifetime; codes are single use and replay revokes the grant", async () => {
    const f = await obtainTokens();
    expect(f.tokens.access_token).toMatch(/^mcp_/);
    expect(f.tokens.refresh_token).toMatch(/^mcp_/);
    expect(Number(f.tokens.expires_in)).toBe(3600);
    expect((await me(f.tokens.access_token)).status).toBe(200);

    const replay = await tokenRequest({
      grant_type: "authorization_code",
      code: f.code,
      code_verifier: f.verifier,
      client_id: f.clientId,
      redirect_uri: REDIRECT,
    });
    expect(replay.status).toBe(400);
    expect(replay.json.error).toBe("invalid_grant");
    expect((await me(f.tokens.access_token)).status).toBe(401);
  });

  it("rejects a code used by a different client", async () => {
    const f = await obtainCode();
    const { json: other } = await register();
    const t = await tokenRequest({
      grant_type: "authorization_code",
      code: f.code,
      code_verifier: f.verifier,
      client_id: String(other.client_id),
    });
    expect(t.status).toBe(400);
  });

  it("rejects an expired code", async () => {
    const f = await obtainCode();
    const realNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 2 * 60 * 1000);
    try {
      const t = await tokenRequest({
        grant_type: "authorization_code",
        code: f.code,
        code_verifier: f.verifier,
        client_id: f.clientId,
      });
      expect(t.status).toBe(400);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("rotates refresh tokens; a reused refresh token is rejected and revokes the grant", async () => {
    const f = await obtainTokens();
    const r1 = await tokenRequest({ grant_type: "refresh_token", refresh_token: f.tokens.refresh_token, client_id: f.clientId });
    expect(r1.status).toBe(200);
    expect(r1.json.refresh_token).not.toBe(f.tokens.refresh_token);
    expect((await me(r1.json.access_token)).status).toBe(200);

    const reuse = await tokenRequest({ grant_type: "refresh_token", refresh_token: f.tokens.refresh_token, client_id: f.clientId });
    expect(reuse.status).toBe(400);
    expect(reuse.json.error).toBe("invalid_grant");
    // Whole grant revoked: the rotated tokens die too.
    expect((await me(r1.json.access_token)).status).toBe(401);
    const r2 = await tokenRequest({ grant_type: "refresh_token", refresh_token: r1.json.refresh_token, client_id: f.clientId });
    expect(r2.status).toBe(400);
  });

  it("revoke endpoint revokes the grant for a refresh token", async () => {
    const f = await obtainTokens();
    const res = await fetch(`${base}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: f.tokens.refresh_token, client_id: f.clientId }),
    });
    expect(res.status).toBe(200);
    expect((await me(f.tokens.access_token)).status).toBe(401);
  });

  it("stores only SHA-256 hashes of tokens", async () => {
    const f = await obtainTokens();
    const access = store.tokens.get(hashToken(f.tokens.access_token));
    const refresh = store.tokens.get(hashToken(f.tokens.refresh_token));
    expect(access?.kind).toBe("access");
    expect(refresh?.kind).toBe("refresh");
    expect(hashToken(f.tokens.access_token)).toMatch(/^[0-9a-f]{64}$/);
    const dump = JSON.stringify([...store.tokens.entries()]);
    expect(dump).not.toContain(f.tokens.access_token);
    expect(dump).not.toContain(f.tokens.refresh_token);
  });

  it("audits grant creation", async () => {
    const before = store.audits.length;
    await obtainTokens();
    expect(store.audits.slice(before).some((a) => a.action === "mcp_grant_created")).toBe(true);
  });
});

describe("REST request auth with an MCP token", () => {
  it("acts as the user and is not an agent token", async () => {
    const f = await obtainTokens();
    const res = await me(f.tokens.access_token);
    const body = (await res.json()) as { userId: string; agentToken: unknown; mcpAuth: { clientId: string } };
    expect(body.userId).toBe("u1");
    expect(body.agentToken).toBeNull();
    expect(body.mcpAuth.clientId).toBe(f.clientId);
  });

  it("is not limited by enforceAgentScope on non-tenant routes", async () => {
    const f = await obtainTokens();
    const res = await fetch(`${base}/api/mcp/connections`, {
      headers: { Authorization: `Bearer ${f.tokens.access_token}`, [INTERNAL_MCP_HEADER]: INTERNAL_MCP_SECRET },
    });
    // Reaches the route (session-only → 401), not the agent-scope 403.
    expect(res.status).toBe(401);
  });

  it("rejects unknown and garbage mcp_ tokens", async () => {
    expect((await me("mcp_nope")).status).toBe(401);
  });

  it("stops working when the user is disabled (REST and /mcp)", async () => {
    const f = await obtainTokens("u2");
    expect((await me(f.tokens.access_token)).status).toBe(200);
    store.users.get("u2")!.disabledAt = new Date();
    try {
      expect((await me(f.tokens.access_token)).status).toBe(401);
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${f.tokens.access_token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(401);
      const r = await tokenRequest({ grant_type: "refresh_token", refresh_token: f.tokens.refresh_token, client_id: f.clientId });
      expect(r.status).toBe(400);
    } finally {
      store.users.get("u2")!.disabledAt = null;
    }
  });
});

describe("/mcp endpoint", () => {
  it("401 includes WWW-Authenticate pointing at the protected resource metadata", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    const h = res.headers.get("www-authenticate") ?? "";
    expect(h).toMatch(/^Bearer /);
    expect(h).toContain(`resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"`);
  });

  async function connect(token: string) {
    const client = new Client({ name: "test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    return client;
  }

  it("tool round-trip: lists tools, calls the API with the same bearer token, surfaces API errors", async () => {
    operatorMode = false;
    const f = await obtainTokens();
    const client = await connect(f.tokens.access_token);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("list_tailnets");
      expect(names).toContain("whoami");
      expect(names).not.toContain("instance_overview");
      const removeDevice = tools.find((t) => t.name === "remove_device")!;
      expect(removeDevice.annotations?.destructiveHint).toBe(true);
      expect(removeDevice.description).toContain("DESTRUCTIVE");

      apiCalls.length = 0;
      const ok = await client.callTool({ name: "list_tailnets", arguments: {} });
      expect(ok.isError).toBeFalsy();
      expect(JSON.stringify(ok.content)).toContain("Alice net");
      expect(apiCalls).toEqual([{ method: "GET", path: "/api/tenants", body: undefined, token: f.tokens.access_token }]);

      const bad = await client.callTool({
        name: "remove_member",
        arguments: { tailnet_id: "11111111-1111-4111-8111-111111111111", user_id: "22222222-2222-4222-8222-222222222222" },
      });
      expect(bad.isError).toBe(true);
      expect(JSON.stringify(bad.content)).toContain("You do not have permission to kick");
      expect(apiCalls.at(-1)?.method).toBe("DELETE");
      expect(apiCalls.at(-1)?.path).toBe(
        "/api/tenants/11111111-1111-4111-8111-111111111111/members/22222222-2222-4222-8222-222222222222",
      );
    } finally {
      await client.close();
    }
  });

  it("lists operator tools only for operators", async () => {
    operatorMode = true;
    try {
      const f = await obtainTokens("u1", { operator: true });
      const client = await connect(f.tokens.access_token);
      const names = (await client.listTools()).tools.map((t) => t.name);
      await client.close();
      expect(names).toEqual(expect.arrayContaining(["instance_overview", "disable_user", "suspend_tailnet"]));
    } finally {
      operatorMode = false;
    }
  });

  it("GET is 405 for authenticated callers (stateless server)", async () => {
    const f = await obtainTokens();
    const res = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${f.tokens.access_token}` } });
    expect(res.status).toBe(405);
  });
});

describe("connections API", () => {
  it("lists and revokes the session user's grants", async () => {
    const f = await obtainTokens();
    const list = await fetch(`${base}/api/mcp/connections`, { headers: { cookie: f.cookie } });
    expect(list.status).toBe(200);
    const items = (await list.json()) as Array<{ id: string; clientName: string }>;
    const grantId = store.tokens.get(hashToken(f.tokens.access_token))!.grantId;
    expect(items.find((i) => i.id === grantId)?.clientName).toBe("Claude");

    const other = await login("u2");
    expect((await fetch(`${base}/api/mcp/connections/${grantId}`, { method: "DELETE", headers: { cookie: other } })).status).toBe(404);

    const before = store.audits.length;
    const del = await fetch(`${base}/api/mcp/connections/${grantId}`, { method: "DELETE", headers: { cookie: f.cookie } });
    expect(del.status).toBe(200);
    expect((await me(f.tokens.access_token)).status).toBe(401);
    expect(store.audits.slice(before).some((a) => a.action === "mcp_grant_revoked" && a.grantId === grantId)).toBe(true);
  });
});

describe("api client + internal-call marker", () => {
  it("sends the bearer token and internal header and surfaces API errors", async () => {
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer mcp_abc");
      expect(headers[INTERNAL_MCP_HEADER]).toBe(INTERNAL_MCP_SECRET);
      return new Response(JSON.stringify({ error: "Device limit reached", code: "device_limit" }), { status: 403 });
    });
    const api = new HttpApiClient({ baseUrl: "http://127.0.0.1:3000", token: "mcp_abc", fetchImpl: fetchImpl as typeof fetch });
    await expect(api.call("POST", "/api/tenants/x/devices/auth-key", {})).rejects.toThrow(
      "Device limit reached (code: device_limit) [HTTP 403]",
    );
    await expect(api.call("GET", "/oauth/token")).rejects.toThrow("non-API");
  });

  it("isInternalMcpCall needs the process secret and an MCP bearer", () => {
    const mk = (h: Record<string, string>) => ({ headers: h }) as unknown as import("express").Request;
    expect(isInternalMcpCall(mk({ [INTERNAL_MCP_HEADER]: INTERNAL_MCP_SECRET, authorization: "Bearer mcp_x" }))).toBe(true);
    expect(isInternalMcpCall(mk({ [INTERNAL_MCP_HEADER]: "guess", authorization: "Bearer mcp_x" }))).toBe(false);
    expect(isInternalMcpCall(mk({ [INTERNAL_MCP_HEADER]: INTERNAL_MCP_SECRET, authorization: "Bearer at_x" }))).toBe(false);
  });
});


describe("MCP tokens are only honoured on internal /mcp tool calls", () => {
  it("external /api call with a valid MCP token is 401; the internal tool call is accepted", async () => {
    const f = await obtainTokens();
    const external = await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${f.tokens.access_token}` } });
    expect(external.status).toBe(401);
    // Even with a forged marker header.
    const forged = await fetch(`${base}/api/me`, {
      headers: { Authorization: `Bearer ${f.tokens.access_token}`, [INTERNAL_MCP_HEADER]: "x".repeat(64) },
    });
    expect(forged.status).toBe(401);
    // The real in-process client (what /mcp tools use) works.
    const api = new HttpApiClient({ baseUrl: base, token: f.tokens.access_token });
    const body = await api.call<{ userId: string; mcpAuth: { operator: boolean } }>("GET", "/api/me");
    expect(body.userId).toBe("u1");
    expect(body.mcpAuth.operator).toBe(false);
  });
});

describe("tool path arguments", () => {
  const T = "11111111-1111-4111-8111-111111111111";
  async function connect(token: string) {
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  }

  it.each(["..", "%2e%2e", "a/b", ".", "1/../../me", "a\\b", "%2F"])(
    "remove_device rejects %s without any HTTP call",
    async (deviceId) => {
      const f = await obtainTokens();
      const client = await connect(f.tokens.access_token);
      try {
        apiCalls.length = 0;
        const r = await client.callTool({ name: "remove_device", arguments: { tailnet_id: T, device_id: deviceId } });
        expect(r.isError).toBe(true);
        expect(apiCalls).toHaveLength(0);
      } finally {
        await client.close();
      }
      // Direct run() (bypassing the SDK schema) is refused by seg() too.
      const def = TOOL_DEFS.find((d) => d.name === "remove_device")!;
      const call = vi.fn();
      await expect(Promise.resolve().then(() => def.run({ call } as unknown as ApiClient, { tailnet_id: T, device_id: deviceId }))).rejects.toThrow(/Invalid device_id/);
      expect(call).not.toHaveBeenCalled();
    },
  );

  it("revoke_auth_key / approve_route accept real id formats and refuse traversal", async () => {
    const calls: string[] = [];
    const api = { call: async (_m: string, p: string) => { calls.push(p); return null; } } as unknown as ApiClient;
    const revoke = TOOL_DEFS.find((d) => d.name === "revoke_auth_key")!;
    const route = TOOL_DEFS.find((d) => d.name === "approve_route")!;
    await revoke.run(api, { tailnet_id: T, key_id: "cp:9f3a" });
    await revoke.run(api, { tailnet_id: T, key_id: "22222222-2222-4222-8222-222222222222" });
    await route.run(api, { tailnet_id: T, route_id: "7-MTAuMC4wLjAvOA" });
    await route.run(api, { tailnet_id: T, route_id: "7:10.0.0.0/8" });
    expect(calls).toEqual([
      `/api/tenants/${T}/auth-keys/cp:9f3a`,
      `/api/tenants/${T}/auth-keys/22222222-2222-4222-8222-222222222222`,
      `/api/tenants/${T}/routes/7-MTAuMC4wLjAvOA/enable`,
      `/api/tenants/${T}/routes/7-${Buffer.from("10.0.0.0/8").toString("base64url")}/enable`,
    ]);
    expect(() => revoke.run(api, { tailnet_id: T, key_id: "../../x" })).toThrow(/key_id/);
    expect(() => route.run(api, { tailnet_id: T, route_id: "7:../../8" })).toThrow(/route_id/);
    expect(() => revoke.run(api, { tailnet_id: "../x", key_id: "cp:1" })).toThrow(/tailnet_id/);
    expect(calls).toHaveLength(4);
    expect(seg("abc_1:2-3", "id")).toBe("abc_1:2-3");
  });

  it("api client refuses any path that changes on normalization", async () => {
    const fetchImpl = vi.fn();
    const api = new HttpApiClient({ baseUrl: "http://127.0.0.1:3000", token: "mcp_x", fetchImpl: fetchImpl as unknown as typeof fetch });
    for (const p of [
      "/api/tenants/x/devices/..",
      "/api/tenants/x/devices/%2e%2e",
      "/api/tenants/x/devices/%2E%2e/y",
      "/api/tenants/x/devices/a%2Fb",
      "/api/tenants/x/devices/a%5Cb",
      "/api/tenants/x/../../oauth",
      "/api/tenants/x\\..\\y",
      "/api/tenants/x?y=1",
    ]) {
      await expect(api.call("DELETE", p)).rejects.toThrow(/Refusing/);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(() => assertSamePath("/api/tenants/a/devices/1", new URL("/api/tenants/a/devices/1", "http://x"))).not.toThrow();
  });
});

describe("consent phishing", () => {
  it("consent page labels the app unverified and shows the redirect host prominently", async () => {
    const { json } = await register({ client_name: "Totally Legit", redirect_uris: ["https://evil.example/cb"] });
    const cookie = await login("u2");
    const q = new URLSearchParams({
      response_type: "code",
      client_id: String(json.client_id),
      redirect_uri: "https://evil.example/cb",
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
    });
    const html = await (await fetch(`${base}/oauth/authorize?${q}`, { headers: { cookie } })).text();
    expect(html).toContain("Unverified app");
    expect(html).toMatch(/<h1>[^<]*evil\.example[^<]*<\/h1>/);
    expect(html).not.toContain('class="text-dim">After you decide');
    expect(html).toContain("you go back to <strong>evil.example</strong>");
  });

  it.each(["Claude", "claude code", "C l a u d e", "C.L.A.U.D.E", "ANTHROPIC", "Anthr0pic MCP", "Cl4ude", "Сlaude", "C​laude", "Ｃlaude"])(
    "rejects client_name %j with a non-Claude redirect host",
    async (name) => {
      const { status, json } = await register({ client_name: name, redirect_uris: ["https://evil.example/cb"] });
      expect(status).toBe(400);
      expect(json.error).toBe("invalid_client_metadata");
    },
  );

  it("allows Claude names on claude.ai / claude.com / loopback, and other names anywhere", async () => {
    expect((await register({ client_name: "Claude", redirect_uris: ["https://claude.com/api/mcp/auth_callback"] })).status).toBe(201);
    expect((await register({ client_name: "Claude Code", redirect_uris: ["http://localhost:4567/callback"] })).status).toBe(201);
    expect((await register({ client_name: "Claude", redirect_uris: [REDIRECT, "https://evil.example/cb"] })).status).toBe(400);
    expect((await register({ client_name: "My Agent", redirect_uris: ["https://evil.example/cb"] })).status).toBe(201);
  });

  it("loopback Claude Code clients are still labelled unverified", async () => {
    const { json } = await register({ client_name: "Claude Code", redirect_uris: ["http://127.0.0.1:4567/callback"] });
    const cookie = await login("u2");
    const q = new URLSearchParams({
      response_type: "code",
      client_id: String(json.client_id),
      redirect_uri: "http://127.0.0.1:4567/callback",
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
    });
    const html = await (await fetch(`${base}/oauth/authorize?${q}`, { headers: { cookie } })).text();
    expect(html).toContain("Unverified app");
    expect(html).toContain("127.0.0.1:4567");
  });
});

describe("registration metadata caps", () => {
  it("rejects bodies over 8 KiB, more than 10 redirect URIs and long client names", async () => {
    let r = await register({ client_name: "Big", logo_uri: "https://x.example/" + "a".repeat(9000) });
    expect(r.status).toBe(413);
    r = await register({ redirect_uris: Array.from({ length: 11 }, (_, i) => `https://claude.ai/cb${i}`) });
    expect(r.status).toBe(400);
    r = await register({ client_name: "n".repeat(101) });
    expect(r.status).toBe(400);
    r = await register({ client_name: "n".repeat(100) });
    expect(r.status).toBe(201);
  });
});

describe("operator scope", () => {
  async function connect(token: string) {
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  }

  it("the unchecked checkbox is shown only to operators", async () => {
    const { json } = await register();
    const op = await getConsent(await login("u1"), String(json.client_id), pkce().challenge);
    expect(op.html).toMatch(/<input type="checkbox" name="operator" value="1" \/>/);
    expect(op.html).not.toMatch(/checked/);
    expect(op.html).toContain("Also allow instance operator actions");
    const other = await getConsent(await login("u2"), String(json.client_id), pkce().challenge);
    expect(other.html).not.toContain('name="operator"');
  });

  it("operator tools need the scope; non-operators cannot obtain it by posting the field", async () => {
    operatorMode = true;
    try {
      const plain = await obtainTokens("u1");
      let client = await connect(plain.tokens.access_token);
      let names = (await client.listTools()).tools.map((t) => t.name);
      await client.close();
      expect(names).not.toContain("disable_user");

      const scoped = await obtainTokens("u1", { operator: true });
      client = await connect(scoped.tokens.access_token);
      names = (await client.listTools()).tools.map((t) => t.name);
      await client.close();
      expect(names).toContain("disable_user");

      const sneaky = await obtainTokens("u2", { operator: true });
      const grantId = store.tokens.get(hashToken(sneaky.tokens.access_token))!.grantId;
      expect(store.grants.get(grantId)!.operator).toBe(false);
    } finally {
      operatorMode = false;
    }
  });

  it("GET /api/mcp/connections shows the scope", async () => {
    const plain = await obtainTokens("u1");
    const scoped = await obtainTokens("u1", { operator: true });
    const list = (await (await fetch(`${base}/api/mcp/connections`, { headers: { cookie: scoped.cookie } })).json()) as Array<{ id: string; operator: boolean }>;
    const gid = (t: string) => store.tokens.get(hashToken(t))!.grantId;
    expect(list.find((c) => c.id === gid(scoped.tokens.access_token))?.operator).toBe(true);
    // A fresh consent for a new client — the plain grant belongs to another client and is still listed.
    expect(list.find((c) => c.id === gid(plain.tokens.access_token))?.operator).toBe(false);
  });

  it("requireOperator rejects MCP requests whose grant lacks the scope", async () => {
    const { requireOperator } = await import("../operator/auth.js");
    const res = { code: 0, body: null as unknown, status(c: number) { this.code = c; return this; }, json(b: unknown) { this.body = b; return this; } };
    const next = vi.fn();
    await requireOperator(
      { session: {}, mcpAuth: { userId: "u1", clientId: "c", grantId: "g", operator: false } } as never,
      res as never,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.code).toBe(403);
    expect((res.body as { code: string }).code).toBe("operator_scope_required");
  });
});

describe("authorization code replay race", () => {
  it("a replay while the grant is being created still revokes the grant", async () => {
    const { json } = await register();
    const client = (await store.getClient(String(json.client_id)))!;
    const code = oauthProvider.issueAuthorizationCode({
      clientId: client.client_id,
      userId: "u1",
      redirectUri: REDIRECT,
      codeChallenge: "c",
      resource: MCP_RESOURCE_URL,
      scopes: [],
      operator: false,
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const realCreate = store.createGrant.bind(store);
    let created: string | undefined;
    const spy = vi.spyOn(store, "createGrant").mockImplementation(async (g) => {
      await gate;
      const row = await realCreate(g);
      created = row.id;
      return row;
    });
    try {
      const first = oauthProvider.exchangeAuthorizationCode(client, code);
      const firstResult = first.then(() => "ok", (e: Error) => e.name);
      await new Promise((r) => setTimeout(r, 5));
      await expect(oauthProvider.exchangeAuthorizationCode(client, code)).rejects.toThrow(/already used/);
      release();
      expect(await firstResult).not.toBe("ok");
      expect(created).toBeTruthy();
      expect(store.grants.get(created!)!.revokedAt).not.toBeNull();
      expect(store.audits.some((a) => a.grantId === created && a.metadata?.reason === "authorization_code_replay")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
