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
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { brokerSessions, collectiveDids } from "../db/schema.js";
import { logger } from "../logger.js";
import {
  LOCAL_CAPABILITIES,
  findActiveLink,
  getCollectiveDid,
  linkSide,
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
import type {
  HelloMessage,
  CommitMessage,
  KeepaliveMessage,
  RevokeMessage,
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

async function tenantForDid(remoteDid: string): Promise<string | null> {
  const [row] = await db
    .select({ tenantId: collectiveDids.tenantId })
    .from(collectiveDids)
    .where(eq(collectiveDids.did, remoteDid))
    .limit(1);
  return row?.tenantId ?? null;
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
  const remoteDid = session ? await getCollectiveDid(session.remoteTenantId) : null;
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

    const recipient = await resolveRecipient(req, res);
    if (!recipient) return;

    if (!isFresh(hello.timestamp)) {
      res.status(403).json({ error: "HELLO timestamp outside accepted window" });
      return;
    }

    // Federation is only negotiated over a link both operators approved.
    const remoteTenantId = await tenantForDid(hello.collectiveDid);
    const link = remoteTenantId
      ? await findActiveLink(recipient.tenantId, remoteTenantId)
      : null;
    const side = link ? linkSide(link, recipient.tenantId) : null;

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
      side?.localCidrs ?? [],
      LOCAL_CAPABILITIES,
      callbacks,
    );

    if (!result.ok || !link || !side) {
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
      remoteCidrs: side.remoteCidrs,
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
    const remoteTenantId = await tenantForDid(commit.collectiveDid);
    const link = remoteTenantId
      ? await findActiveLink(recipient.tenantId, remoteTenantId)
      : null;
    if (!link || link.id !== pending.linkId) {
      res.status(403).json({ error: "Policy denied federation" });
      return;
    }
    const side = linkSide(link, recipient.tenantId);

    const sign = (payload: string) => signAsCollective(recipient.tenantId, payload);
    const callbacks = makeHandshakeCallbacks({
      sign,
      resolver: getResolver(),
      evaluatePolicy: async () => true,
      routes: await buildAnnouncements(recipient.did, side.localCidrs, sign),
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
      filterImportedPrefixes(commit.initialRoutes, side.remoteCidrs, commit.collectiveDid),
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
