/**
 * @module index
 *
 * Application entry point. Assembles Express middleware, mounts route modules,
 * configures session store, rate limiting, and the agent token middleware chain.
 *
 * Middleware order (for `/api/*` routes):
 * 1. JSON body parser
 * 2. Session (PostgreSQL-backed via connect-pg-simple)
 * 3. Dashboard router (HTML, no auth required)
 * 4. Auth rate limiter + auth router
 * 5. API rate limiter
 * 6. {@link resolveAgentToken} — Bearer token → agent context
 * 7. {@link enforceAgentScope} — tenant UUID match for agent tokens
 * 8. All API route modules
 */
import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import rateLimit from "express-rate-limit";
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
import { dashboardRouter } from "./routes/dashboard.js";
import { resolveAgentToken, enforceAgentScope } from "./routes/helpers.js";
import { startHealthMonitor } from "./orchestrator/monitor.js";
import { logger } from "./logger.js";

const app = express();

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

app.use(dashboardRouter);
app.use("/auth", authLimiter);
app.use("/.well-known", authLimiter);
app.use(authRouter);

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

app.listen(config.port, () => {
  logger.info({ port: config.port, url: config.publicUrl }, "atproto-tailnet running");
  startHealthMonitor();
});
