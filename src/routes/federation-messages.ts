/**
 * @module routes/federation-messages
 * Inbound CFP message endpoints for inter-broker federation (ADR-0016).
 * Machine-to-machine: authenticated by the sender's DID signature, never by
 * session cookies. The addressed collective is named by the `CFP-Recipient`
 * header, since one instance hosts many collectives.
 *
 * The handshake is two request/response exchanges driven by the initiator:
 *   POST hello  → CHALLENGE
 *   POST commit → ESTABLISHED
 * followed by signed KEEPALIVE and REVOKE messages for the session's lifetime.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { brokerSessions, collectiveDids, federationLinks, tenants } from "../db/schema.js";
import { logger } from "../logger.js";
import {
  LOCAL_CAPABILITIES,
  initiateOutboundHandshake,
  markSessionEstablished,
  signAsCollective,
  withdrawFederatedRoutes,
} from "../orchestrator/federation-broker.js";
import {
  createHandshake,
  handleHello,
  handleCommit,
  type HandshakeState,
} from "../federation/handshake.js";
import {
  buildAnnouncements,
  filterImportedPrefixes,
  isFresh,
  makeHandshakeCallbacks,
  verifyMessage,
} from "../federation/auth.js";
import { RECIPIENT_HEADER } from "../federation/transport.js";
import { getResolver } from "../identity/resolver.js";
import { isAllowedBrokerUrl } from "../federation/discovery.js";
import {
  helloByDid,
  helloByIp,
  linkRequestByDid,
  linkRequestByIp,
  linkMessageReplay,
  MAX_PENDING_PER_COLLECTIVE,
} from "../federation/abuse.js";
import type {
  HelloMessage,
  CommitMessage,
  KeepaliveMessage,
  RevokeMessage,
  LinkRequestMessage,
  LinkAcceptMessage,
  LinkRejectMessage,
  LinkRevokeMessage,
} from "../federation/protocol.js";

export const federationMessagesRouter = Router();

// ── Message shapes (untrusted input) ─────────────────────────────────────

const did = z.string().min(8).max(512).startsWith("did:");
const signature = z.string().min(1).max(1024);
const timestamp = z.string().max(64);
const cidr = z.string().min(1).max(64);

const routeAnnouncement = z.object({
  prefix: cidr,
  originDid: did,
  pathVector: z.array(did).max(32),
  communityTags: z.array(z.string().max(64)).max(32).optional(),
  preference: z.number(),
  originSignature: z.string().max(1024),
});

export const helloSchema = z.object({
  type: z.literal("HELLO"),
  collectiveDid: did,
  federationType: z.enum(["peer", "parent-child", "transit", "mesh"]),
  offeredCidrs: z.array(cidr).max(64),
  capabilities: z.array(z.string().max(32)).max(16),
  protocolVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  meshId: z.string().max(128).optional(),
  signature,
  timestamp,
});

export const commitSchema = z.object({
  type: z.literal("COMMIT"),
  collectiveDid: did,
  challengeNonce: z.string().min(1).max(128),
  challengeSignature: signature,
  initialRoutes: z.array(routeAnnouncement).max(64),
  signature,
  timestamp,
});

export const keepaliveSchema = z.object({
  type: z.literal("KEEPALIVE"),
  sessionId: z.string().min(1).max(128),
  sequenceNumber: z.number(),
  timestamp,
  signature,
});

export const revokeSchema = z.object({
  type: z.literal("REVOKE"),
  sessionId: z.string().min(1).max(128),
  reason: z.string().max(500).optional(),
  permanent: z.boolean(),
  signature,
  timestamp,
});

export const linkRequestSchema = z.object({
  type: z.literal("LINK_REQUEST"),
  messageId: z.string().min(1).max(128),
  collectiveDid: did,
  brokerUrl: z.string().url().max(512),
  collectiveName: z.string().min(1).max(200),
  federationType: z.enum(["peer", "parent-child", "transit", "mesh"]),
  offeredCidrs: z.array(cidr).max(64),
  capabilities: z.array(z.string().max(32)).max(16),
  message: z.string().max(500).optional(),
  signature,
  timestamp,
});

export const linkAcceptSchema = z.object({
  type: z.literal("LINK_ACCEPT"),
  messageId: z.string().min(1).max(128),
  inResponseTo: z.string().min(1).max(128),
  collectiveDid: did,
  brokerUrl: z.string().url().max(512),
  collectiveName: z.string().min(1).max(200),
  acceptedCidrs: z.array(cidr).max(64),
  signature,
  timestamp,
});

export const linkRejectSchema = z.object({
  type: z.literal("LINK_REJECT"),
  messageId: z.string().min(1).max(128),
  inResponseTo: z.string().min(1).max(128),
  collectiveDid: did,
  reason: z.string().max(500).optional(),
  signature,
  timestamp,
});

export const linkRevokeSchema = z.object({
  type: z.literal("LINK_REVOKE"),
  messageId: z.string().min(1).max(128),
  collectiveDid: did,
  reason: z.string().max(500).optional(),
  permanent: z.boolean(),
  signature,
  timestamp,
});

function clientIp(req: Request): string {
  return (req.ip ?? req.socket.remoteAddress ?? "unknown") as string;
}

// ── Pending handshakes (responder side, between HELLO and COMMIT) ────────

interface PendingHandshake {
  state: HandshakeState;
  localTenantId: string;
  linkId: string;
  /** CIDRs the peer may announce to us on this link. */
  remoteCidrs: string[];
  expiresAt: number;
}

