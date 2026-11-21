/**
 * @module routes/federation
 * Federation links between collectives (manage_settings). Each side owns its own row; either side can revoke.
 */

import { Router } from "express";
import { z } from "zod";
import { eq, or, and, desc, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants, federationLinks } from "../db/schema.js";
import {
  requireAuth,
  param,
  authUserId,
} from "./helpers.js";
import { tenantGuard, tenantCtx } from "./guard.js";
import { logAudit } from "../audit/log.js";
import { logger } from "../logger.js";
import { randomUUID } from "node:crypto";
import {
  LOCAL_CAPABILITIES,
  ensureCollectiveDid,
  localBrokerUrl,
  localTenantForDid,
  queueLinkMessage,
  rotateCollectiveDid,
  getBrokerStatus,
  getRouteTable,
  initiateOutboundHandshake,
  publicKeyFingerprint,
  signAsCollective,
  validateLocalCidrsForTenant,
  validatePeerCidrsForTenant,
} from "../orchestrator/federation-broker.js";
import { collectiveDids } from "../db/schema.js";
import { config } from "../config.js";
import { getCoordinatorClient, useCoordinator } from "../orchestrator/control-client.js";
import { CFP_VERSION } from "../federation/protocol.js";
import { scopeDeclarationSchema } from "../federation/scoping.js";
import { signedPayload } from "../federation/auth.js";
import { discoverPeer } from "../federation/discovery.js";
import { outboxStatus, parseOutboxEntry } from "../federation/outbox.js";
import { parseBody } from "./validation.js";

/**
 * Message id of the peer's LINK_REQUEST stored on an incoming link, which our
 * LINK_ACCEPT / LINK_REJECT answers (`inResponseTo`). Falls back to the link id.
 */
function requestMessageId(link: { id: string; signedRequest: string | null }): string {
  if (link.signedRequest) {
    try {
      const parsed = JSON.parse(link.signedRequest) as { messageId?: unknown };
      if (typeof parsed.messageId === "string" && parsed.messageId) return parsed.messageId;
    } catch {
      // fall through
    }
  }
  return link.id;
}

export const federationRouter = Router({ caseSensitive: true });

federationRouter.get(
  "/api/tenants/:tenantId/federation",
  requireAuth,
  tenantGuard({ permission: "manage_settings" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");

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
        revokedPermanently: link.revokedPermanently,
        /** Undelivered cross-instance link message, if any. */
        delivery: outboxStatus(link.outbox),
        createdAt: link.createdAt,
        updatedAt: link.updatedAt,
      })),
    });
  },
);

export const createFederationBody = z.object({
  /**
   * A collective on this instance (its slug), or a remote one as `slug@host`
   * — discovered through its signed `/.well-known/collective-federation`
   * descriptor and asked with a signed LINK_REQUEST (ADR-0019).
   */
  targetSlug: z.string().min(1).max(100),
  message: z.string().max(500).optional(),
  cidrs: z.array(z.string().min(1)).max(20).optional(),
});

