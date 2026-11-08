/**
 * @module routes/federation
 * Federation link management between collectives. Each side stores its own
 * view of the link (per-side model): localTenantId owns the row, peerDid
 * identifies the remote collective, direction records who initiated. The
 * requester sends a federation request to a target tenant by slug; the
 * target's originator or manage_settings holder accepts/rejects. Either
 * side can revoke.  Gated by the "manage_settings" permission.
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
  isLockedDown,
} from "./helpers.js";
import { logAudit } from "./audit.js";
import { logger } from "../logger.js";
import {
  ensureCollectiveDid,
  rotateCollectiveDid,
  getBrokerStatus,
  getRouteTable,
  initiateOutboundHandshake,
  publicKeyFingerprint,
  signAsCollective,
} from "../orchestrator/federation-broker.js";
import { collectiveDids } from "../db/schema.js";
import { config } from "../config.js";
import { getControlClient, useCoordinator } from "../orchestrator/control-client.js";
import { CoordinatorApiClient } from "../orchestrator/coordinator-api.js";
import { CFP_VERSION } from "../federation/protocol.js";
import { scopeDeclarationSchema } from "../federation/scoping.js";

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
      .select()
      .from(federationLinks)
      .where(eq(federationLinks.localTenantId, tenantId))
      .orderBy(desc(federationLinks.createdAt))
      .limit(100);

    res.json({
      links: links.map((link) => ({
        id: link.id,
        direction: link.direction,
        peerDid: link.peerDid,
        peerName: link.peerName ?? link.peerDid,
        peerBrokerUrl: link.peerBrokerUrl,
        status: link.status,
        message: link.message,
        localCidrs: link.localCidrs,
        peerCidrs: link.peerCidrs,
        createdAt: link.createdAt,
        updatedAt: link.updatedAt,
      })),
    });
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

    if (isLockedDown(result.tenant)) {
      res.status(403).json({ error: "Tenant is in lockdown mode" });
      return;
    }

    const parsed = createFederationBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid body", details: parsed.error.issues });
      return;
    }

    // Look up target tenant by slug (same-instance for now)
    const targetRows = await db
      .select({
        id: tenants.id,
        name: tenants.name,
        federationPosture: tenants.federationPosture,
        lockdownMode: tenants.lockdownMode,
      })
      .from(tenants)
      .where(eq(tenants.slug, parsed.data.targetSlug))
      .limit(1);

    if (targetRows.length === 0) {
      res.status(404).json({ error: "Target tailnet not found" });
      return;
    }

    const target = targetRows[0];
    if (target.id === tenantId) {
      res.status(400).json({ error: "Cannot federate with yourself" });
      return;
    }

    if (target.lockdownMode) {
      res.status(403).json({ error: "Target collective is in lockdown mode" });
      return;
    }

    if (target.federationPosture === "closed") {
      res.status(403).json({ error: "Target collective does not accept federation requests" });
      return;
    }

    const targetTenantId = target.id;
    const targetTenantName = target.name;

    // Look up the collective DIDs for both sides
    const [requesterDidRows, targetDidRows] = await Promise.all([
      db
        .select({ did: collectiveDids.did })
        .from(collectiveDids)
        .where(eq(collectiveDids.tenantId, tenantId))
        .limit(1),
      db
        .select({ did: collectiveDids.did })
        .from(collectiveDids)
        .where(eq(collectiveDids.tenantId, targetTenantId))
        .limit(1),
    ]);

    if (requesterDidRows.length === 0) {
      res.status(400).json({ error: "Requester collective has no DID configured" });
      return;
    }
    if (targetDidRows.length === 0) {
      res.status(400).json({ error: "Target collective has no DID configured" });
      return;
    }

    const requesterDid = requesterDidRows[0].did;
    const targetDid = targetDidRows[0].did;

    // Check for existing active/pending link with this peer
    const existing = await db
      .select({ id: federationLinks.id })
      .from(federationLinks)
      .where(
        and(
          eq(federationLinks.localTenantId, tenantId),
          eq(federationLinks.peerDid, targetDid),
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

    const offeredCidrs = parsed.data.cidrs ?? [];

    // Create the outgoing row for the requester
    const [link] = await db
      .insert(federationLinks)
      .values({
        localTenantId: tenantId,
        peerDid: targetDid,
        peerBrokerUrl: config.publicUrl,
        peerName: targetTenantName,
        direction: "outgoing",
        message: parsed.data.message,
        localCidrs: offeredCidrs,
      })
      .returning();

    // Create the mirror incoming row for the target
    await db.insert(federationLinks).values({
      localTenantId: targetTenantId,
      peerDid: requesterDid,
      peerBrokerUrl: config.publicUrl,
      peerName: result.tenant.name,
      direction: "incoming",
      message: parsed.data.message,
      localCidrs: [],
      peerCidrs: offeredCidrs,
    });

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

    // Find the local (incoming) link row for this tenant
    const linkRows = await db
      .select()
      .from(federationLinks)
      .where(
        and(
          eq(federationLinks.id, linkId),
          eq(federationLinks.localTenantId, tenantId),
          eq(federationLinks.status, "pending"),
        ),
      )
      .limit(1);

    if (linkRows.length === 0) {
      res.status(404).json({ error: "Pending federation request not found" });
      return;
    }

    const link = linkRows[0];
    const acceptedCidrs = parsed.data.cidrs ?? [];

    // Update local row: active + set what we share
    await db
      .update(federationLinks)
      .set({
        status: "active",
        localCidrs: acceptedCidrs,
        reviewedById: authUserId(req),
        updatedAt: new Date(),
      })
      .where(eq(federationLinks.id, linkId));

    // Update the mirror row: look up our DID and the peer's tenant UUID
    const [ourDidRows, peerDidRows] = await Promise.all([
      db
        .select({ did: collectiveDids.did })
        .from(collectiveDids)
        .where(eq(collectiveDids.tenantId, tenantId))
        .limit(1),
      db
        .select({ tenantId: collectiveDids.tenantId })
        .from(collectiveDids)
        .where(eq(collectiveDids.did, link.peerDid))
        .limit(1),
    ]);

    if (ourDidRows.length > 0 && peerDidRows.length > 0) {
      await db
        .update(federationLinks)
        .set({
          status: "active",
          peerCidrs: acceptedCidrs,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(federationLinks.localTenantId, peerDidRows[0].tenantId),
            eq(federationLinks.peerDid, ourDidRows[0].did),
            eq(federationLinks.status, "pending"),
          ),
        );
    }

    logAudit({
      tenantId,
      actorUserId: authUserId(req),
      action: "federation_accepted",
      targetType: "federation_link",
      targetId: linkId,
    });

    setImmediate(() => {
      initiateOutboundHandshake(link.id, link.localTenantId).catch((err) => {
        logger.warn({ linkId: link.id, err }, "failed to initiate outbound handshake");
      });
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
          eq(federationLinks.localTenantId, tenantId),
          eq(federationLinks.status, "pending"),
        ),
      )
      .limit(1);

    if (linkRows.length === 0) {
      res.status(404).json({ error: "Pending federation request not found" });
      return;
    }

    const link = linkRows[0];

    await db
      .update(federationLinks)
      .set({
        status: "rejected",
        reviewedById: authUserId(req),
        updatedAt: new Date(),
      })
      .where(eq(federationLinks.id, linkId));

    // Update the mirror row
    const [ourDidRows, peerDidRows] = await Promise.all([
      db
        .select({ did: collectiveDids.did })
        .from(collectiveDids)
        .where(eq(collectiveDids.tenantId, tenantId))
        .limit(1),
      db
        .select({ tenantId: collectiveDids.tenantId })
        .from(collectiveDids)
        .where(eq(collectiveDids.did, link.peerDid))
        .limit(1),
    ]);

    if (ourDidRows.length > 0 && peerDidRows.length > 0) {
      await db
        .update(federationLinks)
        .set({
          status: "rejected",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(federationLinks.localTenantId, peerDidRows[0].tenantId),
            eq(federationLinks.peerDid, ourDidRows[0].did),
            eq(federationLinks.status, "pending"),
          ),
        );
    }

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
          eq(federationLinks.localTenantId, tenantId),
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

    const link = linkRows[0];

    await db
      .update(federationLinks)
      .set({
        status: "revoked",
        reviewedById: authUserId(req),
        updatedAt: new Date(),
      })
      .where(eq(federationLinks.id, linkId));

    // Update the mirror row
    const [ourDidRows, peerDidRows] = await Promise.all([
      db
        .select({ did: collectiveDids.did })
        .from(collectiveDids)
        .where(eq(collectiveDids.tenantId, tenantId))
        .limit(1),
      db
        .select({ tenantId: collectiveDids.tenantId })
        .from(collectiveDids)
        .where(eq(collectiveDids.did, link.peerDid))
        .limit(1),
    ]);

    if (ourDidRows.length > 0 && peerDidRows.length > 0) {
      await db
        .update(federationLinks)
        .set({
          status: "revoked",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(federationLinks.localTenantId, peerDidRows[0].tenantId),
            eq(federationLinks.peerDid, ourDidRows[0].did),
            or(
              eq(federationLinks.status, "pending"),
              eq(federationLinks.status, "active"),
            ),
          ),
        );
    }

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

/** Get or create the collective DID for this tenant. */
federationRouter.get(
  "/api/tenants/:tenantId/federation/did",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "manage_settings", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    try {
      const { did, publicKeyJwk } = await ensureCollectiveDid(tenantId);
      res.json({
        did,
        publicKeyJwk,
        publicKeyFingerprint: await publicKeyFingerprint(publicKeyJwk),
      });
    } catch (err) {
      logger.error({ tenantId, err }, "failed to get/create collective DID");
      res.status(500).json({ error: "Failed to manage collective DID" });
    }
  },
);

