/**
 * @module routes/federation
 * Federation link management between tailnets. Allows tenants to establish
 * trust relationships with shared CIDR exposure. The requester sends a
 * federation request to a target tenant by slug; the target's originator
 * or manage_settings holder accepts/rejects. Either side can revoke.
 * Gated by the "manage_settings" permission.
 */

import { Router } from "express";
import { z } from "zod";
import { eq, or, and, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants, federationLinks } from "../db/schema.js";
import {
  requireAuth,
  param,
  getTenantForUser,
  hasPermission,
  authUserId,
} from "./helpers.js";
import { logAudit } from "./audit.js";
import { logger } from "../logger.js";

export const federationRouter = Router();

federationRouter.get(
  "/api/tenants/:tenantId/federation",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (
      !hasPermission(result.membership, result.role, "manage_settings", req)
    ) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const links = await db
      .select({
        id: federationLinks.id,
        requesterTenantId: federationLinks.requesterTenantId,
        targetTenantId: federationLinks.targetTenantId,
        status: federationLinks.status,
        message: federationLinks.message,
        requesterCidrs: federationLinks.requesterCidrs,
        targetCidrs: federationLinks.targetCidrs,
        createdAt: federationLinks.createdAt,
        updatedAt: federationLinks.updatedAt,
        requesterSlug: tenants.slug,
        requesterName: tenants.name,
      })
      .from(federationLinks)
      .innerJoin(tenants, eq(tenants.id, federationLinks.requesterTenantId))
      .where(
        or(
          eq(federationLinks.requesterTenantId, tenantId),
          eq(federationLinks.targetTenantId, tenantId),
        ),
      )
      .orderBy(desc(federationLinks.createdAt))
      .limit(100);

    const enriched = await Promise.all(
      links.map(async (link) => {
        const peerId =
          link.requesterTenantId === tenantId
            ? link.targetTenantId
            : link.requesterTenantId;
        const peerRows = await db
          .select({ slug: tenants.slug, name: tenants.name })
          .from(tenants)
          .where(eq(tenants.id, peerId))
          .limit(1);
        const peer = peerRows[0];
        return {
          id: link.id,
          direction:
            link.requesterTenantId === tenantId ? "outgoing" : "incoming",
          peerTenantId: peerId,
          peerSlug: peer?.slug ?? "unknown",
          peerName: peer?.name ?? "Unknown",
          status: link.status,
          message: link.message,
          requesterCidrs: link.requesterCidrs,
          targetCidrs: link.targetCidrs,
          createdAt: link.createdAt,
          updatedAt: link.updatedAt,
        };
      }),
    );

    res.json({ links: enriched });
  },
);

export const createFederationBody = z.object({
  targetSlug: z.string().min(1).max(100),
  message: z.string().max(500).optional(),
  cidrs: z.array(z.string().min(1)).max(20).optional(),
});

federationRouter.post(
  "/api/tenants/:tenantId/federation",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (
      !hasPermission(result.membership, result.role, "manage_settings", req)
    ) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const parsed = createFederationBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid body", details: parsed.error.issues });
      return;
    }

    const targetRows = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, parsed.data.targetSlug))
      .limit(1);

    if (targetRows.length === 0) {
      res.status(404).json({ error: "Target tailnet not found" });
      return;
    }

    const targetTenantId = targetRows[0].id;
    if (targetTenantId === tenantId) {
      res.status(400).json({ error: "Cannot federate with yourself" });
      return;
    }

    const existing = await db
      .select({ id: federationLinks.id })
      .from(federationLinks)
      .where(
        and(
          or(
            and(
              eq(federationLinks.requesterTenantId, tenantId),
              eq(federationLinks.targetTenantId, targetTenantId),
            ),
            and(
              eq(federationLinks.requesterTenantId, targetTenantId),
              eq(federationLinks.targetTenantId, tenantId),
            ),
          ),
          or(
            eq(federationLinks.status, "pending"),
            eq(federationLinks.status, "active"),
          ),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      res
        .status(409)
        .json({ error: "An active or pending federation link already exists" });
      return;
    }

    const [link] = await db
      .insert(federationLinks)
      .values({
        requesterTenantId: tenantId,
        targetTenantId,
        message: parsed.data.message,
        requesterCidrs: parsed.data.cidrs ?? [],
      })
      .returning();

    logAudit({
      tenantId,
      actorUserId: authUserId(req),
      action: "federation_requested",
      targetType: "federation_link",
      targetId: link.id,
      metadata: { targetSlug: parsed.data.targetSlug },
    });

    res.status(201).json({ status: "requested", link });
  },
);

