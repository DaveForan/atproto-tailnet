import { Router } from "express";

export const dashboardRouter = Router({ caseSensitive: true });

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>atproto-tailnet</title>
  <link rel="stylesheet" href="/css/dashboard.css" />
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/js/dashboard.js"></script>
</body>
</html>`;

const JOIN_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Join tailnet — atproto-tailnet</title>
  <link rel="stylesheet" href="/css/dashboard.css" />
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/js/join.js"></script>
</body>
</html>`;

dashboardRouter.get("/", (req, res) => {
  res.type("html").send(DASHBOARD_HTML);
});

dashboardRouter.get("/join/:slug", (req, res) => {
  res.type("html").send(JOIN_PAGE_HTML);
});

const INVITE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Invitation link (`inviteUrl`): the dashboard shell shows the invitation to the signed-in invitee.
 * Anonymous visitors get the login view with `redirect=/invite/:id`.
 * Security: the link alone must not create a session row, so anonymous visits write nothing.
 */
dashboardRouter.get("/invite/:id", (req, res) => {
  const id = req.params.id;
  if (typeof id !== "string" || !INVITE_ID_RE.test(id)) {
    res.redirect("/");
    return;
  }
  res.type("html").send(DASHBOARD_HTML);
});

/**
 * Device sign-in link (ADR-0032): the dashboard shell shows the waiting device to the signed-in member.
 * Anonymous visitors get the login view with `redirect=/device/:id`.
 */
dashboardRouter.get("/device/:id", (req, res) => {
  const id = req.params.id;
  if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id)) {
    res.redirect("/");
    return;
  }
  res.type("html").send(DASHBOARD_HTML);
});

/** Second step of sign-in when the account has trusted devices (ADR-0035). */
dashboardRouter.get("/verify-device", (_req, res) => {
  res.type("html").send(DASHBOARD_HTML);
});