/** Rotate the collective DID keypair. */
federationRouter.post(
  "/api/tenants/:tenantId/federation/did/rotate",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!result.membership.isOriginator) {
      res.status(403).json({ error: "Only the originator can rotate the DID key" });
      return;
    }

    try {
      const { did, publicKeyJwk } = await rotateCollectiveDid(tenantId);

      logAudit({
        tenantId,
        actorUserId: authUserId(req),
        action: "tenant_settings_updated",
        targetType: "tenant",
        targetId: tenantId,
        metadata: { operation: "did_rotation", did },
      });

      res.json({
        did,
        publicKeyJwk,
        publicKeyFingerprint: await publicKeyFingerprint(publicKeyJwk),
        rotated: true,
      });
    } catch (err) {
      logger.error({ tenantId, err }, "failed to rotate collective DID");
      res.status(500).json({ error: "Failed to rotate DID" });
    }
  },
);

/** Get federation broker session status. */
federationRouter.get(
  "/api/tenants/:tenantId/federation/broker",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "manage_settings", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    try {
      const status = await getBrokerStatus(tenantId);
      res.json(status);
    } catch (err) {
      logger.error({ tenantId, err }, "failed to get broker status");
      res.status(500).json({ error: "Failed to get broker status" });
    }
  },
);