const MAX_PENDING_HANDSHAKES = 1000;
const pendingHandshakes = new Map<string, PendingHandshake>();

function rememberHandshake(nonce: string, pending: PendingHandshake): void {
  const now = Date.now();
  for (const [key, value] of pendingHandshakes) {
    if (value.expiresAt <= now) pendingHandshakes.delete(key);
  }
  // Map iteration is insertion-ordered, so this drops the oldest.
  while (pendingHandshakes.size >= MAX_PENDING_HANDSHAKES) {
    pendingHandshakes.delete(pendingHandshakes.keys().next().value!);
  }
  pendingHandshakes.set(nonce, pending);
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** The local collective a message is addressed to, or null after replying with an error. */
async function resolveRecipient(
  req: Request,
  res: Response,
): Promise<{ tenantId: string; did: string } | null> {
  const recipientDid = req.get(RECIPIENT_HEADER);
  if (!recipientDid || recipientDid.length > 512) {
    res.status(400).json({ error: `${RECIPIENT_HEADER} header required` });
    return null;
  }

  const [row] = await db
    .select({ tenantId: collectiveDids.tenantId, did: collectiveDids.did })
    .from(collectiveDids)
    .where(eq(collectiveDids.did, recipientDid))
    .limit(1);

  if (!row) {
    res.status(404).json({ error: "Unknown recipient collective" });
    return null;
  }
  return row;
}

/** Find the active federation link for a local tenant and a remote DID. */
async function findActiveLinkByDid(
  localTenantId: string,
  peerDid: string,
): Promise<typeof federationLinks.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(federationLinks)
    .where(
      and(
        eq(federationLinks.localTenantId, localTenantId),
        eq(federationLinks.peerDid, peerDid),
        eq(federationLinks.status, "active"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Authenticate a session-scoped message (KEEPALIVE / REVOKE): the session
 * must belong to the addressed collective and the message must be signed by
 * that session's peer. Replies with an error and returns null otherwise.
 */
async function authenticateSessionMessage(
  req: Request,
  res: Response,
  message: { sessionId: string; timestamp: string; signature?: string },
): Promise<typeof brokerSessions.$inferSelect | null> {
  const recipient = await resolveRecipient(req, res);
  if (!recipient) return null;

  const [session] = await db
    .select()
    .from(brokerSessions)
    .where(
      and(
        eq(brokerSessions.cfpSessionId, message.sessionId),
        eq(brokerSessions.localTenantId, recipient.tenantId),
      ),
    )
    .limit(1);

  // Same answer for "no such session" and "not signed by its peer", so the
  // endpoint cannot be used to probe for session ids.
  const remoteDid = session?.peerDid ?? null;
  const authentic =
    remoteDid !== null &&
    isFresh(message.timestamp) &&
    (await verifyMessage(getResolver(), remoteDid, req.body));

  if (!session || !authentic) {
    res.status(403).json({ error: "Unknown session or invalid signature" });
    return null;
  }
  return session;
}

// ── HELLO → CHALLENGE ────────────────────────────────────────────────────

federationMessagesRouter.post(
  "/api/federation/messages/hello",
  async (req, res) => {
    const parsed = helloSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid HELLO message", details: parsed.error.issues });
      return;
    }
    // Verify over the body as transmitted: the signature covers its key order.
    const hello = req.body as HelloMessage;

    const ip = clientIp(req);
    if (!helloByDid.check(hello.collectiveDid) || !helloByIp.check(ip)) {
      res.status(429).json({ error: "Rate limit exceeded" });
      return;
    }

    const recipient = await resolveRecipient(req, res);
    if (!recipient) return;

    if (!isFresh(hello.timestamp)) {
      res.status(403).json({ error: "HELLO timestamp outside accepted window" });
      return;
    }

    // Federation is only negotiated over a link both operators approved.
    const link = await findActiveLinkByDid(recipient.tenantId, hello.collectiveDid);

    const sign = (payload: string) => signAsCollective(recipient.tenantId, payload);
    const callbacks = makeHandshakeCallbacks({
      sign,
      resolver: getResolver(),
      evaluatePolicy: async () => link !== null,
      routes: [],
    });

    const result = await handleHello(
      createHandshake(recipient.did),
      hello,
      link?.localCidrs ?? [],
      LOCAL_CAPABILITIES,
      callbacks,
    );

    if (!result.ok || !link) {
      logger.warn(
        { remoteDid: hello.collectiveDid, localDid: recipient.did, error: result.ok ? "no link" : result.error },
        "HELLO rejected",
      );
      res.status(403).json({ error: result.ok ? "Policy denied federation" : result.error });
      return;
    }

    rememberHandshake(result.state.challengeNonce!, {
      state: result.state,
      localTenantId: recipient.tenantId,
      linkId: link.id,
      remoteCidrs: link.peerCidrs,
      expiresAt: result.state.challengeExpiresAt!.getTime(),
    });

    logger.info(
      { remoteDid: hello.collectiveDid, localDid: recipient.did, linkId: link.id },
      "HELLO accepted, CHALLENGE sent",
    );
    res.json(result.message);
  },
);

// ── COMMIT → ESTABLISHED ─────────────────────────────────────────────────

federationMessagesRouter.post(
  "/api/federation/messages/commit",
  async (req, res) => {
    const parsed = commitSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid COMMIT message", details: parsed.error.issues });
      return;
    }
    const commit = req.body as CommitMessage;

    const recipient = await resolveRecipient(req, res);
    if (!recipient) return;

    const pending = pendingHandshakes.get(commit.challengeNonce);
    // The nonce is single-use, and only the collective that sent the HELLO
    // (and so received this challenge) may answer it.
    if (
      !pending ||
      pending.localTenantId !== recipient.tenantId ||
      pending.state.remoteDid !== commit.collectiveDid
    ) {
      res.status(404).json({ error: "No pending handshake for this nonce" });
      return;
    }
    pendingHandshakes.delete(commit.challengeNonce);

    // Operators may have revoked the link since the HELLO.
    const link = await findActiveLinkByDid(recipient.tenantId, commit.collectiveDid);
    if (!link || link.id !== pending.linkId) {
      res.status(403).json({ error: "Policy denied federation" });
      return;
    }

    const sign = (payload: string) => signAsCollective(recipient.tenantId, payload);
    const callbacks = makeHandshakeCallbacks({
      sign,
      resolver: getResolver(),
      evaluatePolicy: async () => true,
      routes: await buildAnnouncements(recipient.did, link.localCidrs, sign),
    });

    const result = await handleCommit(pending.state, commit, callbacks);
    if (!result.ok) {
      logger.warn({ remoteDid: commit.collectiveDid, error: result.error }, "COMMIT rejected");
      res.status(403).json({ error: result.error });
      return;
    }

    await markSessionEstablished(
      link.id,
      recipient.tenantId,
      result.state.sessionId!,
      filterImportedPrefixes(commit.initialRoutes, link.peerCidrs, commit.collectiveDid),
    );

    logger.info(
      { remoteDid: commit.collectiveDid, linkId: link.id, cfpSessionId: result.state.sessionId },
      "COMMIT accepted, session ESTABLISHED",
    );
    res.json(result.message);
  },
);

// ── KEEPALIVE ────────────────────────────────────────────────────────────

federationMessagesRouter.post(
  "/api/federation/messages/keepalive",
  async (req, res) => {
    const parsed = keepaliveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid KEEPALIVE message", details: parsed.error.issues });
      return;
    }
    const keepalive = req.body as KeepaliveMessage;

    const session = await authenticateSessionMessage(req, res, keepalive);
    if (!session) return;

    if (session.status === "disconnected") {
      res.status(410).json({ error: "Session revoked" });
      return;
    }

    await db
      .update(brokerSessions)
      .set({
        lastKeepalive: new Date(),
        status: session.status === "degraded" ? "established" : session.status,
        updatedAt: new Date(),
      })
      .where(eq(brokerSessions.id, session.id));

    res.json({
      type: "KEEPALIVE",
      sessionId: keepalive.sessionId,
      sequenceNumber: keepalive.sequenceNumber,
      timestamp: new Date().toISOString(),
    });
  },
);

// ── REVOKE ───────────────────────────────────────────────────────────────

federationMessagesRouter.post(
  "/api/federation/messages/revoke",
  async (req, res) => {
    const parsed = revokeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid REVOKE message", details: parsed.error.issues });
      return;
    }
    const revoke = req.body as RevokeMessage;

    const session = await authenticateSessionMessage(req, res, revoke);
    if (!session) return;

    await db
      .update(brokerSessions)
      .set({ status: "disconnected", importedRoutes: [], updatedAt: new Date() })
      .where(eq(brokerSessions.id, session.id));

    await withdrawFederatedRoutes(session.localTenantId, session.importedRoutes);

    logger.info(
      { sessionId: session.id, reason: revoke.reason, permanent: revoke.permanent },
      "peer revoked federation session",
    );

    res.json({ status: "revoked", sessionId: revoke.sessionId });
  },
);

