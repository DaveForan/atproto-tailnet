/**
 * @module oauth/router
 * Mounts the MCP OAuth endpoints using the SDK's handlers with our provider:
 *
 * - GET  /.well-known/oauth-authorization-server     (RFC 8414)
 * - GET  /.well-known/oauth-protected-resource[/mcp] (RFC 9728)
 * - POST /oauth/register   dynamic client registration (RFC 7591)
 * - GET|POST /oauth/authorize  → sign-in (existing Bluesky login) → consent page
 * - POST /oauth/consent    Allow/Deny form (session + CSRF token)
 * - POST /oauth/token      authorization_code (PKCE S256) + refresh_token
 * - POST /oauth/revoke     RFC 7009
 *
 * The SDK's `mcpAuthRouter` hard-codes /authorize, /token, … at the root, so
 * the same handlers are mounted here under /oauth/ with our own metadata.
 */
import express, { Router } from "express";
import type { Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import rateLimit from "express-rate-limit";
import type { OAuthMetadata, OAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";
import { revocationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/revoke.js";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";
import { MAX_CLIENT_METADATA_BYTES, type TailnetOAuthProvider } from "./provider.js";
import { errorPage } from "./pages.js";
import "./types.js";
import { stepUpMissing } from "../auth/step-up.js";

export interface OAuthRouterOptions {
  provider: TailnetOAuthProvider;
  /** Instance base URL (PUBLIC_URL). */
  publicUrl: string;
  /** Disable the SDK's per-endpoint rate limits (tests). */
  disableRateLimits?: boolean;
}

/** URL of the protected-resource metadata document for the /mcp resource. */
export function protectedResourceMetadataUrl(publicUrl: string): string {
  return new URL("/.well-known/oauth-protected-resource/mcp", publicUrl).href;
}

export function buildAuthorizationServerMetadata(publicUrl: string): OAuthMetadata {
  const issuer = new URL(publicUrl).href;
  const at = (p: string) => new URL(p, publicUrl).href;
  return {
    issuer,
    authorization_endpoint: at("/oauth/authorize"),
    token_endpoint: at("/oauth/token"),
    registration_endpoint: at("/oauth/register"),
    revocation_endpoint: at("/oauth/revoke"),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
  };
}

export function buildProtectedResourceMetadata(publicUrl: string, resourceUrl: string): OAuthProtectedResourceMetadata {
  return {
    resource: resourceUrl,
    authorization_servers: [new URL(publicUrl).href],
    bearer_methods_supported: ["header"],
    resource_name: "atproto-tailnet",
  };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function createOAuthRouter(opts: OAuthRouterOptions): Router {
  const { provider, publicUrl } = opts;
  const rl = <T extends object>(cfg: T): T | false => (opts.disableRateLimits ? false : cfg);
  const router = Router();

  const asMetadata = buildAuthorizationServerMetadata(publicUrl);
  const prm = buildProtectedResourceMetadata(publicUrl, provider.resourceUrl);

  if (!opts.disableRateLimits) {
    router.use(
      ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource", "/oauth/consent"],
      rateLimit({
        windowMs: 60 * 1000,
        limit: 120,
        standardHeaders: "draft-7",
        legacyHeaders: false,
        message: { error: "Too many requests, try again later" },
      }),
    );
  }
  router.use("/.well-known/oauth-authorization-server", metadataHandler(asMetadata));
  router.use("/.well-known/oauth-protected-resource/mcp", metadataHandler(prm));
  router.use("/.well-known/oauth-protected-resource", metadataHandler(prm));

  router.use(
    "/oauth/authorize",
    authorizationHandler({ provider, rateLimit: rl({ windowMs: 15 * 60 * 1000, max: 100 }) }),
  );
  router.use(
    "/oauth/token",
    tokenHandler({ provider, rateLimit: rl({ windowMs: 60 * 1000, max: 60 }) }),
  );
  // Registration bodies are capped at 8 KiB (the app-wide JSON parser allows
  // more): checked on the declared length and on the parsed body.
  router.use("/oauth/register", (req: Request, res: Response, next) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    let parsedSize = 0;
    try {
      parsedSize = req.body && typeof req.body === "object" ? JSON.stringify(req.body).length : 0;
    } catch {
      parsedSize = Infinity;
    }
    if (declared > MAX_CLIENT_METADATA_BYTES || parsedSize > MAX_CLIENT_METADATA_BYTES) {
      res.status(413).json({
        error: "invalid_client_metadata",
        error_description: `Registration body must be at most ${MAX_CLIENT_METADATA_BYTES} bytes`,
      });
      return;
    }
    next();
  });
  router.use(
    "/oauth/register",
    clientRegistrationHandler({
      clientsStore: provider.clientsStore,
      rateLimit: rl({ windowMs: 60 * 60 * 1000, max: 20 }),
    }),
  );
  router.use(
    "/oauth/revoke",
    revocationHandler({ provider, rateLimit: rl({ windowMs: 60 * 1000, max: 60 }) }),
  );

  router.post(
    "/oauth/consent",
    express.urlencoded({ extended: false, limit: "8kb" }),
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store");
      const userId = req.session?.userId;
      if (!userId) {
        res.status(401).type("html").send(
          errorPage("Session expired", "Sign in again, then start the connection again from your MCP client."),
        );
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const requestId = typeof body.request_id === "string" ? body.request_id : "";
      const csrf = typeof body.csrf_token === "string" ? body.csrf_token : "";
      const decision = body.decision === "allow" ? "allow" : "deny";

      if (!req.session.csrfToken || !csrf || !safeEqual(csrf, req.session.csrfToken)) {
        res.status(403).type("html").send(errorPage("Request blocked", "Invalid or missing CSRF token."));
        return;
      }

      const all = req.session.mcpPendingAuthz ?? {};
      const pending = Object.prototype.hasOwnProperty.call(all, requestId) ? all[requestId] : undefined;
      if (pending) {
        const rest = { ...all };
        delete rest[requestId];
        req.session.mcpPendingAuthz = rest;
      }
      if (!pending || pending.userId !== userId || pending.expiresAt <= Date.now()) {
        res.status(400).type("html").send(
          errorPage("Request expired", "This request expired. Start the connection again from your MCP client."),
        );
        return;
      }

      const target = new URL(pending.redirectUri);
      if (pending.state !== undefined) target.searchParams.set("state", pending.state);

      const client = await provider.store.getClient(pending.clientId);
      const user = await provider.store.getUser(userId);
      if (!client) {
        res.status(400).type("html").send(errorPage("Unknown application", "This application is no longer registered."));
        return;
      }
      if (decision !== "allow" || !user || user.disabledAt) {
        target.searchParams.set("error", "access_denied");
        target.searchParams.set(
          "error_description",
          decision !== "allow" ? "The user denied access" : "This account cannot authorize applications",
        );
        res.redirect(302, target.href);
        return;
      }

      // A connection acts as the user for a long time: with the device lock
      // on, allowing one needs a fresh proof from the trusted device (ADR-0035).
      if (stepUpMissing(req)) {
        res.status(403).type("html").send(
          errorPage(
            "Confirm this device first",
            "Open the dashboard, go to Account and select \"Confirm this device\". Then start the connection again from your MCP client within 5 minutes.",
          ),
        );
        return;
      }

      // Operator scope: explicit opt-in, offered only to operators, re-checked now.
      const operator =
        body.operator === "1" && pending.operatorEligible === true && provider.isOperatorDid(user.did);
      const code = provider.issueAuthorizationCode({
        clientId: pending.clientId,
        userId,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        resource: pending.resource,
        scopes: pending.scopes,
        operator,
      });
      target.searchParams.set("code", code);
      res.redirect(302, target.href);
    },
  );

  return router;
}