/** Get federation route table for this tenant. */
federationRouter.get(
  "/api/tenants/:tenantId/federation/routes",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "manage_settings", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    try {
      const routes = await getRouteTable(tenantId);
      res.json(routes);
    } catch (err) {
      logger.error({ tenantId, err }, "failed to get route table");
      res.status(500).json({ error: "Failed to get route table" });
    }
  },
);

federationRouter.get(
  "/.well-known/collective-federation",
  async (req, res) => {
    const tenantSlug = req.query.collective as string | undefined;
    if (!tenantSlug) {
      res.status(400).json({ error: "?collective=slug required" });
      return;
    }

    const tenantRows = await db
      .select({
        id: tenants.id,
        federationPosture: tenants.federationPosture,
        federationScopes: tenants.federationScopes,
        federationRegion: tenants.federationRegion,
        federationCoordinates: tenants.federationCoordinates,
        federationScopePolicies: tenants.federationScopePolicies,
      })
      .from(tenants)
      .where(eq(tenants.slug, tenantSlug))
      .limit(1);

    if (tenantRows.length === 0) {
      res.status(404).json({ error: "Collective not found" });
      return;
    }

    const tenant = tenantRows[0];

    const didRows = await db
      .select({
        did: collectiveDids.did,
        brokerEndpoint: collectiveDids.brokerEndpoint,
      })
      .from(collectiveDids)
      .where(eq(collectiveDids.tenantId, tenant.id))
      .limit(1);

    if (didRows.length === 0) {
      res.status(404).json({ error: "No federation DID configured" });
      return;
    }

    const discovery: Record<string, unknown> = {
      collectiveDid: didRows[0].did,
      cfpVersions: [CFP_VERSION],
      federationPolicy: tenant.federationPosture,
      capabilities: ["route-exchange", "dns-forward"],
      derpEndpoints: [],
      brokerUrl: didRows[0].brokerEndpoint ?? config.publicUrl,
      scopes: tenant.federationScopes ?? ["regional"],
      region: tenant.federationRegion ?? null,
      coordinates: tenant.federationCoordinates ?? null,
      scopePolicies: tenant.federationScopePolicies ?? null,
      signature: "",
    };

    // Detached JWS by the collective's key over the document as serialized
    // here with `signature: ""`.
    try {
      discovery.signature = await signAsCollective(
        tenant.id,
        JSON.stringify(discovery),
      );
    } catch (err) {
      logger.error({ tenantId: tenant.id, err }, "failed to sign discovery document");
      res.status(500).json({ error: "Failed to sign discovery document" });
      return;
    }

    res.json(discovery);
  },
);

