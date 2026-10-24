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
import { dashboardRouter } from "./routes/dashboard.js";

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
app.use(authRouter);

app.use("/api", apiLimiter);
app.use(apiRouter);
app.use(invitationsRouter);
app.use(devicesRouter);
app.use(securityRouter);

app.listen(config.port, () => {
  console.log(`atproto-tailnet running at ${config.publicUrl}`);
});
