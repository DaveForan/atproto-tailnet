/**
 * @module mcp/server
 * Remote MCP endpoint (`/mcp`, Streamable HTTP) protected by MCP OAuth bearer
 * tokens.
 *
 * Stateless mode: every POST builds a fresh McpServer + transport (no
 * Mcp-Session-Id, JSON responses). Nothing lives in memory between requests,
 * so restarts and multiple instances need no session affinity, and the tool
 * list is computed per request from the caller (operator tools only for
 * operators). The tools are thin REST calls, so there is nothing to stream and
 * no server-initiated messages — GET (SSE) and DELETE answer 405.
 */
import { Router } from "express";
import type { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { HttpApiClient, type ApiClient } from "./api-client.js";
import { registerTools } from "./tools.js";
import { logger } from "../logger.js";

export const MCP_INSTRUCTIONS = `Manage atproto-tailnet (private Tailscale-compatible mesh networks with Bluesky identity) as the signed-in user.
Start with whoami and list_tailnets; most tools need a tailnet_id from list_tailnets.
You have exactly the user's dashboard permissions; API errors are returned as tool errors.
Tools marked DESTRUCTIVE remove devices, members, keys or access — confirm with the user before calling them.`;

export interface McpRouterOptions {
  verifier: OAuthTokenVerifier;
  /** Absolute /mcp URL (token audience). */
  resourceUrl: string;
  /** RFC 9728 metadata URL advertised in WWW-Authenticate. */
  resourceMetadataUrl: string;
  /** Base URL for in-process REST calls, e.g. http://127.0.0.1:3000 */
  apiBaseUrl: string;
  /** Override the API client (tests). */
  apiClientFactory?: (token: string) => ApiClient;
  disableRateLimits?: boolean;
}

const OPERATOR_CACHE_MS = 60 * 1000;

export function createMcpRouter(opts: McpRouterOptions): Router {
  const router = Router();
  const makeApi = opts.apiClientFactory ?? ((token: string) => new HttpApiClient({ baseUrl: opts.apiBaseUrl, token }));
  const operatorCache = new Map<string, { value: boolean; expiresAt: number }>();

  const bearer = requireBearerAuth({
    verifier: opts.verifier,
    resourceMetadataUrl: opts.resourceMetadataUrl,
    expectedResource: new URL(opts.resourceUrl),
  });

  const limiters = opts.disableRateLimits
    ? []
    : [
        // Before auth: per IP, bounds token-guessing / 401 spam.
        rateLimit({
          windowMs: 60 * 1000,
          limit: 300,
          standardHeaders: "draft-7",
          legacyHeaders: false,
          message: { error: "Too many requests, try again later" },
        }),
      ];
  const userLimiter = opts.disableRateLimits
    ? []
    : [
        // After auth: per user (several Claude users may share an egress IP).
        rateLimit({
          windowMs: 60 * 1000,
          limit: 120,
          standardHeaders: "draft-7",
          legacyHeaders: false,
          keyGenerator: (req) => `mcp-user:${String((req as Request).auth?.extra?.userId ?? "")}`,
          message: { jsonrpc: "2.0", error: { code: -32000, message: "Rate limit exceeded" }, id: null },
        }),
      ];

  async function isOperator(grantKey: string, api: ApiClient): Promise<boolean> {
    const now = Date.now();
    const hit = operatorCache.get(grantKey);
    if (hit && hit.expiresAt > now) return hit.value;
    let value = false;
    try {
      const me = await api.call<{ isOperator?: boolean }>("GET", "/api/me");
      value = me?.isOperator === true;
    } catch (err) {
      logger.warn({ err }, "MCP: /api/me lookup failed; operator tools hidden");
    }
    if (operatorCache.size > 10_000) operatorCache.clear();
    operatorCache.set(grantKey, { value, expiresAt: now + OPERATOR_CACHE_MS });
    return value;
  }

  router.post("/mcp", ...limiters, bearer, ...userLimiter, async (req: Request, res: Response) => {
    const auth = req.auth!;
    const api = makeApi(auth.token);
    const grantKey = String(auth.extra?.grantId ?? auth.token);
    const server = new McpServer(
      { name: "atproto-tailnet", version: "1.0.0" },
      { instructions: MCP_INSTRUCTIONS },
    );
    registerTools(server, api, { isOperator: await isOperator(grantKey, api) });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error({ err }, "MCP request failed");
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  const notAllowed = (_req: Request, res: Response) => {
    res
      .status(405)
      .set("Allow", "POST")
      .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: use POST)" }, id: null });
  };
  router.get("/mcp", ...limiters, bearer, notAllowed);
  router.delete("/mcp", ...limiters, bearer, notAllowed);

  return router;
}
