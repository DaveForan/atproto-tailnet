/**
 * @module routes/operator
 * Instance-operator API (`/api/operator/*`, guarded by requireOperator:
 * session or MCP token of an OPERATOR_DIDS user, never agent tokens) and the
 * public instance descriptor (`GET /api/instance`). Every operator action is
 * audit-logged (tenant-scoped actions under the tenant, instance-level ones
 * with a NULL tenant).
 */

import { Router } from "express";
import { z } from "zod";
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  auditLogs,
  memberships,
  tailnetCreators,
  tenants,
  usageSnapshots,
  users,
} from "../db/schema.js";
import { requireOperator } from "../operator/auth.js";
import {
  getInstanceSettings,
  isOperatorDid,
  listTopLevelTenants,
  updateInstanceSettings,
} from "../operator/policy.js";
import {
  disableUser,
  enableUser,
  OperatorActionError,
  setTenantSuspendedCascade,
} from "../operator/lifecycle.js";
import { authUserId, param } from "./helpers.js";
import { logAudit } from "./audit.js";
import { deleteTenantInstance } from "./api.js";
import { ACCOUNT_DID_RE, normalizeAccountDid, resolveDidToHandle, resolveHandleToDid } from "./invitations.js";
import { logger } from "../logger.js";

/** Router for /api/operator/* (all routes behind requireOperator). */
export const operatorRouter = Router();

/** Public instance descriptor — mount before agent-token resolution. */
export const instanceRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

operatorRouter.use("/api/operator", requireOperator);

// ── Public: instance descriptor ─────────────────────────────────────

/**
 * What a signed-out or no-access visitor needs: the default tailnet (if any,
 * with `id` so the client can use the existing join-request API) and whether
 * it accepts join requests. The instance is always invite-only.
 */
instanceRouter.get("/api/instance", async (_req, res) => {
  const settings = await getInstanceSettings();
  let defaultTailnet: {
    id: string;
    slug: string;
    name: string;
    acceptsJoinRequests: boolean;
  } | null = null;
  if (settings.defaultTailnetId) {
    const [t] = await db
      .select({
        id: tenants.id,
        slug: tenants.slug,
        name: tenants.name,
        status: tenants.status,
        suspended: tenants.suspended,
        allowJoinRequests: tenants.allowJoinRequests,
        lockdownMode: tenants.lockdownMode,
      })
      .from(tenants)
      .where(eq(tenants.id, settings.defaultTailnetId));
    if (t && t.status !== "deleted" && !t.suspended) {
      defaultTailnet = {
        id: t.id,
        slug: t.slug,
        name: t.name,
        acceptsJoinRequests: t.allowJoinRequests && !t.lockdownMode,
      };
    }
  }
  res.json({ defaultTailnet, inviteOnly: true });
});

// ── Overview ────────────────────────────────────────────────────────

operatorRouter.get("/api/operator/overview", async (_req, res) => {
  const tenantRows = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      status: tenants.status,
      suspended: tenants.suspended,
      parentId: tenants.parentId,
      createdAt: tenants.createdAt,
      ownerUserId: tenants.ownerUserId,
      ownerDid: users.did,
      ownerHandle: users.handle,
    })
    .from(tenants)
    .leftJoin(users, eq(tenants.ownerUserId, users.id))
    .where(ne(tenants.status, "deleted"))
    .orderBy(desc(tenants.createdAt))
    .limit(200);

  const tenantIds = tenantRows.map((t) => t.id);
  const memberCounts = new Map<string, number>();
  const deviceCounts = new Map<string, number>();
  if (tenantIds.length > 0) {
    const mc = await db
      .select({ tenantId: memberships.tenantId, count: sql<number>`count(*)::int` })
      .from(memberships)
      .where(inArray(memberships.tenantId, tenantIds))
      .groupBy(memberships.tenantId);
    for (const r of mc) memberCounts.set(r.tenantId, r.count);

    // Latest usage snapshot (every 5 min) — no live control-plane calls here
    const dc = await db
      .selectDistinctOn([usageSnapshots.tenantId], {
        tenantId: usageSnapshots.tenantId,
        deviceCount: usageSnapshots.deviceCount,
      })
      .from(usageSnapshots)
      .where(inArray(usageSnapshots.tenantId, tenantIds))
      .orderBy(usageSnapshots.tenantId, desc(usageSnapshots.recordedAt));
    for (const r of dc) deviceCounts.set(r.tenantId, r.deviceCount);
  }

  const userRows = await db
    .select({
      id: users.id,
      did: users.did,
      handle: users.handle,
      createdAt: users.createdAt,
      disabledAt: users.disabledAt,
      tenantCount: sql<number>`(select count(*)::int from ${memberships} m join ${tenants} t on t.id = m.tenant_id where m.user_id = ${users}.id and t.status <> 'deleted')`,
    })
    .from(users)
    .orderBy(desc(users.createdAt))
    .limit(200);

  res.json({
    tenants: tenantRows.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      status: t.status,
      suspended: t.suspended,
      parentId: t.parentId ?? null,
      createdAt: t.createdAt,
      owner: t.ownerDid
        ? { userId: t.ownerUserId, did: t.ownerDid, handle: t.ownerHandle }
        : null,
      memberCount: memberCounts.get(t.id) ?? 0,
      deviceCount: deviceCounts.get(t.id) ?? null,
    })),
    users: userRows.map((u) => ({
      id: u.id,
      did: u.did,
      handle: u.handle,
      createdAt: u.createdAt,
      disabled: u.disabledAt !== null,
      tenantCount: u.tenantCount,
      isOperator: isOperatorDid(u.did),
    })),
    settings: await getInstanceSettings(),
  });
});

