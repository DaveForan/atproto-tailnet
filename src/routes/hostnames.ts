/**
 * @module routes/hostnames
 * Tailnet public addresses (`<name>.<BASE_DOMAIN>`): list, set the primary
 * (the previous one stays as a routed alias), retire an alias.
 *
 * Changing addresses is originator-only and never via agent tokens: it
 * changes the URL every new device is given.
 */
import { Router } from "express";
import { config } from "../config.js";
import { requireAuth, param, getTenantForUser, authUserId } from "./helpers.js";
import { logAudit } from "./audit.js";
import { logger } from "../logger.js";
import { syncTenantRoutes } from "../orchestrator/caddy.js";
import { syncTenantAccess } from "../access/sync.js";
import {
  listHostnames,
  retireHostname,
  setPrimaryHostname,
  tenantLoginServerFor,
  usesSharedControlUrl,
  MAX_LIVE_HOSTNAMES,
  type HostnameError,
} from "../orchestrator/hostnames.js";
import { stepUpForSession } from "../auth/step-up.js";

export const hostnamesRouter = Router();

const ERRORS: Record<HostnameError, { status: number; message: string }> = {
  invalid: {
    status: 400,
    message: "Use 1–63 lowercase letters, digits or single hyphens, starting and ending with a letter or digit",
  },
  reserved: { status: 400, message: "That address is reserved" },
  taken: { status: 409, message: "That address is not available" },
  too_many: {
    status: 409,
    message: `A tailnet can have at most ${MAX_LIVE_HOSTNAMES} active addresses — retire an old alias first`,
  },
};

hostnamesRouter.get("/api/tenants/:tenantId/hostnames", requireAuth, async (req, res) => {
  const result = await getTenantForUser(param(req, "tenantId"), authUserId(req));
  if (!result) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  const names = await listHostnames(result.tenant.id);
  res.json({
    baseDomain: config.baseDomain,
    // What devices put in --login-server; with a shared control URL the
    // tailnet address is its public name only (links, device/service names)
    loginServer: await tenantLoginServerFor(result.tenant),
    sharedControl: usesSharedControlUrl(),
    primary: names.find((n) => n.primary && !n.retiredAt)?.name ?? result.tenant.slug,
    // Only the originator manages addresses; others just see the live ones
    hostnames: result.membership.isOriginator ? names : names.filter((n) => !n.retiredAt),
    canManage: result.membership.isOriginator && !req.agentToken,
  });
});

async function resyncRoutes(tenantId: string): Promise<void> {
  await syncTenantRoutes().catch((err) => logger.error({ err }, "failed to sync Caddy routes after address change"));
  // Device names live under the tailnet's primary name
  await syncTenantAccess(tenantId);
}

hostnamesRouter.put("/api/tenants/:tenantId/hostnames/primary", requireAuth, stepUpForSession, async (req, res) => {
  const result = await getTenantForUser(param(req, "tenantId"), authUserId(req));
  if (!result) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  if (!result.membership.isOriginator || req.agentToken) {
    res.status(403).json({ error: "Only the tailnet's originator can change its address" });
    return;
  }
  const outcome = await setPrimaryHostname(result.tenant.id, (req.body ?? {}).name);
  if (!outcome.ok) {
    const e = ERRORS[outcome.error];
    res.status(e.status).json({ error: e.message, code: outcome.error });
    return;
  }
  await resyncRoutes(result.tenant.id);
  logAudit({
    tenantId: result.tenant.id,
    actorUserId: authUserId(req),
    action: "tenant_settings_updated",
    targetType: "tenant",
    targetId: result.tenant.id,
    metadata: { primaryAddress: outcome.name },
  });
  res.json({ primary: outcome.name, hostnames: await listHostnames(result.tenant.id) });
});

hostnamesRouter.delete("/api/tenants/:tenantId/hostnames/:name", requireAuth, stepUpForSession, async (req, res) => {
  const result = await getTenantForUser(param(req, "tenantId"), authUserId(req));
  if (!result) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  if (!result.membership.isOriginator || req.agentToken) {
    res.status(403).json({ error: "Only the tailnet's originator can change its address" });
    return;
  }
  const name = param(req, "name");
  if (!(await retireHostname(result.tenant.id, name))) {
    res.status(404).json({ error: "Not an active alias of this tailnet (the primary address cannot be retired)" });
    return;
  }
  await resyncRoutes(result.tenant.id);
  logAudit({
    tenantId: result.tenant.id,
    actorUserId: authUserId(req),
    action: "tenant_settings_updated",
    targetType: "tenant",
    targetId: result.tenant.id,
    metadata: { retiredAddress: name },
  });
  res.json({ hostnames: await listHostnames(result.tenant.id) });
});
