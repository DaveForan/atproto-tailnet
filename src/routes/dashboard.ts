import { Router } from "express";

export const dashboardRouter = Router();

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
  <script src="/js/dashboard.js"></script>
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
  <script src="/js/join.js"></script>
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
 * Invitation link (`inviteUrl`). Serves the dashboard shell, which shows the
 * invitation to the signed-in invitee. Anonymous visitors get the login view;
 * the destination is remembered in the session (and the client passes
 * `redirect=/invite/:id` to /auth/login) so sign-in comes back here.
 */
dashboardRouter.get("/invite/:id", (req, res) => {
  const id = req.params.id;
  if (typeof id !== "string" || !INVITE_ID_RE.test(id)) {
    res.redirect("/");
    return;
  }
  if (!req.session.userId) {
    req.session.postLoginRedirect = `/invite/${id.toLowerCase()}`;
  }
  res.type("html").send(DASHBOARD_HTML);
});
