/**
 * @module routes/settings
 * Tenant settings toggles and the notification webhook. Entering lockdown revokes outstanding keys.
 */

import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { tenants, memberships } from "../db/schema.js";
import { getCoordinatorClient } from "../orchestrator/control-client.js";
import { requireAuth, hasPermission, authUserId, sendNotApplied } from "./helpers.js";
import { tenantGuard, tenantCtx } from "./guard.js";
import { logAudit } from "../audit/log.js";
import { logger } from "../logger.js";
import { config } from "../config.js";
import { validateWebhookUrl } from "../notifications/webhook.js";
import { revokeAllTenantKeys } from "../access/keys.js";
import { parseBody } from "./validation.js";
import { syncTenantAccess } from "../access/sync.js";
import { refuseStepUp, stepUpMissing } from "../auth/step-up.js";

export const settingsRouter = Router({ caseSensitive: true });

const settingsBody = z.object({
  requireDeviceApproval: z.boolean().optional(),
  lockdownMode: z.boolean().optional(),
  allowJoinRequests: z.boolean().optional(),
  boardEnabled: z.boolean().optional(),
  maxBoardPosts: z.number().int().min(1).max(200).optional(),
  maxBoardPostsDisplayed: z.number().int().min(1).max(200).optional(),
  requireServiceApproval: z.boolean().optional(),
  requireServiceDeviceApproval: z.boolean().optional(),
  allowAgentTokens: z.boolean().optional(),
  allowMemberAgentTokens: z.boolean().optional(),
  /** https only (unless WEBHOOK_ALLOW_PRIVATE); null/"" clears it. */
  notificationWebhookUrl: z.string().max(2048).nullable().optional(),
  /** Write-only; null/"" clears it. */
  notificationWebhookSecret: z.string().max(256).nullable().optional(),
});

/**
 * Settings that change who may get in, be told or publish without review: never from an agent token, and a session needs step-up.
 * Security: an agent token with manage_settings must not open the tailnet or redirect its notifications.
 */
export const SENSITIVE_SETTINGS = [
  "lockdownMode",
  "allowAgentTokens",
  "allowMemberAgentTokens",
  "notificationWebhookUrl",
  "notificationWebhookSecret",
  "requireDeviceApproval",
  "allowJoinRequests",
  "requireServiceApproval",
] as const;

/** Settings response; the webhook URL is shown only to settings managers, the secret never. */
function settingsView(
  t: typeof tenants.$inferSelect,
  canManage: boolean,
) {
  return {
    requireDeviceApproval: t.requireDeviceApproval,
    lockdownMode: t.lockdownMode,
    allowJoinRequests: t.allowJoinRequests,
    boardEnabled: t.boardEnabled,
    maxBoardPosts: t.maxBoardPosts,
    maxBoardPostsDisplayed: t.maxBoardPostsDisplayed,
    requireServiceApproval: t.requireServiceApproval,
    requireServiceDeviceApproval: t.requireServiceDeviceApproval,
    allowAgentTokens: t.allowAgentTokens,
    allowMemberAgentTokens: t.allowMemberAgentTokens,
    defaultRoleId: t.defaultRoleId,
    notificationWebhookUrl: canManage ? (t.notificationWebhookUrl ?? null) : null,
    hasWebhookSecret: Boolean(t.notificationWebhookSecret),
  };
}


settingsRouter.get(
  "/api/tenants/:tenantId/settings",
  requireAuth,
  tenantGuard(),
  async (req, res) => {
    const result = tenantCtx(res);

    res.json(
      settingsView(
        result.tenant,
        hasPermission(result.membership, result.role, "manage_settings", req),
      ),
    );
  },
);