// ── Settings ────────────────────────────────────────────────────────

operatorRouter.get("/api/operator/settings", async (_req, res) => {
  res.json(await getInstanceSettings());
});

const settingsBody = z
  .object({
    singleTailnet: z.boolean().optional(),
    defaultTailnetId: z.string().regex(UUID_RE, "must be a UUID").nullable().optional(),
  })
  .strict();

operatorRouter.put("/api/operator/settings", async (req, res) => {
  const parsed = settingsBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
    return;
  }
  const patch = parsed.data;

  if (patch.defaultTailnetId) {
    const [t] = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(
        and(
          eq(tenants.id, patch.defaultTailnetId),
          isNull(tenants.parentId),
          ne(tenants.status, "deleted"),
        ),
      );
    if (!t) {
      res.status(400).json({ error: "Default tailnet must be an existing top-level tailnet" });
      return;
    }
  }

  if (patch.singleTailnet === true) {
    const top = await listTopLevelTenants();
    if (top.length > 1) {
      res.status(409).json({
        error: "Single-tailnet mode needs at most one top-level tailnet; delete the others first",
        code: "single_tailnet",
        tenants: top,
      });
      return;
    }
  }

  const before = await getInstanceSettings();
  const after = await updateInstanceSettings(patch);
  // Owner intent: uninvited people can request to join the default tailnet
  let joinRequestsEnabledOn: string | null = null;
  if (patch.defaultTailnetId && patch.defaultTailnetId !== before.defaultTailnetId) {
    await db
      .update(tenants)
      .set({ allowJoinRequests: true, updatedAt: new Date() })
      .where(eq(tenants.id, patch.defaultTailnetId));
    joinRequestsEnabledOn = patch.defaultTailnetId;
  }
  logAudit({
    tenantId: null,
    actorUserId: authUserId(req),
    action: "operator_settings_updated",
    targetType: "instance",
    metadata: { before, after, joinRequestsEnabledOn },
  });
  res.json({ ...after, defaultTailnetAcceptsJoinRequests: after.defaultTailnetId ? (joinRequestsEnabledOn !== null || (await defaultAcceptsJoins(after.defaultTailnetId))) : false });
});

async function defaultAcceptsJoins(id: string): Promise<boolean> {
  const [t] = await db.select({ a: tenants.allowJoinRequests }).from(tenants).where(eq(tenants.id, id));
  return Boolean(t?.a);
}

// ── Tailnet creators ────────────────────────────────────────────────

operatorRouter.get("/api/operator/tailnet-creators", async (_req, res) => {
  const rows = await db
    .select({
      id: tailnetCreators.id,
      did: tailnetCreators.did,
      handle: tailnetCreators.handle,
      addedBy: tailnetCreators.addedByUserId,
      createdAt: tailnetCreators.createdAt,
      hasTailnet: sql<boolean>`exists (select 1 from ${tenants} t join ${users} u on u.id = t.owner_user_id where u.did = ${tailnetCreators}.did and t.parent_id is null and t.status <> 'deleted')`,
    })
    .from(tailnetCreators)
    .orderBy(desc(tailnetCreators.createdAt))
    .limit(200);
  res.json({ creators: rows });
});

const creatorBody = z
  .object({ did: z.string().trim().optional(), handle: z.string().trim().optional() })
  .strict();