// ── Helpers for link negotiation ────────────────────────────────────────

/** Look up a tenant's federation posture. */
async function getTenantPosture(
  tenantId: string,
): Promise<{ posture: string; lockdownMode: boolean } | null> {
  const [row] = await db
    .select({
      posture: tenants.federationPosture,
      lockdownMode: tenants.lockdownMode,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return row ?? null;
}

/** Count pending inbound link requests for a tenant. */
async function countPendingInbound(tenantId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(federationLinks)
    .where(
      and(
        eq(federationLinks.localTenantId, tenantId),
        eq(federationLinks.direction, "incoming"),
        eq(federationLinks.status, "pending"),
      ),
    );
  return row?.count ?? 0;
}

/** Expire oldest pending inbound requests beyond the cap. */
async function expireOldestPending(tenantId: string): Promise<void> {
  const count = await countPendingInbound(tenantId);
  if (count <= MAX_PENDING_PER_COLLECTIVE) return;

  const excess = count - MAX_PENDING_PER_COLLECTIVE + 1;
  const oldest = await db
    .select({ id: federationLinks.id })
    .from(federationLinks)
    .where(
      and(
        eq(federationLinks.localTenantId, tenantId),
        eq(federationLinks.direction, "incoming"),
        eq(federationLinks.status, "pending"),
      ),
    )
    .orderBy(federationLinks.createdAt)
    .limit(excess);

  if (oldest.length > 0) {
    for (const row of oldest) {
      await db
        .update(federationLinks)
        .set({ status: "rejected", updatedAt: new Date() })
        .where(eq(federationLinks.id, row.id));
    }
    logger.info(
      { tenantId, expired: oldest.length },
      "expired oldest pending inbound link requests",
    );
  }
}

/** Authenticate a link negotiation message: verify signature and freshness. */
async function authenticateLinkMessage(
  req: Request,
  res: Response,
  senderDid: string,
  messageId: string,
  timestamp: string,
): Promise<boolean> {
  if (!isFresh(timestamp)) {
    res.status(403).json({ error: "Message timestamp outside accepted window" });
    return false;
  }
  if (!linkMessageReplay.check(messageId)) {
    res.status(409).json({ error: "Message already processed" });
    return false;
  }
  if (!(await verifyMessage(getResolver(), senderDid, req.body))) {
    res.status(403).json({ error: "Invalid signature" });
    return false;
  }
  return true;
}

// ── LINK_REQUEST ────────────────────────────────────────────────────────

federationMessagesRouter.post(
  "/api/federation/messages/link-request",
  async (req, res) => {
    const parsed = linkRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid LINK_REQUEST message", details: parsed.error.issues });
      return;
    }
    const msg = req.body as LinkRequestMessage;

    const ip = clientIp(req);
    if (!linkRequestByDid.check(msg.collectiveDid) || !linkRequestByIp.check(ip)) {
      res.status(429).json({ error: "Rate limit exceeded" });
      return;
    }

    const recipient = await resolveRecipient(req, res);
    if (!recipient) return;

    const tenantInfo = await getTenantPosture(recipient.tenantId);
    if (!tenantInfo) {
      res.status(404).json({ error: "Unknown recipient collective" });
      return;
    }

    if (tenantInfo.lockdownMode) {
      res.status(403).json({ error: "Recipient is in lockdown mode" });
      return;
    }

    if (tenantInfo.posture === "closed") {
      res.status(403).json({ error: "Recipient does not accept federation requests" });
      return;
    }

    if (!await authenticateLinkMessage(req, res, msg.collectiveDid, msg.messageId, msg.timestamp)) {
      return;
    }

    if (!isAllowedBrokerUrl(msg.brokerUrl)) {
      res.status(400).json({ error: "Broker URL not allowed" });
      return;
    }

    const existing = await db
      .select({ id: federationLinks.id })
      .from(federationLinks)
      .where(
        and(
          eq(federationLinks.localTenantId, recipient.tenantId),
          eq(federationLinks.peerDid, msg.collectiveDid),
          sql`status IN ('pending', 'active')`,
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      res.status(409).json({ error: "Active or pending link already exists with this peer" });
      return;
    }

    await expireOldestPending(recipient.tenantId);

    await db.insert(federationLinks).values({
      localTenantId: recipient.tenantId,
      peerDid: msg.collectiveDid,
      peerBrokerUrl: msg.brokerUrl,
      peerName: msg.collectiveName,
      direction: "incoming",
      message: msg.message,
      localCidrs: [],
      peerCidrs: msg.offeredCidrs,
      signedRequest: JSON.stringify(req.body),
    });

    logger.info(
      { remoteDid: msg.collectiveDid, localDid: recipient.did, tenantId: recipient.tenantId },
      "inbound LINK_REQUEST queued",
    );

    res.status(201).json({ status: "queued" });
  },
);

// ── LINK_ACCEPT ─────────────────────────────────────────────────────────

federationMessagesRouter.post(
  "/api/federation/messages/link-accept",
  async (req, res) => {
    const parsed = linkAcceptSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid LINK_ACCEPT message", details: parsed.error.issues });
      return;
    }
    const msg = req.body as LinkAcceptMessage;

    const recipient = await resolveRecipient(req, res);
    if (!recipient) return;

    if (!await authenticateLinkMessage(req, res, msg.collectiveDid, msg.messageId, msg.timestamp)) {
      return;
    }

    const [link] = await db
      .select()
      .from(federationLinks)
      .where(
        and(
          eq(federationLinks.localTenantId, recipient.tenantId),
          eq(federationLinks.peerDid, msg.collectiveDid),
          eq(federationLinks.direction, "outgoing"),
          eq(federationLinks.status, "pending"),
        ),
      )
      .limit(1);

    if (!link) {
      res.status(404).json({ error: "No pending outgoing link to this peer" });
      return;
    }

    await db
      .update(federationLinks)
      .set({
        status: "active",
        peerCidrs: msg.acceptedCidrs,
        peerBrokerUrl: msg.brokerUrl,
        peerName: msg.collectiveName,
        updatedAt: new Date(),
      })
      .where(eq(federationLinks.id, link.id));

    logger.info(
      { remoteDid: msg.collectiveDid, linkId: link.id },
      "inbound LINK_ACCEPT — link active",
    );

    setImmediate(() => {
      initiateOutboundHandshake(link.id, link.localTenantId).catch((err) => {
        logger.warn({ linkId: link.id, err }, "failed to initiate handshake after link accept");
      });
    });

    res.json({ status: "accepted" });
  },
);

// ── LINK_REJECT ─────────────────────────────────────────────────────────

federationMessagesRouter.post(
  "/api/federation/messages/link-reject",
  async (req, res) => {
    const parsed = linkRejectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid LINK_REJECT message", details: parsed.error.issues });
      return;
    }
    const msg = req.body as LinkRejectMessage;

    const recipient = await resolveRecipient(req, res);
    if (!recipient) return;

    if (!await authenticateLinkMessage(req, res, msg.collectiveDid, msg.messageId, msg.timestamp)) {
      return;
    }

    const [link] = await db
      .select()
      .from(federationLinks)
      .where(
        and(
          eq(federationLinks.localTenantId, recipient.tenantId),
          eq(federationLinks.peerDid, msg.collectiveDid),
          eq(federationLinks.direction, "outgoing"),
          eq(federationLinks.status, "pending"),
        ),
      )
      .limit(1);

    if (!link) {
      res.status(404).json({ error: "No pending outgoing link to this peer" });
      return;
    }

    await db
      .update(federationLinks)
      .set({ status: "rejected", updatedAt: new Date() })
      .where(eq(federationLinks.id, link.id));

    logger.info(
      { remoteDid: msg.collectiveDid, linkId: link.id, reason: msg.reason },
      "inbound LINK_REJECT — link rejected",
    );

    res.json({ status: "rejected" });
  },
);