settingsRouter.patch(
  "/api/tenants/:tenantId/settings",
  requireAuth,
  tenantGuard({ permission: "manage_settings" }),
  async (req, res) => {
    const result = tenantCtx(res);

    const parsed = parseBody(settingsBody, req, res);
    if (!parsed) return;

    const sensitive = SENSITIVE_SETTINGS.filter((k) => parsed.data[k] !== undefined);
    if (sensitive.length > 0) {
      if (req.agentToken) {
        res.status(403).json({ error: "Agent tokens cannot change security settings", settings: sensitive });
        return;
      }
      if (stepUpMissing(req)) {
        refuseStepUp(req, res);
        return;
      }
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (parsed.data.notificationWebhookUrl !== undefined) {
      const url = parsed.data.notificationWebhookUrl?.trim() || null;
      if (url) {
        const invalid = await validateWebhookUrl(url, {
          allowPrivate: config.webhookAllowPrivate,
        });
        if (invalid) {
          res.status(400).json({ error: invalid });
          return;
        }
      }
      updates.notificationWebhookUrl = url;
    }
    if (parsed.data.notificationWebhookSecret !== undefined) {
      updates.notificationWebhookSecret = parsed.data.notificationWebhookSecret || null;
    }

    // The body is valid from here on.
    // Security: the coordinator must stop key-only admission before the setting says it did.
    // Nothing is saved when the push fails, so the caller can try again.
    const secondApprovalOn = parsed.data.requireDeviceApproval === true && !result.tenant.requireDeviceApproval;
    if (secondApprovalOn && !(await syncTenantAccess(result.tenant.id, { secondApproval: true }))) {
      sendNotApplied(res);
      return;
    }
    if (
      parsed.data.notificationWebhookUrl !== undefined ||
      parsed.data.notificationWebhookSecret !== undefined
    ) {
      logAudit({
        tenantId: result.tenant.id,
        actorUserId: authUserId(req),
        action: "notification_settings_updated",
        targetType: "tenant",
        targetId: result.tenant.id,
        // Never log the secret or the URL (it may embed a token)
        metadata: {
          webhookUrlSet: updates.notificationWebhookUrl !== undefined ? Boolean(updates.notificationWebhookUrl) : undefined,
          webhookSecretChanged: parsed.data.notificationWebhookSecret !== undefined,
        },
      });
    }

    if (parsed.data.requireDeviceApproval !== undefined) {
      updates.requireDeviceApproval = parsed.data.requireDeviceApproval;
      logAudit({
        tenantId: result.tenant.id,
        actorUserId: authUserId(req),
        action: "tenant_settings_updated",
        targetType: "tenant",
        targetId: result.tenant.id,
        metadata: { requireDeviceApproval: parsed.data.requireDeviceApproval },
      });
    }

    if (parsed.data.lockdownMode !== undefined) {
      updates.lockdownMode = parsed.data.lockdownMode;
      logAudit({
        tenantId: result.tenant.id,
        actorUserId: authUserId(req),
        action: parsed.data.lockdownMode ? "lockdown_enabled" : "lockdown_disabled",
        targetType: "tenant",
        targetId: result.tenant.id,
      });
    }

    if (parsed.data.allowJoinRequests !== undefined) {
      updates.allowJoinRequests = parsed.data.allowJoinRequests;
      logAudit({
        tenantId: result.tenant.id,
        actorUserId: authUserId(req),
        action: parsed.data.allowJoinRequests ? "join_requests_enabled" : "join_requests_disabled",
        targetType: "tenant",
        targetId: result.tenant.id,
      });
    }

    if (parsed.data.boardEnabled !== undefined) {
      updates.boardEnabled = parsed.data.boardEnabled;
      logAudit({
        tenantId: result.tenant.id,
        actorUserId: authUserId(req),
        action: parsed.data.boardEnabled ? "board_enabled" : "board_disabled",
        targetType: "tenant",
        targetId: result.tenant.id,
      });
    }

    if (parsed.data.maxBoardPosts !== undefined || parsed.data.maxBoardPostsDisplayed !== undefined) {
      if (parsed.data.maxBoardPosts !== undefined) updates.maxBoardPosts = parsed.data.maxBoardPosts;
      if (parsed.data.maxBoardPostsDisplayed !== undefined) updates.maxBoardPostsDisplayed = parsed.data.maxBoardPostsDisplayed;
      logAudit({
        tenantId: result.tenant.id,
        actorUserId: authUserId(req),
        action: "board_settings_updated",
        targetType: "tenant",
        targetId: result.tenant.id,
        metadata: { maxBoardPosts: parsed.data.maxBoardPosts, maxBoardPostsDisplayed: parsed.data.maxBoardPostsDisplayed },
      });
    }

    if (parsed.data.requireServiceApproval !== undefined) {
      updates.requireServiceApproval = parsed.data.requireServiceApproval;
      logAudit({
        tenantId: result.tenant.id,
        actorUserId: authUserId(req),
        action: "tenant_settings_updated",
        targetType: "tenant",
        targetId: result.tenant.id,
        metadata: { requireServiceApproval: parsed.data.requireServiceApproval },
      });
    }

    if (parsed.data.requireServiceDeviceApproval !== undefined) {
      updates.requireServiceDeviceApproval = parsed.data.requireServiceDeviceApproval;
      logAudit({
        tenantId: result.tenant.id,
        actorUserId: authUserId(req),
        action: "tenant_settings_updated",
        targetType: "tenant",
        targetId: result.tenant.id,
        metadata: { requireServiceDeviceApproval: parsed.data.requireServiceDeviceApproval },
      });
    }

    if (parsed.data.allowAgentTokens !== undefined) {
      updates.allowAgentTokens = parsed.data.allowAgentTokens;
      logAudit({
        tenantId: result.tenant.id,
        actorUserId: authUserId(req),
        action: "tenant_settings_updated",
        targetType: "tenant",
        targetId: result.tenant.id,
        metadata: { allowAgentTokens: parsed.data.allowAgentTokens },
      });
    }

    if (parsed.data.allowMemberAgentTokens !== undefined) {
      updates.allowMemberAgentTokens = parsed.data.allowMemberAgentTokens;
      logAudit({
        tenantId: result.tenant.id,
        actorUserId: authUserId(req),
        action: "tenant_settings_updated",
        targetType: "tenant",
        targetId: result.tenant.id,
        metadata: { allowMemberAgentTokens: parsed.data.allowMemberAgentTokens },
      });
    }

    await db
      .update(tenants)
      .set(updates)
      .where(eq(tenants.id, result.tenant.id));

    // A change of the second approval turns every member's own approval on, so no earlier choice comes back.
    if (parsed.data.requireDeviceApproval !== undefined && parsed.data.requireDeviceApproval !== result.tenant.requireDeviceApproval) {
      await db.update(memberships).set({ approveOwnDevices: true }).where(eq(memberships.tenantId, result.tenant.id));
      // Turning it off: a failure here leaves the coordinator stricter than the setting, and the next push corrects it
      if (!secondApprovalOn) await syncTenantAccess(result.tenant.id);
    }

    // Entering lockdown also revokes keys already handed out, so a leaked
    // reusable key can't keep enrolling devices during the lockdown.
    if (parsed.data.lockdownMode === true && !result.tenant.lockdownMode) {
      // Lockdown is already on at this point; a revocation failure is logged,
      // never turned into an error response.
      try {
        const client = getCoordinatorClient(result.tenant);
        const keysRevoked = await revokeAllTenantKeys(result.tenant.id, client);
        logAudit({
          tenantId: result.tenant.id,
          actorUserId: authUserId(req),
          action: "tenant_settings_updated",
          targetType: "tenant",
          targetId: result.tenant.id,
          metadata: { lockdownKeysRevoked: keysRevoked },
        });
      } catch (err) {
        logger.error({ tenantId: result.tenant.id, err }, "lockdown: failed to revoke outstanding keys");
      }
    }

    const [updated] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, result.tenant.id));

    res.json(settingsView(updated, true));
  },
);