operatorRouter.post("/api/operator/tailnet-creators", async (req, res) => {
  const parsed = creatorBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
    return;
  }
  const { did: didIn, handle: handleIn } = parsed.data;
  if (Boolean(didIn) === Boolean(handleIn)) {
    res.status(400).json({ error: "Provide exactly one of did or handle" });
    return;
  }

  let did: string;
  let handle: string | null;
  if (didIn) {
    if (!ACCOUNT_DID_RE.test(didIn)) {
      res.status(400).json({ error: "did must be a did:plc or did:web identifier" });
      return;
    }
    did = normalizeAccountDid(didIn);
    handle = await resolveDidToHandle(did);
  } else {
    handle = handleIn!.replace(/^@/, "");
    const resolved = await resolveHandleToDid(handle);
    if (!resolved) {
      res.status(404).json({ error: `Could not resolve handle: ${handle}` });
      return;
    }
    did = normalizeAccountDid(resolved);
  }

  const [created] = await db
    .insert(tailnetCreators)
    .values({ did, handle, addedByUserId: authUserId(req) })
    .onConflictDoNothing()
    .returning();
  if (!created) {
    res.status(409).json({ error: "Already a tailnet creator" });
    return;
  }

  logAudit({
    tenantId: null,
    actorUserId: authUserId(req),
    action: "tailnet_creator_added",
    targetType: "tailnet_creator",
    targetId: created.id,
    metadata: { did, handle },
  });

  res.status(201).json({
    id: created.id,
    did: created.did,
    handle: created.handle,
    addedBy: created.addedByUserId,
    createdAt: created.createdAt,
    hasTailnet: false,
  });
});

operatorRouter.delete("/api/operator/tailnet-creators/:id", async (req, res) => {
  const id = param(req, "id");
  if (!UUID_RE.test(id)) {
    res.status(404).json({ error: "Creator not found" });
    return;
  }
  const [removed] = await db
    .delete(tailnetCreators)
    .where(eq(tailnetCreators.id, id))
    .returning();
  if (!removed) {
    res.status(404).json({ error: "Creator not found" });
    return;
  }
  logAudit({
    tenantId: null,
    actorUserId: authUserId(req),
    action: "tailnet_creator_removed",
    targetType: "tailnet_creator",
    targetId: removed.id,
    metadata: { did: removed.did, handle: removed.handle },
  });
  res.json({ status: "removed" });
});

// ── Tenants ─────────────────────────────────────────────────────────

async function loadTenant(id: string) {
  if (!UUID_RE.test(id)) return null;
  const [t] = await db.select().from(tenants).where(eq(tenants.id, id));
  return t && t.status !== "deleted" ? t : null;
}

for (const action of ["suspend", "unsuspend"] as const) {
  operatorRouter.post(`/api/operator/tenants/:id/${action}`, async (req, res) => {
    const tenant = await loadTenant(param(req, "id"));
    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }
    const suspended = action === "suspend";
    try {
      // Suspension cascades to sub-tailnets; unsuspend restores those it cascaded to.
      const result = await setTenantSuspendedCascade(tenant, suspended);
      const actorUserId = authUserId(req);
      logAudit({
        tenantId: tenant.id,
        actorUserId,
        action: suspended ? "tenant_suspended" : "tenant_unsuspended",
        targetType: "tenant",
        targetId: tenant.id,
        metadata: { slug: tenant.slug, cascaded: result.cascaded },
      });
      for (const childId of result.cascaded) {
        logAudit({
          tenantId: childId,
          actorUserId,
          action: suspended ? "tenant_suspended" : "tenant_unsuspended",
          targetType: "tenant",
          targetId: childId,
          metadata: { cascadeFrom: tenant.id },
        });
      }
      const body = {
        id: result.tenant.id,
        status: result.tenant.status,
        suspended: result.tenant.suspended,
        cascaded: result.cascaded,
        failed: result.failed,
      };
      if (result.failed.length > 0) {
        res.status(502).json({
          ...body,
          error: `Failed to ${action} ${result.failed.length} sub-tailnet(s) on the control plane; retry`,
          code: "cascade_incomplete",
        });
        return;
      }
      res.json(body);
    } catch (err) {
      if (err instanceof OperatorActionError) {
        res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
        return;
      }
      logger.error({ tenantId: tenant.id, err }, `failed to ${action} tenant`);
      res.status(502).json({ error: `Failed to ${action} tenant on the control plane` });
    }
  });
}