federationRouter.post(
  "/api/tenants/:tenantId/federation",
  requireAuth,
  tenantGuard({ permission: "manage_settings", notLockedDown: true }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = tenantCtx(res);

    const parsed = parseBody(createFederationBody, req, res);
    if (!parsed) return;

    // `slug@host` names a collective by its instance. If its DID turns out to
    // be hosted here, the same-instance path below handles it.
    let targetFilter = eq(tenants.slug, parsed.data.targetSlug);
    if (parsed.data.targetSlug.includes("@")) {
      const discovery = await discoverPeer(parsed.data.targetSlug);
      if (!discovery.ok) {
        res.status(400).json({ error: discovery.error });
        return;
      }
      const localTarget = await localTenantForDid(discovery.peer.did);
      if (!localTarget) {
        await requestRemoteLink(req, res, {
          tenantId,
          tenantName: result.tenant.name,
          peer: discovery.peer,
          peerAddress: parsed.data.targetSlug,
          message: parsed.data.message,
          cidrs: parsed.data.cidrs ?? [],
        });
        return;
      }
      targetFilter = eq(tenants.id, localTarget);
    }

    const targetRows = await db
      .select({
        id: tenants.id,
        name: tenants.name,
        federationPosture: tenants.federationPosture,
        lockdownMode: tenants.lockdownMode,
      })
      .from(tenants)
      .where(and(targetFilter, ne(tenants.status, "deleted"), eq(tenants.suspended, false)))
      .limit(1);

    const target = targetRows[0];
    if (target?.id === tenantId) {
      res.status(400).json({ error: "Cannot federate with yourself" });
      return;
    }
    // One answer for missing, closed and locked-down targets: a probe learns nothing more.
    if (!target || target.lockdownMode || target.federationPosture === "closed") {
      res.status(404).json({ error: "No collective with that name accepts federation requests" });
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

    // ADR-0019 §6: we may only offer our own prefixes, and the target must be
    // able to import them (no overlap with its range or its other links).
    const localCheck = await validateLocalCidrsForTenant(tenantId, parsed.data.cidrs ?? []);
    if (localCheck.errors.length > 0) {
      res.status(400).json({ error: "Invalid CIDRs", details: localCheck.errors });
      return;
    }
    const peerCheck = await validatePeerCidrsForTenant(targetTenantId, localCheck.cidrs);
    if (peerCheck.errors.length > 0) {
      res.status(400).json({ error: "CIDRs conflict with the target collective", details: peerCheck.errors });
      return;
    }
    const offeredCidrs = localCheck.cidrs;

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

/** Cross-instance half of POST /federation: local outgoing row + queued LINK_REQUEST. */
async function requestRemoteLink(
  req: import("express").Request,
  res: import("express").Response,
  opts: {
    tenantId: string;
    tenantName: string;
    peer: { did: string; brokerUrl: string; name: string };
    peerAddress: string;
    message?: string;
    cidrs: string[];
  },
): Promise<void> {
  const { tenantId, peer } = opts;

  const existing = await db
    .select({ id: federationLinks.id })
    .from(federationLinks)
    .where(
      and(
        eq(federationLinks.localTenantId, tenantId),
        eq(federationLinks.peerDid, peer.did),
        or(eq(federationLinks.status, "pending"), eq(federationLinks.status, "active")),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    res.status(409).json({ error: "An active or pending federation link already exists" });
    return;
  }

  // We may only offer our own prefixes; the peer validates its side on receipt.
  const localCheck = await validateLocalCidrsForTenant(tenantId, opts.cidrs);
  if (localCheck.errors.length > 0) {
    res.status(400).json({ error: "Invalid CIDRs", details: localCheck.errors });
    return;
  }

  const { did: requesterDid } = await ensureCollectiveDid(tenantId);

  const [link] = await db
    .insert(federationLinks)
    .values({
      localTenantId: tenantId,
      peerDid: peer.did,
      peerBrokerUrl: peer.brokerUrl,
      peerName: peer.name,
      direction: "outgoing",
      message: opts.message,
      localCidrs: localCheck.cidrs,
    })
    .returning();

  const messageId = randomUUID();
  await queueLinkMessage(
    link,
    {
      type: "LINK_REQUEST",
      messageId,
      collectiveDid: requesterDid,
      brokerUrl: await localBrokerUrl(tenantId),
      collectiveName: opts.tenantName,
      federationType: "peer",
      offeredCidrs: localCheck.cidrs,
      capabilities: LOCAL_CAPABILITIES,
      ...(opts.message ? { message: opts.message } : {}),
    },
    authUserId(req),
  );

  logAudit({
    tenantId,
    actorUserId: authUserId(req),
    action: "federation_requested",
    targetType: "federation_link",
    targetId: link.id,
    metadata: { peerAddress: opts.peerAddress, peerDid: peer.did, crossInstance: true, messageId },
  });

  res.status(201).json({ status: "requested", link });
}

export const respondBody = z.object({
  cidrs: z.array(z.string().min(1)).max(20).optional(),
});

federationRouter.post(
  "/api/tenants/:tenantId/federation/:linkId/accept",
  requireAuth,
  tenantGuard({ permission: "manage_settings", notLockedDown: true }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const linkId = param(req, "linkId");
    const result = tenantCtx(res);

    const parsed = parseBody(respondBody, req, res);
    if (!parsed) return;

    // Find the local (incoming) link row for this tenant. Only the side that
    // received the request may accept it — never the requester itself.
    const linkRows = await db
      .select()
      .from(federationLinks)
      .where(
        and(
          eq(federationLinks.id, linkId),
          eq(federationLinks.localTenantId, tenantId),
          eq(federationLinks.direction, "incoming"),
          eq(federationLinks.status, "pending"),
        ),
      )
      .limit(1);

    if (linkRows.length === 0) {
      res.status(404).json({ error: "Pending federation request not found" });
      return;
    }

    const link = linkRows[0];

    // What we share must be ours; what the peer offered must still be
    // importable (ranges and other links may have changed since the request).
    const localCheck = await validateLocalCidrsForTenant(tenantId, parsed.data.cidrs ?? []);
    if (localCheck.errors.length > 0) {
      res.status(400).json({ error: "Invalid CIDRs", details: localCheck.errors });
      return;
    }
    const offeredCheck = await validatePeerCidrsForTenant(tenantId, link.peerCidrs, link.id);
    if (offeredCheck.errors.length > 0) {
      res.status(409).json({ error: "The peer's offered CIDRs conflict with this collective", details: offeredCheck.errors });
      return;
    }
    const acceptedCidrs = localCheck.cidrs;

    // Look up our DID and the peer's tenant UUID (same-instance mirror row).
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

    const crossInstance = peerDidRows.length === 0;
    if (crossInstance && !link.peerBrokerUrl) {
      res.status(409).json({ error: "The requesting collective's broker URL is unknown" });
      return;
    }

    // The requester must be able to import what we share.
    if (peerDidRows.length > 0) {
      const mirrorCheck = await validatePeerCidrsForTenant(peerDidRows[0].tenantId, acceptedCidrs);
      if (mirrorCheck.errors.length > 0) {
        res.status(400).json({ error: "CIDRs conflict with the requesting collective", details: mirrorCheck.errors });
        return;
      }
    }

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

    // Update the requester's (outgoing) mirror row.
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
            eq(federationLinks.direction, "outgoing"),
            eq(federationLinks.status, "pending"),
          ),
        );
    }

    if (crossInstance) {
      // The requester's row becomes active when our LINK_ACCEPT arrives; the
      // handshake starts once it has been delivered (see deliverLinkOutbox).
      const { did: ourDid } = await ensureCollectiveDid(tenantId);
      await queueLinkMessage(
        link,
        {
          type: "LINK_ACCEPT",
          messageId: randomUUID(),
          inResponseTo: requestMessageId(link),
          collectiveDid: ourDid,
          brokerUrl: await localBrokerUrl(tenantId),
          collectiveName: result.tenant.name,
          acceptedCidrs,
        },
        authUserId(req),
      );
    }

    logAudit({
      tenantId,
      actorUserId: authUserId(req),
      action: "federation_accepted",
      targetType: "federation_link",
      targetId: linkId,
      ...(crossInstance ? { metadata: { peerDid: link.peerDid, crossInstance: true } } : {}),
    });

    if (!crossInstance) {
      setImmediate(() => {
        initiateOutboundHandshake(link.id, link.localTenantId).catch((err) => {
          logger.warn({ linkId: link.id, err }, "failed to initiate outbound handshake");
        });
      });
    }

    res.json({ status: "accepted" });
  },
);

federationRouter.post(
  "/api/tenants/:tenantId/federation/:linkId/reject",
  requireAuth,
  tenantGuard({ permission: "manage_settings" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const linkId = param(req, "linkId");

    // Only the receiving side rejects; the requester withdraws via revoke.
    const linkRows = await db
      .select()
      .from(federationLinks)
      .where(
        and(
          eq(federationLinks.id, linkId),
          eq(federationLinks.localTenantId, tenantId),
          eq(federationLinks.direction, "incoming"),
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

    if (peerDidRows.length === 0 && link.peerBrokerUrl) {
      // Cross-instance: tell the requester's broker.
      const { did: ourDid } = await ensureCollectiveDid(tenantId);
      await queueLinkMessage(
        link,
        {
          type: "LINK_REJECT",
          messageId: randomUUID(),
          inResponseTo: requestMessageId(link),
          collectiveDid: ourDid,
        },
        authUserId(req),
      );
    }

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
            eq(federationLinks.direction, "outgoing"),
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
  tenantGuard({ permission: "manage_settings" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const linkId = param(req, "linkId");

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

    // An operator's revocation is final: a new link request is needed to
    // federate again, and the broker never re-handshakes this link.
    await db
      .update(federationLinks)
      .set({
        status: "revoked",
        revokedPermanently: true,
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

    if (peerDidRows.length === 0 && link.peerBrokerUrl) {
      // Cross-instance. A LINK_REQUEST that never left needs no revocation —
      // the peer has never heard of the link; drop it instead.
      const pending = parseOutboxEntry(link.outbox);
      if (pending?.message.type === "LINK_REQUEST" && pending.attempts === 0) {
        await db.update(federationLinks).set({ outbox: null }).where(eq(federationLinks.id, linkId));
      } else {
        const { did: ourDid } = await ensureCollectiveDid(tenantId);
        await queueLinkMessage(
          link,
          {
            type: "LINK_REVOKE",
            messageId: randomUUID(),
            collectiveDid: ourDid,
            reason: "revoked by operator",
            permanent: true,
          },
          authUserId(req),
        );
      }
    }

    if (ourDidRows.length > 0 && peerDidRows.length > 0) {
      await db
        .update(federationLinks)
        .set({
          status: "revoked",
          revokedPermanently: true,
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
  tenantGuard({ permission: "manage_settings" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");

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
  tenantGuard({ originatorOnly: "Only the originator can rotate the DID key" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");

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
  tenantGuard({ permission: "manage_settings" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");

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
  tenantGuard({ permission: "manage_settings" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");

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
      .where(and(eq(tenants.slug, tenantSlug), ne(tenants.status, "deleted"), eq(tenants.suspended, false)))
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

    // Detached JWS by the collective's key over the JCS form of the document
    // without `signature` (the CFP signing payload, see federation/auth.ts).
    try {
      discovery.signature = await signAsCollective(tenant.id, signedPayload(discovery));
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
    // Deleted or suspended collectives don't publish a DID document
    .where(and(eq(tenants.slug, slug), ne(tenants.status, "deleted"), eq(tenants.suspended, false)))
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
  tenantGuard({ permission: "manage_settings" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");

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
  tenantGuard({ permission: "manage_settings" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");

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
  posture: z.enum(["closed", "open"]),
});

/** The coordinator refuses "selective" with this message; the service answers the same. */
const SELECTIVE_POSTURE_ERROR = "selective posture is not implemented";

federationRouter.get(
  "/api/tenants/:tenantId/federation/posture",
  requireAuth,
  tenantGuard({ permission: "manage_settings" }),
  async (req, res) => {
    const result = tenantCtx(res);

    res.json({ posture: result.tenant.federationPosture });
  },
);

federationRouter.put(
  "/api/tenants/:tenantId/federation/posture",
  requireAuth,
  tenantGuard({ permission: "manage_settings" }),
  async (req, res) => {
    const tenantId = param(req, "tenantId");
    const result = tenantCtx(res);

    if ((req.body as { posture?: unknown } | undefined)?.posture === "selective") {
      res.status(400).json({ error: SELECTIVE_POSTURE_ERROR });
      return;
    }
    const parsed = parseBody(postureBody, req, res);
    if (!parsed) return;

    if (useCoordinator) {
      await getCoordinatorClient(result.tenant).setPosture(parsed.data.posture);
    }

    await db
      .update(tenants)
      .set({
        federationPosture: parsed.data.posture,
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, tenantId));

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