export const respondBody = z.object({
  cidrs: z.array(z.string().min(1)).max(20).optional(),
});

federationRouter.post(
  "/api/tenants/:tenantId/federation/:linkId/accept",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const linkId = param(req, "linkId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (
      !hasPermission(result.membership, result.role, "manage_settings", req)
    ) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const parsed = respondBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid body", details: parsed.error.issues });
      return;
    }

    const linkRows = await db
      .select()
      .from(federationLinks)
      .where(
        and(
          eq(federationLinks.id, linkId),
          eq(federationLinks.targetTenantId, tenantId),
          eq(federationLinks.status, "pending"),
        ),
      )
      .limit(1);

    if (linkRows.length === 0) {
      res.status(404).json({ error: "Pending federation request not found" });
      return;
    }

    await db
      .update(federationLinks)
      .set({
        status: "active",
        targetCidrs: parsed.data.cidrs ?? [],
        reviewedById: authUserId(req),
        updatedAt: new Date(),
      })
      .where(eq(federationLinks.id, linkId));

    logAudit({
      tenantId,
      actorUserId: authUserId(req),
      action: "federation_accepted",
      targetType: "federation_link",
      targetId: linkId,
    });

    res.json({ status: "accepted" });
  },
);

federationRouter.post(
  "/api/tenants/:tenantId/federation/:linkId/reject",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const linkId = param(req, "linkId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (
      !hasPermission(result.membership, result.role, "manage_settings", req)
    ) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const linkRows = await db
      .select()
      .from(federationLinks)
      .where(
        and(
          eq(federationLinks.id, linkId),
          eq(federationLinks.targetTenantId, tenantId),
          eq(federationLinks.status, "pending"),
        ),
      )
      .limit(1);

    if (linkRows.length === 0) {
      res.status(404).json({ error: "Pending federation request not found" });
      return;
    }

    await db
      .update(federationLinks)
      .set({
        status: "rejected",
        reviewedById: authUserId(req),
        updatedAt: new Date(),
      })
      .where(eq(federationLinks.id, linkId));

    logAudit({
      tenantId,
      actorUserId: authUserId(req),
      action: "federation_rejected",
      targetType: "federation_link",
      targetId: linkId,
    });

    res.json({ status: "rejected" });
  },
);

federationRouter.post(
  "/api/tenants/:tenantId/federation/:linkId/revoke",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const linkId = param(req, "linkId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (
      !hasPermission(result.membership, result.role, "manage_settings", req)
    ) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const linkRows = await db
      .select()
      .from(federationLinks)
      .where(
        and(
          eq(federationLinks.id, linkId),
          or(
            eq(federationLinks.requesterTenantId, tenantId),
            eq(federationLinks.targetTenantId, tenantId),
          ),
          or(
            eq(federationLinks.status, "pending"),
            eq(federationLinks.status, "active"),
          ),
        ),
      )
      .limit(1);

    if (linkRows.length === 0) {
      res.status(404).json({ error: "Federation link not found" });
      return;
    }

    await db
      .update(federationLinks)
      .set({
        status: "revoked",
        reviewedById: authUserId(req),
        updatedAt: new Date(),
      })
      .where(eq(federationLinks.id, linkId));

    logAudit({
      tenantId,
      actorUserId: authUserId(req),
      action: "federation_revoked",
      targetType: "federation_link",
      targetId: linkId,
    });

    res.json({ status: "revoked" });
  },
);
