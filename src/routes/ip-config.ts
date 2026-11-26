/**
 * @module routes/ip-config
 * The address ranges of a tailnet (manage_settings). They are fixed when the tailnet is created.
 */

import { Router } from "express";
import { requireAuth } from "./helpers.js";
import { tenantGuard, tenantCtx } from "./guard.js";

export const ipConfigRouter = Router({ caseSensitive: true });

ipConfigRouter.get(
  "/api/tenants/:tenantId/ip-config",
  requireAuth,
  tenantGuard({ permission: "manage_settings" }),
  (_req, res) => {
    const { tenant } = tenantCtx(res);
    res.json({ ipv4Prefix: tenant.ipv4Prefix, ipv6Prefix: tenant.ipv6Prefix });
  },
);
