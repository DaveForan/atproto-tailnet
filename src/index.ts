import express from "express";
import session from "express-session";
import { config } from "./config.js";
import { authRouter } from "./routes/auth.js";
import { apiRouter } from "./routes/api.js";
import { invitationsRouter } from "./routes/invitations.js";
import { devicesRouter } from "./routes/devices.js";
import { dashboardRouter } from "./routes/dashboard.js";

const app = express();

app.use(express.json());

app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: config.publicUrl.startsWith("https"),
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  }),
);

// Dashboard and auth are at the root level — no auth guard
app.use(dashboardRouter);
app.use(authRouter);

// API routes — these all have path-level guards
app.use(apiRouter);
app.use(invitationsRouter);
app.use(devicesRouter);

app.listen(config.port, () => {
  console.log(`atproto-tailnet running at ${config.publicUrl}`);
});
