/**
 * @module index
 * Entry point: middleware, route modules, background loops and graceful shutdown.
 * Order for `/api/*`: headers, JSON parsers (federation messages first, 64 KiB),
 * session, CSRF, dashboard, auth, rate limits, resolveAgentToken, enforceAgentScope, routes.
 */
import express from "express";
import type { Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import rateLimit from "express-rate-limit";
import { randomBytes } from "node:crypto";
import { config, sessionCookieName } from "./config.js";
import { pool } from "./db/index.js";
import { createShutdown } from "./shutdown.js";
import { authRouter } from "./routes/auth.js";
import { apiRouter, tlsCertAllowedForSlug } from "./routes/api.js";
import { hostnamesRouter } from "./routes/hostnames.js";
import { invitationsRouter } from "./routes/invitations.js";
import { devicesRouter } from "./routes/devices.js";
import { securityRouter } from "./routes/security.js";
import { boardsRouter } from "./routes/boards.js";
import { sharingRouter } from "./routes/sharing.js";
import { machineLockRouter } from "./routes/machine-lock.js";
import { deviceSignInRouter } from "./routes/device-signin.js";
import { deviceTrustRouter } from "./routes/device-trust.js";
import { enforceDeviceEnrollment } from "./auth/session.js";
import { agentsRouter } from "./routes/agents.js";
import { aclRouter } from "./routes/acl.js";
import { derpRouter } from "./routes/derp.js";
import { ipConfigRouter } from "./routes/ip-config.js";
import { routesRouter } from "./routes/routes.js";
import { usageRouter } from "./routes/usage.js";
import { federationRouter } from "./routes/federation.js";
import { collectivesRouter } from "./routes/collectives.js";
import { traversalRouter } from "./routes/traversal.js";
import { credentialsRouter } from "./routes/credentials.js";
import { federationBodyParser, federationMessagesRouter } from "./routes/federation-messages.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { operatorRouter, instanceRouter } from "./routes/operator.js";
import { enforceOperatorState } from "./operator/access.js";
import { resolveAgentToken, enforceAgentScope, csrfTokenMatches } from "./routes/helpers.js";
import { oauthRouter, mcpRouter, isInternalMcpCall } from "./mcp/index.js";
import { mcpConnectionsRouter } from "./routes/mcp-connections.js";
import { startHealthMonitor, stopHealthMonitor } from "./orchestrator/monitor.js";
import { startBroker, stopBroker } from "./orchestrator/federation-broker.js";
import { startAbuseSweep, stopAbuseSweep } from "./federation/abuse.js";
import { reconcileTenantRouting } from "./orchestrator/caddy.js";
import { logger } from "./logger.js";
import { purgeStoredOAuthSessions } from "./auth/atproto.js";

const app = express();
app.disable("x-powered-by");

// ── Internal endpoint for Caddy on-demand TLS ───────────────────────
// Caddy calls this before issuing a certificate for a hostname.
// Returns 200 if the hostname belongs to a real tenant, 403 otherwise.
// Must be before all middleware (no session, no CSRF, no rate limiting).
app.get("/internal/tls-check", async (req: Request, res: Response) => {
  // Without Caddy nothing asks this, and the edge proxy may not block the path
  if (!config.caddyEnabled) {
    res.status(404).end();
    return;
  }
  const domain = (req.query.domain as string) || "";
  const suffix = `.${config.baseDomain}`;
  if (!domain.endsWith(suffix)) {
    res.status(403).end();
    return;
  }
  const slug = domain.slice(0, -suffix.length);
  if (!slug || slug.includes(".")) {
    res.status(403).end();
    return;
  }
  try {
    res.status((await tlsCertAllowedForSlug(slug)) ? 200 : 403).end();
  } catch {
    res.status(403).end();
  }
});

// ── Security headers ──────────────────────────────────────────────────
// Behind Caddy, req.secure / req.ip come from X-Forwarded-*; without this the
// secure session cookie is never sent and per-IP rate limits see one client.
app.set("trust proxy", config.trustProxy);

app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'",
  );
  next();
});

// Federation messages get their own, smaller body limit. This parser runs
// first, so the global parser skips the already-parsed body.
app.use("/api/federation/messages", federationBodyParser);
app.use(express.json());

const PgStore = connectPgSimple(session);

app.use(
  session({
    store: new PgStore({
      pool,
      createTableIfMissing: true,
    }),
    name: sessionCookieName(),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: config.publicUrl.startsWith("https"),
      httpOnly: true,
      sameSite: "lax" as const,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  }),
);

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests, try again later" },
});

/** Requests per minute for callers without a dashboard session, per address. */
const API_LIMIT_PER_ADDRESS = 60;
/**
 * Requests per minute for one signed-in user. One page of the dashboard makes
 * about ten requests, so the per-address number is too low for normal use, and
 * people behind one address (a home, an office) must not share one budget.
 */
const API_LIMIT_PER_USER = 300;

const signedIn = (req: Request): boolean => Boolean(req.session?.userId);

const addressLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: API_LIMIT_PER_ADDRESS,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests, try again later" },
  // MCP tool calls arrive on loopback (one shared IP); /mcp has its own per-user limit
  skip: (req) => isInternalMcpCall(req) || signedIn(req),
});

const userLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: API_LIMIT_PER_USER,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests, try again later" },
  keyGenerator: (req) => `user:${req.session.userId}`,
  skip: (req) => !signedIn(req),
});

/** Anonymous and token callers are limited per address; signed-in users per account. */
const apiLimiter = [addressLimiter, userLimiter];

const federationLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests, try again later" },
});

// After a recovery-code sign-in, only device enrolment is allowed (ADR-0035)
app.use(enforceDeviceEnrollment);

// ── CSRF token endpoint ───────────────────────────────────────────────
app.get("/api/csrf-token", (req: Request, res: Response) => {
  if (!req.session.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  if (!req.session.csrfToken) {
    req.session.csrfToken = randomBytes(32).toString("hex");
  }
  res.json({ token: req.session.csrfToken });
});

// ── CSRF validation middleware ────────────────────────────────────────
// Validates X-CSRF-Token header on state-changing requests to /api/*.
// Exempt: Bearer-authenticated requests (agent tokens), .well-known, auth callbacks.
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method !== "POST" && req.method !== "PUT" && req.method !== "PATCH" && req.method !== "DELETE") {
    next();
    return;
  }
  if (!req.path.startsWith("/api/")) {
    next();
    return;
  }
  // Agent tokens use Bearer auth, not sessions — no CSRF risk
  if (req.headers.authorization?.startsWith("Bearer ")) {
    next();
    return;
  }
  // No session means no cookie-based auth to exploit
  if (!req.session.userId) {
    next();
    return;
  }
  if (!csrfTokenMatches(req.headers["x-csrf-token"], req.session.csrfToken)) {
    res.status(403).json({ error: "Invalid or missing CSRF token" });
    return;
  }
  next();
});

import path from "node:path";
import { startLeaderElection, stopLeaderElection } from "./orchestrator/leader.js";
app.use(express.static(path.join(import.meta.dirname, "..", "public")));
app.use(dashboardRouter);
// Remote MCP server + its OAuth endpoints (own rate limits; before the
// /.well-known auth limiter so connector discovery is not throttled at 10/min)
app.use(oauthRouter);
app.use(mcpRouter);
app.use("/auth", authLimiter);
app.use("/.well-known", authLimiter);
app.use(authRouter);

// Broker-to-broker CFP messages (ADR-0016): authenticated by DID signature,
// not sessions or agent tokens. Keepalives for every session arrive from the
// peer broker's single address, so they get their own, higher limit.
if (!config.federationEnabled) {
  app.use(
    [
      "/api/federation",
      "/api/tenants/:tenantId/federation",
      "/api/tenants/:tenantId/traversal-policy",
      // Federation discovery (posture, region) — collective DID docs stay served
      "/.well-known/collective-federation",
    ],
    (_req: Request, res: Response) => {
      res.status(404).json({ error: "Federation is not enabled on this instance" });
    },
  );
}
app.use("/api/federation/messages", federationLimiter);
app.use(federationMessagesRouter);

app.use("/collective", apiLimiter);
app.use("/api", apiLimiter);
app.use(instanceRouter); // public GET /api/instance — before Bearer resolution
app.use(resolveAgentToken);
app.use(enforceAgentScope);
// Disabled users (any credential) and suspended tenants (members) — keep
// after every credential resolver so it sees the authenticated user
app.use(enforceOperatorState);
app.use(operatorRouter);
app.use(mcpConnectionsRouter);
app.use(apiRouter);
app.use(invitationsRouter);
app.use(devicesRouter);
app.use(securityRouter);
app.use(deviceTrustRouter);
app.use(deviceSignInRouter);
app.use(boardsRouter);
app.use(sharingRouter);
app.use(machineLockRouter);
app.use(agentsRouter);
app.use(aclRouter);
app.use(derpRouter);
app.use(ipConfigRouter);
app.use(routesRouter);
app.use(usageRouter);
app.use(federationRouter);
app.use(collectivesRouter);
app.use(traversalRouter);
app.use(credentialsRouter);
app.use(hostnamesRouter);

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, url: config.publicUrl }, "atproto-tailnet running");
  // One replica does the background work; the others take over if it stops
  void startLeaderElection();
  startHealthMonitor();
  if (config.federationEnabled) startBroker();
  startAbuseSweep();
  void reconcileTenantRouting();
  // Earlier versions kept account tokens after sign-in; revoke and drop them
  void purgeStoredOAuthSessions()
    .then((n) => n > 0 && logger.info({ sessions: n }, "revoked stored OAuth sessions"))
    .catch((err) => logger.warn({ err }, "failed to purge stored OAuth sessions"));
});

const shutdown = createShutdown({
  server,
  stopLoops: [stopBroker, stopAbuseSweep, stopHealthMonitor, stopLeaderElection],
  closePool: () => pool.end(),
  exit: (code) => process.exit(code),
});
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