/** Operator override of the tenant delete path (no originator requirement). */
operatorRouter.delete("/api/operator/tenants/:id", async (req, res) => {
  const tenant = await loadTenant(param(req, "id"));
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  const [child] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(eq(tenants.parentId, tenant.id), ne(tenants.status, "deleted")))
    .limit(1);
  if (child) {
    res.status(409).json({ error: "Delete or detach its sub-collectives first", code: "has_children" });
    return;
  }
  try {
    await deleteTenantInstance(tenant);
    logAudit({
      tenantId: tenant.id,
      actorUserId: authUserId(req),
      action: "tenant_deleted_by_operator",
      targetType: "tenant",
      targetId: tenant.id,
      metadata: { slug: tenant.slug, name: tenant.name },
    });
    res.json({ status: "deleted" });
  } catch (err) {
    logger.error({ tenantId: tenant.id, err }, "operator tenant delete failed");
    res.status(502).json({ error: "Failed to delete tenant" });
  }
});

// ── Instance activity (audit) ───────────────────────────────────────

/** Tenant-scoped audit actions that are operator actions (shown with instance rows). */
const OPERATOR_TENANT_ACTIONS = ["tenant_suspended", "tenant_unsuspended", "tenant_deleted_by_operator"] as const;

const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

/**
 * Instance activity: every instance-level audit row (tenant_id NULL —
 * operator settings/creators/user actions, MCP grants) plus operator actions
 * logged under a tenant. Newest first, paginated.
 */
operatorRouter.get("/api/operator/audit", async (req, res) => {
  const parsed = auditQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.issues });
    return;
  }
  const { limit, offset } = parsed.data;
  const rows = await db
    .select({
      id: auditLogs.id,
      tenantId: auditLogs.tenantId,
      tenantSlug: tenants.slug,
      actorUserId: auditLogs.actorUserId,
      actorHandle: users.handle,
      action: auditLogs.action,
      targetType: auditLogs.targetType,
      targetId: auditLogs.targetId,
      metadata: auditLogs.metadata,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.actorUserId, users.id))
    .leftJoin(tenants, eq(auditLogs.tenantId, tenants.id))
    .where(or(isNull(auditLogs.tenantId), inArray(auditLogs.action, [...OPERATOR_TENANT_ACTIONS])))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(limit + 1)
    .offset(offset);
  res.json({
    entries: rows.slice(0, limit).map((r) => ({
      ...r,
      tenantSlug: r.tenantSlug ?? null,
      actorHandle: r.actorHandle ?? null,
    })),
    limit,
    offset,
    hasMore: rows.length > limit,
  });
});

// ── Users ───────────────────────────────────────────────────────────

operatorRouter.post("/api/operator/users/:id/disable", async (req, res) => {
  const targetId = param(req, "id");
  const actorId = authUserId(req);
  if (!UUID_RE.test(targetId)) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const [target] = await db.select().from(users).where(eq(users.id, targetId));
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (target.id === actorId) {
    res.status(400).json({ error: "You cannot disable yourself" });
    return;
  }
  if (isOperatorDid(target.did)) {
    res.status(403).json({ error: "Operators cannot be disabled (remove them from OPERATOR_DIDS first)" });
    return;
  }
  if (target.disabledAt) {
    res.status(409).json({ error: "User is already disabled" });
    return;
  }

  const result = await disableUser(target.id, actorId);
  logAudit({
    tenantId: null,
    actorUserId: actorId,
    action: "user_disabled",
    targetType: "user",
    targetId: target.id,
    metadata: {
      did: target.did,
      handle: target.handle,
      removedFrom: result.removedFrom.map((r) => r.tenantId),
      ownedTenants: result.ownedTenants.map((r) => r.tenantId),
      agentTokensRevoked: result.agentTokensRevoked,
      mcpGrantsRevoked: result.mcpGrantsRevoked,
      joinRequestsCancelled: result.joinRequestsCancelled,
      invitationsRevoked: result.invitationsRevoked,
    },
  });
  res.json({ status: "disabled", ...result });
});

operatorRouter.post("/api/operator/users/:id/enable", async (req, res) => {
  const targetId = param(req, "id");
  if (!UUID_RE.test(targetId)) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const [target] = await db.select().from(users).where(eq(users.id, targetId));
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  await enableUser(target.id);
  logAudit({
    tenantId: null,
    actorUserId: authUserId(req),
    action: "user_enabled",
    targetType: "user",
    targetId: target.id,
    metadata: { did: target.did, handle: target.handle },
  });
  res.json({ status: "enabled" });
});
