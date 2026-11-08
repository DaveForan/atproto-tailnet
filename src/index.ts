/**
 * @module index
 *
 * Application entry point. Assembles Express middleware, mounts route modules,
 * configures session store, rate limiting, and the agent token middleware chain.
 *
 * Middleware order (for `/api/*` routes):
 * 1. Security headers
 * 2. JSON body parser
 * 3. Session (PostgreSQL-backed via connect-pg-simple)
 * 4. CSRF token endpoint + validation middleware
 * 5. Dashboard router (HTML, no auth required)
 * 6. Auth rate limiter + auth router
 * 7. API rate limiter
 * 8. {@link resolveAgentToken} — Bearer token → agent context
 * 9. {@link enforceAgentScope} — tenant UUID match for agent tokens
 * 10. All API route modules
 */
import express from "express";
import type { Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import rateLimit from "express-rate-limit";
import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { pool } from "./db/index.js";
import { authRouter } from "./routes/auth.js";
import { apiRouter } from "./routes/api.js";
import { invitationsRouter } from "./routes/invitations.js";
import { devicesRouter } from "./routes/devices.js";
import { securityRouter } from "./routes/security.js";
import { servicesRouter } from "./routes/services.js";
import { boardRouter } from "./routes/board.js";
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
import { federationMessagesRouter } from "./routes/federation-messages.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { resolveAgentToken, enforceAgentScope } from "./routes/helpers.js";
import { startHealthMonitor } from "./orchestrator/monitor.js";
import { startBroker } from "./orchestrator/federation-broker.js";
import { startAbuseSweep } from "./federation/abuse.js";
import { reconcileTenantRouting } from "./orchestrator/caddy.js";
import { logger } from "./logger.js";

const app = express();

// ── Security headers ──────────────────────────────────────────────────
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
    "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'",
  );
  next();
});

app.use(express.json());

const PgStore = connectPgSimple(session);

app.use(
  session({
    store: new PgStore({
      pool,
      createTableIfMissing: true,
    }),
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

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests, try again later" },
});

const federationLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests, try again later" },
});

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
  const token = req.headers["x-csrf-token"];
  if (!token || token !== req.session.csrfToken) {
    res.status(403).json({ error: "Invalid or missing CSRF token" });
    return;
  }
  next();
});

app.use(dashboardRouter);
app.use("/auth", authLimiter);
app.use("/.well-known", authLimiter);
app.use(authRouter);

// Broker-to-broker CFP messages (ADR-0016): authenticated by DID signature,
// not sessions or agent tokens. Keepalives for every session arrive from the
// peer broker's single address, so they get their own, higher limit.
app.use("/api/federation/messages", federationLimiter);
app.use(federationMessagesRouter);

app.use("/collective", apiLimiter);
app.use("/api", apiLimiter);
app.use(resolveAgentToken);
app.use(enforceAgentScope);
app.use(apiRouter);
app.use(invitationsRouter);
app.use(devicesRouter);
app.use(securityRouter);
app.use(servicesRouter);
app.use(boardRouter);
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

app.listen(config.port, () => {
  logger.info({ port: config.port, url: config.publicUrl }, "atproto-tailnet running");
  startHealthMonitor();
  startBroker();
  startAbuseSweep();
  void reconcileTenantRouting();
});
