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

    const link = linkRows[0];
    setImmediate(() => {
      initiateOutboundHandshake(link.id, tenantId).catch((err) => {
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
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, tenantSlug))
      .limit(1);

    if (tenantRows.length === 0) {
      res.status(404).json({ error: "Collective not found" });
      return;
    }

    const didRows = await db
      .select({
        did: collectiveDids.did,
        brokerEndpoint: collectiveDids.brokerEndpoint,
      })
      .from(collectiveDids)
      .where(eq(collectiveDids.tenantId, tenantRows[0].id))
      .limit(1);

    if (didRows.length === 0) {
      res.status(404).json({ error: "No federation DID configured" });
      return;
    }

    const scopeRows = await db
      .select({
        federationScopes: tenants.federationScopes,
        federationRegion: tenants.federationRegion,
        federationCoordinates: tenants.federationCoordinates,
        federationScopePolicies: tenants.federationScopePolicies,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantRows[0].id))
      .limit(1);

    const scope = scopeRows[0];

    const discovery: Record<string, unknown> = {
      collectiveDid: didRows[0].did,
      cfpVersions: [CFP_VERSION],
      federationPolicy: "selective",
      capabilities: ["route-exchange", "dns-forward"],
      derpEndpoints: [],
      brokerUrl: didRows[0].brokerEndpoint ?? config.publicUrl,
      scopes: scope?.federationScopes ?? ["regional"],
      region: scope?.federationRegion ?? null,
      coordinates: scope?.federationCoordinates ?? null,
      scopePolicies: scope?.federationScopePolicies ?? null,
      signature: "",
    };

    // Detached JWS by the collective's key over the document as serialized
    // here with `signature: ""`.
    try {
      discovery.signature = await signAsCollective(
        tenantRows[0].id,
        JSON.stringify(discovery),
      );
    } catch (err) {
      logger.error({ tenantId: tenantRows[0].id, err }, "failed to sign discovery document");
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
