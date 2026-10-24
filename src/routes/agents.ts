/**
 * @module agents
 *
 * Agent token management — create, list, and revoke API tokens that allow
 * AI agents (or any programmatic client) to authenticate with the system.
 *
 * ## Token format
 *
 * Tokens are prefixed with `at_` followed by 64 hex characters (32 random
 * bytes). Only the SHA-256 hash is stored; the raw token is returned once
 * at creation. The first 8 characters of the raw token are stored as a
 * prefix for identification in the UI.
 *
 * ## Security model
 *
 * - Tokens are scoped to a **single tenant** and a **subset of permissions**.
 * - A token cannot grant a permission the creator's role doesn't have.
 * - The originator can always create tokens (when agent tokens are enabled).
 * - Non-originator members need `create_agent_tokens` **and** the tenant
 *   must have `allowMemberAgentTokens` enabled.
 * - Tokens carry a mandatory expiry (max 365 days).
 * - The `manage_agent_tokens` permission allows viewing and revoking any
 *   member's tokens; without it, members can only manage their own.
 *
 * ## Usage
 *
 * Agents authenticate by sending the token in the `Authorization` header:
 *
 * ```
 * Authorization: Bearer at_<hex>
 * ```
 *
 * The {@link resolveAgentToken} middleware in `helpers.ts` resolves the
 * token and populates the request context. All existing API endpoints work
 * transparently — the agent is subject to the intersection of the token's
 * scoped permissions and the user's role permissions.
 */

import { randomBytes, createHash } from "node:crypto";
import { Router } from "express";
import { eq, and, desc } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { agentTokens, users } from "../db/schema.js";
import {
  requireAuth,
  param,
  getTenantForUser,
  hasPermission,
} from "./helpers.js";
import { logAudit } from "./audit.js";
import { ALL_PERMISSIONS } from "./permissions.js";

export const agentsRouter = Router();

/** Maximum token lifetime: 365 days. */
const MAX_EXPIRY_DAYS = 365;

const createTokenBody = z.object({
  name: z.string().min(1).max(100),
  permissions: z.array(
    z.enum(ALL_PERMISSIONS as unknown as [string, ...string[]]),
  ),
  expiresInDays: z.number().int().min(1).max(MAX_EXPIRY_DAYS),
});

/**
 * `POST /api/tenants/:tenantId/agent-tokens`
 *
 * Creates a new agent API token. The raw token is returned **once** in the
 * response body — it cannot be retrieved later.
 *
 * @permission `create_agent_tokens` (or originator)
 * @setting `allowAgentTokens` must be enabled
 * @setting `allowMemberAgentTokens` must be enabled for non-originators
 */
agentsRouter.post(
  "/api/tenants/:tenantId/agent-tokens",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const userId = req.session.userId!;

    const result = await getTenantForUser(tenantId, userId);
    if (!result) {
      res.status(403).json({ error: "Not a member of this tenant" });
      return;
    }

    if (!result.tenant.allowAgentTokens) {
      res.status(403).json({ error: "Agent tokens are not enabled for this tenant" });
      return;
    }

    if (!result.membership.isOriginator) {
      if (!result.tenant.allowMemberAgentTokens) {
        res.status(403).json({ error: "Member agent tokens are not enabled" });
        return;
      }
      if (!hasPermission(result.membership, result.role, "create_agent_tokens", req)) {
        res.status(403).json({ error: "You do not have permission to create agent tokens" });
        return;
      }
    }

    const parsed = createTokenBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
      return;
    }

    // Validate that requested permissions don't exceed the creator's own permissions
    const userPerms = result.membership.isOriginator
      ? [...ALL_PERMISSIONS]
      : ((result.role?.permissions ?? []) as string[]);

    const exceeds = parsed.data.permissions.filter((p) => !userPerms.includes(p));
    if (exceeds.length > 0) {
      res.status(403).json({
        error: "Cannot grant permissions you don't have: " + exceeds.join(", "),
      });
      return;
    }

    const raw = "at_" + randomBytes(32).toString("hex");
    const hash = createHash("sha256").update(raw).digest("hex");
    const prefix = raw.slice(0, 11); // "at_" + 8 hex chars

    const expiresAt = new Date(
      Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000,
    );

    const [created] = await db
      .insert(agentTokens)
      .values({
        tenantId,
        userId,
        name: parsed.data.name,
        tokenHash: hash,
        tokenPrefix: prefix,
        permissions: parsed.data.permissions,
        expiresAt,
      })
      .returning();

    logAudit({
      tenantId,
      actorUserId: userId,
      action: "agent_token_created",
      targetType: "agent_token",
      targetId: created.id,
      metadata: {
        name: parsed.data.name,
        permissions: parsed.data.permissions,
        expiresInDays: parsed.data.expiresInDays,
      },
    });

    res.status(201).json({
      id: created.id,
      name: created.name,
      token: raw,
      tokenPrefix: prefix,
      permissions: created.permissions,
      expiresAt: created.expiresAt,
      createdAt: created.createdAt,
    });
  },
);