// ── LINK_REVOKE ─────────────────────────────────────────────────────────

federationMessagesRouter.post(
  "/api/federation/messages/link-revoke",
  async (req, res) => {
    const parsed = linkRevokeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid LINK_REVOKE message", details: parsed.error.issues });
      return;
    }
    const msg = req.body as LinkRevokeMessage;

    const recipient = await resolveRecipient(req, res);
    if (!recipient) return;

    if (!await authenticateLinkMessage(req, res, msg.collectiveDid, msg.messageId, msg.timestamp)) {
      return;
    }

    const [link] = await db
      .select()
      .from(federationLinks)
      .where(
        and(
          eq(federationLinks.localTenantId, recipient.tenantId),
          eq(federationLinks.peerDid, msg.collectiveDid),
          sql`status IN ('pending', 'active')`,
        ),
      )
      .limit(1);

    if (!link) {
      res.status(404).json({ error: "No active or pending link with this peer" });
      return;
    }

    await db
      .update(federationLinks)
      .set({ status: "revoked", updatedAt: new Date() })
      .where(eq(federationLinks.id, link.id));

    if (link.status === "active") {
      const [session] = await db
        .select()
        .from(brokerSessions)
        .where(
          and(
            eq(brokerSessions.federationLinkId, link.id),
            eq(brokerSessions.localTenantId, recipient.tenantId),
          ),
        )
        .limit(1);

      if (session) {
        await db
          .update(brokerSessions)
          .set({ status: "disconnected", importedRoutes: [], updatedAt: new Date() })
          .where(eq(brokerSessions.id, session.id));
        await withdrawFederatedRoutes(session.localTenantId, session.importedRoutes);
      }
    }

    logger.info(
      { remoteDid: msg.collectiveDid, linkId: link.id, permanent: msg.permanent },
      "inbound LINK_REVOKE — link revoked",
    );

    res.json({ status: "revoked" });
  },
);
