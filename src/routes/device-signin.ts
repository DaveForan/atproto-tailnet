/**
 * @module routes/device-signin
 * Interactive device sign-in (ADR-0032). A device without an auth key is sent
 * to `/device/<id>`; the signed-in member chooses a tailnet and approves, and
 * the coordinator then lets the waiting device in as that member's device.
 *
 * Every check of the auth-key path applies: membership, lockdown, device
 * locks, the device limit and device approval.
 */

import { Router } from "express";
import { z } from "zod";
import { and, eq, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants, memberships } from "../db/schema.js";
import { config } from "../config.js";
import { requireSession, param, getTenantForUser, isLockedDown, isDeviceLocked, DEVICE_LOCKED_ERROR } from "./helpers.js";
import { logAudit } from "./audit.js";
import { logger } from "../logger.js";
import { enforceDeviceLimit } from "./limits.js";
import { CoordinatorApiClient } from "../orchestrator/coordinator-api.js";
import { getControlClient } from "../orchestrator/control-client.js";
import { pushTenantIdentity } from "../orchestrator/coordinator-identity.js";

export const deviceSignInRouter = Router();

const ID_RE = /^[0-9a-f]{32}$/;

/** Admin client for calls that are not scoped to one tenant. */
function coordinator(): CoordinatorApiClient | null {
  return config.coordinatorUrl ? new CoordinatorApiClient(config.coordinatorUrl, "", config.coordinatorApiKey) : null;
}

/** The pending sign-in and the tailnets the caller could add the device to. */
deviceSignInRouter.get("/api/device-auth/:id", requireSession, async (req, res) => {
  const id = param(req, "id");
  const coord = coordinator();
  if (!coord || !ID_RE.test(id)) {
    res.status(404).json({ error: "Sign-in link not found or expired" });
    return;
  }
  const pending = await coord.getDeviceAuth(id).catch(() => null);
  if (!pending?.pending) {
    res.status(404).json({ error: "Sign-in link not found or expired" });
    return;
  }
  const userId = req.session.userId!;
  const rows = await db
    .select({ tenant: tenants, isOriginator: memberships.isOriginator })
    .from(memberships)
    .innerJoin(tenants, eq(memberships.tenantId, tenants.id))
    .where(and(eq(memberships.userId, userId), ne(tenants.status, "deleted")))
    .orderBy(tenants.name)
    .limit(200);

  res.json({
    device: { hostname: pending.hostname, os: pending.os, fingerprint: pending.fingerprint },
    tailnets: rows
      .filter((r) => r.tenant.coordinatorTenantId && !r.tenant.suspended)
      // A machine already in a tailnet can only sign in to that tailnet again
      .filter((r) => !pending.registered_tenant_id || r.tenant.coordinatorTenantId === pending.registered_tenant_id)
      .map((r) => ({
        id: r.tenant.id,
        name: r.tenant.name,
        blocked: isLockedDown(r.tenant)
          ? "This tailnet is in lockdown"
          : r.tenant.requireDeviceApproval && !r.isOriginator
            ? "This tailnet requires device approval: ask for a key in the Add Device tab"
            : null,
      })),
  });
});

deviceSignInRouter.post("/api/device-auth/:id/approve", requireSession, async (req, res) => {
  const id = param(req, "id");
  const coord = coordinator();
  if (!coord || !ID_RE.test(id)) {
    res.status(404).json({ error: "Sign-in link not found or expired" });
    return;
  }
  const parsed = z.object({ tenantId: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "tenantId is required" });
    return;
  }
  const userId = req.session.userId!;
  const result = await getTenantForUser(parsed.data.tenantId, userId);
  if (!result || !result.tenant.coordinatorTenantId) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  if (isLockedDown(result.tenant)) {
    res.status(403).json({ error: "Tenant is in lockdown mode" });
    return;
  }
  if (result.tenant.requireDeviceApproval && !result.membership.isOriginator) {
    res.status(403).json({
      error: "This tailnet requires device approval. Ask for a key in the Add Device tab",
      code: "approval_required",
    });
    return;
  }
  if (await isDeviceLocked(result.tenant.id, userId)) {
    res.status(403).json({ error: DEVICE_LOCKED_ERROR });
    return;
  }
  if (!(await enforceDeviceLimit(res, result.tenant, getControlClient(result.tenant)))) return;

  // So the device shows the tailnet name and the member's handle at once
  await pushTenantIdentity(result.tenant.id, result.tenant.coordinatorTenantId).catch((err) =>
    logger.warn({ tenantId: result.tenant.id, err }, "failed to push tenant identity"),
  );
  try {
    await coord.approveDeviceAuth(id, result.tenant.coordinatorTenantId, userId);
  } catch {
    res.status(404).json({ error: "Sign-in link not found, expired or already used" });
    return;
  }
  logAudit({
    tenantId: result.tenant.id,
    actorUserId: userId,
    action: "tenant_settings_updated",
    targetType: "tenant",
    targetId: result.tenant.id,
    metadata: { operation: "device_signed_in" },
  });
  res.json({ status: "approved", tailnet: result.tenant.name });
});

deviceSignInRouter.post("/api/device-auth/:id/deny", requireSession, async (req, res) => {
  const id = param(req, "id");
  const coord = coordinator();
  if (!coord || !ID_RE.test(id)) {
    res.status(404).json({ error: "Sign-in link not found or expired" });
    return;
  }
  await coord.denyDeviceAuth(id).catch(() => {});
  res.json({ status: "denied" });
});
