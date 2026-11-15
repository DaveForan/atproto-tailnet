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