/**
 * `GET /api/tenants/:tenantId/agent-tokens`
 *
 * Lists agent tokens. Members see only their own tokens unless they have
 * the `manage_agent_tokens` permission.
 */
agentsRouter.get(
  "/api/tenants/:tenantId/agent-tokens",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const userId = req.session.userId!;

    const result = await getTenantForUser(tenantId, userId);
    if (!result) {
      res.status(403).json({ error: "Not a member of this tenant" });
      return;
    }

    const canManageAll = hasPermission(
      result.membership,
      result.role,
      "manage_agent_tokens",
      req,
    );

    const conditions = [eq(agentTokens.tenantId, tenantId)];
    if (!canManageAll) {
      conditions.push(eq(agentTokens.userId, userId));
    }

    const rows = await db
      .select({
        id: agentTokens.id,
        name: agentTokens.name,
        tokenPrefix: agentTokens.tokenPrefix,
        permissions: agentTokens.permissions,
        status: agentTokens.status,
        expiresAt: agentTokens.expiresAt,
        lastUsedAt: agentTokens.lastUsedAt,
        createdAt: agentTokens.createdAt,
        revokedAt: agentTokens.revokedAt,
        ownerHandle: users.handle,
        ownerDisplayName: users.displayName,
        ownerId: agentTokens.userId,
      })
      .from(agentTokens)
      .innerJoin(users, eq(agentTokens.userId, users.id))
      .where(and(...conditions))
      .orderBy(desc(agentTokens.createdAt))
      .limit(200);

    res.json(rows);
  },
);

/**
 * `DELETE /api/tenants/:tenantId/agent-tokens/:tokenId`
 *
 * Revokes an agent token. Members can revoke their own tokens; the
 * `manage_agent_tokens` permission is required to revoke others' tokens.
 */
agentsRouter.delete(
  "/api/tenants/:tenantId/agent-tokens/:tokenId",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const tokenId = param(req, "tokenId");
    const userId = req.session.userId!;

    const result = await getTenantForUser(tenantId, userId);
    if (!result) {
      res.status(403).json({ error: "Not a member of this tenant" });
      return;
    }

    const [token] = await db
      .select()
      .from(agentTokens)
      .where(
        and(
          eq(agentTokens.id, tokenId),
          eq(agentTokens.tenantId, tenantId),
        ),
      );

    if (!token) {
      res.status(404).json({ error: "Token not found" });
      return;
    }

    const isOwn = token.userId === userId;
    if (!isOwn && !hasPermission(result.membership, result.role, "manage_agent_tokens", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    await db
      .update(agentTokens)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(agentTokens.id, tokenId));

    logAudit({
      tenantId,
      actorUserId: userId,
      action: "agent_token_revoked",
      targetType: "agent_token",
      targetId: tokenId,
      metadata: { name: token.name, tokenOwnerId: token.userId },
    });

    res.json({ status: "revoked" });
  },
);