/** Build the did:web document of a collective hosted here, or null if it has no DID. */
async function collectiveDidDocument(slug: string): Promise<object | null> {
  const rows = await db
    .select({
      did: collectiveDids.did,
      publicKeyJwk: collectiveDids.publicKeyJwk,
    })
    .from(collectiveDids)
    .innerJoin(tenants, eq(tenants.id, collectiveDids.tenantId))
    .where(eq(tenants.slug, slug))
    .limit(1);

  if (rows.length === 0) return null;

  const { did, publicKeyJwk } = rows[0];
  const keyId = `${did}#signing-key`;

  return {
    "@context": ["https://www.w3.org/ns/did/v1"],
    id: did,
    verificationMethod: [
      {
        id: keyId,
        type: "JsonWebKey2020",
        controller: did,
        publicKeyJwk,
      },
    ],
    authentication: [keyId],
    assertionMethod: [keyId],
  };
}

/**
 * did:web resolution endpoint (ADR-0017). Collective DIDs are path-based —
 * `did:web:<host>:collective:<slug>` — which did:web maps to this URL.
 */
federationRouter.get("/collective/:slug/did.json", async (req, res) => {
  const doc = await collectiveDidDocument(param(req, "slug"));
  if (!doc) {
    res.status(404).json({ error: "Collective not found" });
    return;
  }
  res.type("application/did+json").send(JSON.stringify(doc));
});

/** Convenience alias of the above for tooling that only knows the well-known path. */
federationRouter.get("/.well-known/did.json", async (req, res) => {
  const slug = req.query.collective;
  if (typeof slug !== "string" || !slug) {
    res.status(400).json({ error: "?collective=slug required" });
    return;
  }
  const doc = await collectiveDidDocument(slug);
  if (!doc) {
    res.status(404).json({ error: "Collective not found" });
    return;
  }
  res.type("application/did+json").send(JSON.stringify(doc));
});

federationRouter.get(
  "/api/tenants/:tenantId/federation/scope",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "manage_settings", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const rows = await db
      .select({
        federationScopes: tenants.federationScopes,
        federationRegion: tenants.federationRegion,
        federationCoordinates: tenants.federationCoordinates,
        federationScopePolicies: tenants.federationScopePolicies,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const row = rows[0];
    res.json({
      scopes: row?.federationScopes ?? ["regional"],
      region: row?.federationRegion ?? null,
      coordinates: row?.federationCoordinates ?? null,
      scopePolicies: row?.federationScopePolicies ?? null,
    });
  },
);

federationRouter.put(
  "/api/tenants/:tenantId/federation/scope",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "manage_settings", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const parsed = scopeDeclarationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid scope declaration", details: parsed.error.issues });
      return;
    }

    await db
      .update(tenants)
      .set({
        federationScopes: parsed.data.scopes,
        federationRegion: parsed.data.region ?? null,
        federationCoordinates: parsed.data.coordinates ?? null,
        federationScopePolicies: parsed.data.scopePolicies ?? null,
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, tenantId));

    logAudit({
      tenantId,
      actorUserId: authUserId(req),
      action: "tenant_settings_updated",
      targetType: "tenant",
      targetId: tenantId,
      metadata: { operation: "federation_scope_update", scopes: parsed.data.scopes },
    });

    res.json({ saved: true, ...parsed.data });
  },
);

// ── Federation posture management ───────────────────────────────────────

const postureBody = z.object({
  posture: z.enum(["closed", "selective", "open"]),
});

federationRouter.get(
  "/api/tenants/:tenantId/federation/posture",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "manage_settings", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    res.json({ posture: result.tenant.federationPosture });
  },
);

federationRouter.put(
  "/api/tenants/:tenantId/federation/posture",
  requireAuth,
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = await getTenantForUser(tenantId, authUserId(req));
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!hasPermission(result.membership, result.role, "manage_settings", req)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const parsed = postureBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
      return;
    }

    await db
      .update(tenants)
      .set({
        federationPosture: parsed.data.posture,
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, tenantId));

    if (useCoordinator) {
      try {
        const client = getControlClient(result.tenant);
        if (client instanceof CoordinatorApiClient) {
          await client.setPosture(parsed.data.posture);
        }
      } catch (err) {
        logger.warn({ err, tenantId }, "failed to sync posture to coordinator");
      }
    }

    logAudit({
      tenantId,
      actorUserId: authUserId(req),
      action: "tenant_settings_updated",
      targetType: "tenant",
      targetId: tenantId,
      metadata: { operation: "federation_posture_update", posture: parsed.data.posture },
    });

    res.json({ posture: parsed.data.posture });
  },
);
