/**
 * @module routes/device-signin
 * Interactive device sign-in (ADR-0032): a member approves a waiting device at `/device/<id>`.
 * The auth-key checks apply (membership, lockdown, device limit, approval); Headscale device locks do not.
 */

import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { and, eq, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants, memberships } from "../db/schema.js";
import { requireSession, param, getTenantForUser, isLockedDown } from "./helpers.js";
import { logAudit } from "../audit/log.js";
import { logger } from "../logger.js";
import { sendDeviceRefusal } from "./limits.js";
import { deviceAdmission } from "../access/admission.js";
import type { CoordinatorApiClient } from "../orchestrator/coordinator-api.js";
import { getCoordinatorClient, useCoordinator } from "../orchestrator/control-client.js";
import { pushTenantIdentity } from "../orchestrator/coordinator-identity.js";
import { stepUpForSession } from "../auth/step-up.js";

export const deviceSignInRouter = Router({ caseSensitive: true });

const ID_RE = /^[0-9a-f]{32}$/;

/** Lifetime of a pending sign-in in the coordinator (`coord_core::signin::SIGN_IN_TTL_SECS`). */
export const SIGN_IN_TTL_MS = 10 * 60 * 1000;

/** The coordinator's pending sign-in, with where and when the device asked. */
type PendingSignIn = Awaited<ReturnType<CoordinatorApiClient["getDeviceAuth"]>> & {
  requester_ip?: string | null;
  requested_at?: string;
};

/** True when the coordinator's `requested_at` is older than the sign-in lifetime. */
export function signInExpired(requestedAt: string | undefined, now = Date.now()): boolean {
  if (!requestedAt) return false; // older coordinator: it enforces the expiry itself
  const at = Date.parse(requestedAt);
  return !Number.isFinite(at) || now - at >= SIGN_IN_TTL_MS;
}

/**
 * Per-user limits: a phishing campaign sends many links, and each look or
 * approval is one request. Legitimate use is a few devices at a time.
 */
const perUser = (limit: number) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many device sign-ins, try again later" },
    keyGenerator: (req) => `device-signin:${req.session.userId}`,
  });
export const DEVICE_SIGNIN_VIEW_LIMIT = 30;
export const DEVICE_SIGNIN_APPROVE_LIMIT = 10;
const viewLimiter = perUser(DEVICE_SIGNIN_VIEW_LIMIT);
const approveLimiter = perUser(DEVICE_SIGNIN_APPROVE_LIMIT);

/** Admin client for calls that are not scoped to one tenant. */
function coordinator(): CoordinatorApiClient | null {
  return useCoordinator ? getCoordinatorClient() : null;
}

/** The pending sign-in and the tailnets the caller could add the device to. */
deviceSignInRouter.get("/api/device-auth/:id", requireSession, viewLimiter, async (req, res) => {
  const id = param(req, "id");
  const coord = coordinator();
  if (!coord || !ID_RE.test(id)) {
    res.status(404).json({ error: "Sign-in link not found or expired" });
    return;
  }
  const pending = (await coord.getDeviceAuth(id).catch(() => null)) as PendingSignIn | null;
  if (!pending?.pending || signInExpired(pending.requested_at)) {
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
    // So the user can tell whether the request came from their own machine (phishing, ADR-0032)
    requesterIp: pending.requester_ip ?? null,
    requestedAt: pending.requested_at ?? null,
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

deviceSignInRouter.post("/api/device-auth/:id/approve", requireSession, approveLimiter, stepUpForSession, async (req, res) => {
  const id = param(req, "id");
  const coord = coordinator();
  if (!coord || !ID_RE.test(id)) {
    res.status(404).json({ error: "Sign-in link not found or expired" });
    return;
  }
  const parsed = z.object({ tenantId: z.string().uuid(), confirm: z.literal(true) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "tenantId is required, and confirm that you just started the sign-in on this device",
      code: "confirm_required",
    });
    return;
  }
  // Re-read the sign-in: an old link (for example one sent by someone else) is refused
  const pending = (await coord.getDeviceAuth(id).catch(() => null)) as PendingSignIn | null;
  if (!pending?.pending || signInExpired(pending.requested_at)) {
    res.status(404).json({ error: "Sign-in link not found, expired or already used" });
    return;
  }
  const userId = req.session.userId!;
  const result = await getTenantForUser(parsed.data.tenantId, userId);
  if (!result || !result.tenant.coordinatorTenantId) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  const refusal = await deviceAdmission(result.tenant, result.membership, userId);
  if (refusal) {
    sendDeviceRefusal(res, result.tenant, refusal);
    return;
  }

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
    action: "device_signin_approved",
    targetType: "tenant",
    targetId: result.tenant.id,
    metadata: {
      fingerprint: pending.fingerprint,
      hostname: pending.hostname,
      requesterIp: pending.requester_ip ?? null,
      requestedAt: pending.requested_at ?? null,
    },
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
