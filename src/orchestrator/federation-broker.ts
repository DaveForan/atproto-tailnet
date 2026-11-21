/**
 * @module orchestrator/federation-broker
 * Federation Control Plane: broker sessions, relays, routes and collective DIDs (ADR-0010, ADR-0016).
 * Each link row is one side of a federation. The accepting ("incoming") side starts the handshake.
 */

import * as crypto from "node:crypto";
import * as jose from "jose";
import { eq, and, ne, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  federationLinks,
  brokerSessions,
  relayNodes,
  collectiveDids,
  tenants,
} from "../db/schema.js";
import { config, tenantPublicUrl } from "../config.js";
import { getControlClient, getCoordinatorClient, useCoordinator } from "./control-client.js";
import { createRelayHalf, destroyRelayHalf, isRelayHalfRunning } from "./relay.js";
import { logger } from "../logger.js";
import { sendMessage, sendKeepalive, sendRevoke } from "../federation/transport.js";
import { isAllowedBrokerUrl } from "../federation/discovery.js";
import {
  afterAttempt,
  classifyDelivery,
  isDue,
  newOutboxEntry,
  parseOutboxEntry,
  type DeliveryOutcome,
  type OutboxEntry,
  type UnsignedLinkMessage,
} from "../federation/outbox.js";
import { logAudit } from "../audit/log.js";
import {
  createHandshake,
  initiateHello,
  handleChallenge,
  handleEstablished,
} from "../federation/handshake.js";
import {
  buildAnnouncements,
  filterImportedPrefixes,
  isFresh,
  makeHandshakeCallbacks,
  signMessage,
  verifyMessage,
} from "../federation/auth.js";
import { getResolver } from "../identity/resolver.js";
import {
  cidrsOverlap,
  isDefaultRoute,
  parseCidr,
  validateLocalOffer,
  validatePeerOffer,
} from "../federation/cidr.js";
import { encryptPrivateKey, loadPrivateKey, signDetached } from "../identity/keys.js";
import type {
  Capability,
  ChallengeMessage,
  EstablishedMessage,
} from "../federation/protocol.js";
import { isLeader } from "./leader.js";

const BROKER_TICK_MS = 30_000;
const KEEPALIVE_STALE_MS = 90_000;

export const LOCAL_CAPABILITIES: Capability[] = ["route-exchange"];

/**
 * Security: only relays with this tag get auto-approval for federated routes.
 * A member device that advertises a peer's CIDRs is not approved.
 */
export const FEDERATION_RELAY_TAG = "tag:federation-relay";

type FederationLink = typeof federationLinks.$inferSelect;
type BrokerSession = typeof brokerSessions.$inferSelect;

let brokerInterval: ReturnType<typeof setInterval> | null = null;
let tickRunning = false;
const handshakesInFlight = new Set<string>();

export function startBroker(): void {
  if (brokerInterval) return;
  logger.info("federation broker starting");
  brokerInterval = setInterval(brokerTick, BROKER_TICK_MS);
  brokerTick();
}

export function stopBroker(): void {
  if (brokerInterval) {
    clearInterval(brokerInterval);
    brokerInterval = null;
    logger.info("federation broker stopped");
  }
}

async function brokerTick(): Promise<void> {
  // With several replicas, only the leader runs the broker loop (ADR-0034)
  if (!isLeader()) return;
  if (tickRunning) return;
  tickRunning = true;
  try {
    await deliverPendingLinkMessages();
    await reconcileActiveSessions();
    await sendKeepalives();
    await checkSessionHealth();
    await checkRelayHealth();
    await reconcileCoordinatorAutoApprovers();
  } catch (err) {
    logger.error({ err }, "federation broker tick failed");
  } finally {
    tickRunning = false;
  }
}


async function reconcileActiveSessions(): Promise<void> {
  const activeLinks = await db
    .select()
    .from(federationLinks)
    .where(eq(federationLinks.status, "active"));

  for (const link of activeLinks) {
    await ensureSessionsForLink(link);
  }

  const activeIds = new Set(activeLinks.map((l) => l.id));
  const sessions = await db.select().from(brokerSessions);
  for (const session of sessions) {
    if (!activeIds.has(session.federationLinkId)) {
      await teardownBrokerSession(session);
    }
  }

  // Re-handshake unhealthy sessions of active links. The incoming side initiates.
  // Per-link exponential backoff protects an unreachable peer.
  const now = Date.now();
  for (const link of activeLinks) {
    if (link.direction !== "incoming") continue;
    // ADR-0014 §6: a permanently revoked link is never re-established. This guards a stale row.
    if (link.revokedPermanently) continue;

    const [session] = await db
      .select({ id: brokerSessions.id, status: brokerSessions.status })
      .from(brokerSessions)
      .where(
        and(
          eq(brokerSessions.federationLinkId, link.id),
          eq(brokerSessions.localTenantId, link.localTenantId),
          inArray(brokerSessions.status, RECOVERABLE_SESSION_STATUSES),
        ),
      )
      .limit(1);

    if (!session) {
      handshakeBackoff.delete(link.id);
      continue;
    }

    const backoff = handshakeBackoff.get(link.id);
    if (backoff && backoff.nextAttemptAt > now) continue;
    if (handshakesInFlight.has(link.id)) continue;

    const ok = await initiateOutboundHandshake(link.id, link.localTenantId).catch((err) => {
      logger.warn({ linkId: link.id, err }, "federation handshake attempt failed");
      return false;
    });

    if (ok) {
      handshakeBackoff.delete(link.id);
    } else {
      const failures = (backoff?.failures ?? 0) + 1;
      const delay = handshakeRetryDelayMs(failures);
      handshakeBackoff.set(link.id, { failures, nextAttemptAt: Date.now() + delay });
      logger.info(
        { linkId: link.id, sessionStatus: session.status, failures, retryInMs: delay },
        "federation handshake will be retried",
      );
    }
  }

  for (const linkId of handshakeBackoff.keys()) {
    if (!activeIds.has(linkId)) handshakeBackoff.delete(linkId);
  }
}

const RECOVERABLE_SESSION_STATUSES: BrokerSession["status"][] = ["connecting", "disconnected", "degraded"];

const HANDSHAKE_RETRY_BASE_MS = BROKER_TICK_MS;
const HANDSHAKE_RETRY_MAX_MS = 30 * 60_000;

/** In memory only, so a restart retries at once. */
const handshakeBackoff = new Map<string, { failures: number; nextAttemptAt: number }>();

/** 30s, 60s, 120s, and so on, up to 30 min, with ±20% jitter. */
export function handshakeRetryDelayMs(failures: number, random: () => number = Math.random): number {
  const exp = Math.min(HANDSHAKE_RETRY_MAX_MS, HANDSHAKE_RETRY_BASE_MS * 2 ** Math.max(0, failures - 1));
  return Math.round(exp * (0.8 + 0.4 * random()));
}

async function ensureSessionsForLink(link: FederationLink): Promise<void> {
  const [session] = await db
    .insert(brokerSessions)
    .values({
      federationLinkId: link.id,
      localTenantId: link.localTenantId,
      peerDid: link.peerDid,
      status: "connecting",
      remoteEndpoint: link.peerBrokerUrl ?? config.publicUrl,
      protocolVersion: link.protocolVersion,
      exportedRoutes: link.localCidrs,
      // The completed handshake fills this from the peer's announcements
      importedRoutes: [],
    })
    .onConflictDoNothing()
    .returning();

  if (session) {
    logger.info(
      { linkId: link.id, sessionId: session.id, localTenantId: link.localTenantId },
      "created broker session for federation link",
    );
    if (link.direction === "outgoing") {
      await provisionRelayNode(session.id, link);
    }
  }
}

async function provisionRelayNode(
  sessionId: string,
  link: FederationLink,
): Promise<void> {
  logger.info(
    { sessionId, linkId: link.id },
    "provisioning relay node for broker session",
  );

  const [relay] = await db
    .insert(relayNodes)
    .values({
      brokerSessionId: sessionId,
      advertisedRoutes: link.peerCidrs,
      status: "provisioning",
    })
    .returning();

  try {
    const [tenant] = await db
      .select({ slug: tenants.slug, port: tenants.port, apiKey: tenants.apiKey, status: tenants.status, coordinatorTenantId: tenants.coordinatorTenantId })
      .from(tenants)
      .where(eq(tenants.id, link.localTenantId))
      .limit(1);

    if (!tenant?.port || tenant.status !== "running") {
      logger.warn({ tenantId: link.localTenantId }, "tenant not running, deferring relay provisioning");
      return;
    }

    const client = getControlClient(tenant);

    const authKey = await client.createTaggedPreAuthKey([FEDERATION_RELAY_TAG], {
      expirationSeconds: 300,
    });


    const containerId = await createRelayHalf({
      tenantSlug: tenant.slug,
      loginServer: tenantPublicUrl(tenant.slug),
      authKey: authKey.key,
      advertisedRoutes: link.peerCidrs,
      localCidrs: link.localCidrs,
      peerCidrs: link.peerCidrs,
      linkId: link.id,
      side: "local",
    });

    await db
      .update(relayNodes)
      .set({
        containerId,
        status: "active",
        updatedAt: new Date(),
      })
      .where(eq(relayNodes.id, relay.id));

    logger.info(
      { sessionId, linkId: link.id, containerId },
      "relay half provisioned and active",
    );
  } catch (err) {
    logger.error({ sessionId, linkId: link.id, err }, "relay half provisioning failed");
    await db
      .update(relayNodes)
      .set({ status: "unhealthy", updatedAt: new Date() })
      .where(eq(relayNodes.id, relay.id));
  }
}

async function teardownBrokerSession(stale: BrokerSession): Promise<void> {
  // Re-read, because the peer's own teardown can have revoked this session just now
  const [session] = await db
    .select()
    .from(brokerSessions)
    .where(eq(brokerSessions.id, stale.id))
    .limit(1);
  if (!session) return;

  logger.info({ sessionId: session.id }, "tearing down broker session");

  if (session.cfpSessionId && session.remoteEndpoint && session.status !== "disconnected") {
    try {
      // Teardown happens only after the link left "active". That is final, so the peer must not retry.
      const revoke = await signMessage(
        {
          type: "REVOKE" as const,
          sessionId: session.cfpSessionId,
          reason: "link revoked",
          permanent: true,
          timestamp: new Date().toISOString(),
        },
        (payload) => signAsCollective(session.localTenantId, payload),
      );
      await sendRevoke(session.remoteEndpoint, revoke, session.peerDid);
    } catch (err) {
      logger.warn({ sessionId: session.id, err }, "failed to notify peer of revocation");
    }
  }

  const relays = await db
    .select()
    .from(relayNodes)
    .where(eq(relayNodes.brokerSessionId, session.id));

  for (const relay of relays) {
    try {
      if (relay.containerId) {
        await destroyRelayHalf(relay.containerId);
      }
      if (relay.headscaleNodeId) {
        const [tenant] = await db
          .select({ port: tenants.port, apiKey: tenants.apiKey, status: tenants.status, coordinatorTenantId: tenants.coordinatorTenantId })
          .from(tenants)
          .where(eq(tenants.id, session.localTenantId))
          .limit(1);
        if (tenant?.port && tenant.status === "running") {
          const client = getControlClient(tenant);
          await client.deleteNode(relay.headscaleNodeId);
        }
      }
    } catch (err) {
      logger.warn({ relayId: relay.id, err }, "failed to clean up relay half");
    }
  }

  await db.delete(relayNodes).where(eq(relayNodes.brokerSessionId, session.id));
  await db.delete(brokerSessions).where(eq(brokerSessions.id, session.id));

  await withdrawFederatedRoutes(session.localTenantId, session.importedRoutes);
}


async function sendKeepalives(): Promise<void> {
  const sessions = await db
    .select()
    .from(brokerSessions)
    .where(inArray(brokerSessions.status, ["established", "degraded"]));

  for (const session of sessions) {
    if (!session.remoteEndpoint || !session.cfpSessionId) continue;

    try {
      const keepalive = await signMessage(
        {
          type: "KEEPALIVE" as const,
          sessionId: session.cfpSessionId,
          sequenceNumber: Date.now(),
          timestamp: new Date().toISOString(),
        },
        (payload) => signAsCollective(session.localTenantId, payload),
      );

      // A successful round-trip proves that the peer still holds the session
      if (await sendKeepalive(session.remoteEndpoint, keepalive, session.peerDid)) {
        await db
          .update(brokerSessions)
          .set({ status: "established", lastKeepalive: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(brokerSessions.id, session.id),
              inArray(brokerSessions.status, ["established", "degraded"]),
            ),
          );
      }
    } catch (err) {
      logger.warn({ sessionId: session.id, err }, "failed to send federation keepalive");
    }
  }
}

async function checkSessionHealth(): Promise<void> {
  const now = Date.now();
  const sessions = await db
    .select()
    .from(brokerSessions)
    .where(eq(brokerSessions.status, "established"));

  for (const session of sessions) {
    if (
      session.lastKeepalive &&
      now - session.lastKeepalive.getTime() > KEEPALIVE_STALE_MS
    ) {
      logger.warn(
        { sessionId: session.id },
        "broker session keepalive stale, marking degraded",
      );
      await db
        .update(brokerSessions)
        .set({ status: "degraded", updatedAt: new Date() })
        .where(eq(brokerSessions.id, session.id));
    }
  }
}

async function checkRelayHealth(): Promise<void> {
  const relays = await db
    .select()
    .from(relayNodes)
    .where(inArray(relayNodes.status, ["active", "unhealthy", "provisioning"]));

  for (const relay of relays) {
    if (!relay.containerId) continue;

    try {
      const running = await isRelayHalfRunning(relay.containerId);

      if (running && relay.status !== "active") {
        await db
          .update(relayNodes)
          .set({ status: "active", lastHealthCheck: new Date(), updatedAt: new Date() })
          .where(eq(relayNodes.id, relay.id));
      } else if (!running && relay.status === "active") {
        logger.warn({ relayId: relay.id, containerId: relay.containerId }, "relay half not running");
        await db
          .update(relayNodes)
          .set({ status: "unhealthy", lastHealthCheck: new Date(), updatedAt: new Date() })
          .where(eq(relayNodes.id, relay.id));
      } else {
        await db
          .update(relayNodes)
          .set({ lastHealthCheck: new Date() })
          .where(eq(relayNodes.id, relay.id));
      }
    } catch (err) {
      logger.warn({ relayId: relay.id, err }, "relay health check failed");
    }
  }
}


/** did:web percent-encodes the port separator, so `localhost:3000` becomes `localhost%3A3000`. */
export function collectiveDidHost(): string {
  return encodeURIComponent(new URL(config.publicUrl).host);
}

export async function ensureCollectiveDid(
  tenantId: string,
  domain: string = collectiveDidHost(),
): Promise<{ did: string; publicKeyJwk: JsonWebKey }> {
  const [existing] = await db
    .select()
    .from(collectiveDids)
    .where(eq(collectiveDids.tenantId, tenantId));

  if (existing) {
    return {
      did: existing.did,
      publicKeyJwk: existing.publicKeyJwk as JsonWebKey,
    };
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyJwk = publicKey.export({ format: "jwk" });
  const privateKeyPem = privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();

  const [tenant] = await db
    .select({ slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.id, tenantId));

  const did = `did:web:${domain}:collective:${tenant?.slug ?? tenantId}`;

  await db.insert(collectiveDids).values({
    tenantId,
    did,
    publicKeyJwk,
    encryptedPrivateKey: encryptPrivateKey(
      privateKeyPem,
      config.federationKeyEncryptionKey,
    ),
  });

  logger.info({ tenantId, did }, "created collective DID");

  return { did, publicKeyJwk };
}

export async function rotateCollectiveDid(
  tenantId: string,
  domain: string = collectiveDidHost(),
): Promise<{ did: string; publicKeyJwk: JsonWebKey }> {
  await db.delete(collectiveDids).where(eq(collectiveDids.tenantId, tenantId));
  return ensureCollectiveDid(tenantId, domain);
}

/** RFC 7638 thumbprint, for display. */
export function publicKeyFingerprint(publicKeyJwk: JsonWebKey): Promise<string> {
  return jose.calculateJwkThumbprint(publicKeyJwk as jose.JWK, "sha256");
}

/** Returns null when the collective has no DID yet. */
export async function loadCollectiveKeyPair(tenantId: string): Promise<{
  did: string;
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
} | null> {
  const [row] = await db
    .select({
      did: collectiveDids.did,
      encryptedPrivateKey: collectiveDids.encryptedPrivateKey,
    })
    .from(collectiveDids)
    .where(eq(collectiveDids.tenantId, tenantId))
    .limit(1);

  if (!row) return null;

  const privateKey = loadPrivateKey(
    row.encryptedPrivateKey,
    config.federationKeyEncryptionKey,
  );
  return { did: row.did, privateKey, publicKey: crypto.createPublicKey(privateKey) };
}

/** Returns a detached JWS. */
export async function signAsCollective(
  tenantId: string,
  payload: string,
): Promise<string> {
  const keys = await loadCollectiveKeyPair(tenantId);
  if (!keys) throw new Error("No collective DID configured");
  return signDetached(keys.privateKey, payload);
}


/** Initiator and responder both call this. It also installs the imported routes. */
export async function markSessionEstablished(
  linkId: string,
  localTenantId: string,
  cfpSessionId: string,
  importedPrefixes: string[],
): Promise<void> {
  await db
    .update(brokerSessions)
    .set({
      status: "established",
      cfpSessionId,
      importedRoutes: importedPrefixes,
      lastKeepalive: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(brokerSessions.federationLinkId, linkId),
        eq(brokerSessions.localTenantId, localTenantId),
      ),
    );

  await installFederatedRoutes(localTenantId, importedPrefixes);
}

/**
 * CFP initiator: HELLO → (CHALLENGE) → COMMIT → (ESTABLISHED). Returns true when established.
 * Security: we verify each reply against the peer's DID before use.
 */
export async function initiateOutboundHandshake(
  linkId: string,
  localTenantId: string,
): Promise<boolean> {
  if (handshakesInFlight.has(linkId)) return false;
  handshakesInFlight.add(linkId);

  try {
    const [link] = await db
      .select()
      .from(federationLinks)
      .where(eq(federationLinks.id, linkId))
      .limit(1);

    if (!link || link.status !== "active") {
      logger.warn({ linkId }, "cannot initiate handshake: link not active");
      return false;
    }
    if (link.localTenantId !== localTenantId) {
      logger.warn({ linkId, localTenantId }, "cannot initiate handshake: not a party to the link");
      return false;
    }

    await ensureSessionsForLink(link);

    const { did: localDid } = await ensureCollectiveDid(localTenantId);
    const remoteDid = link.peerDid;
    const peerBrokerUrl = link.peerBrokerUrl ?? config.publicUrl;

    const sign = (payload: string) => signAsCollective(localTenantId, payload);
    const resolver = getResolver();
    const callbacks = makeHandshakeCallbacks({
      sign,
      resolver,
      evaluatePolicy: async () => true,
      routes: await buildAnnouncements(localDid, link.localCidrs, sign),
    });

    const hello = await initiateHello(
      createHandshake(localDid),
      remoteDid,
      "peer",
      link.localCidrs,
      LOCAL_CAPABILITIES,
      callbacks,
    );

    logger.info({ linkId, remoteDid, endpoint: peerBrokerUrl }, "sending HELLO");
    const helloResult = await sendMessage(peerBrokerUrl, hello.message, remoteDid);
    if (!helloResult.ok) {
      logger.warn({ linkId, error: helloResult.error }, "HELLO rejected");
      return false;
    }

    const challenge = helloResult.response as ChallengeMessage | undefined;
    if (
      challenge?.type !== "CHALLENGE" ||
      challenge.collectiveDid !== remoteDid ||
      !isFresh(challenge.timestamp) ||
      !(await verifyMessage(resolver, remoteDid, challenge))
    ) {
      logger.warn({ linkId, remoteDid }, "peer returned an invalid CHALLENGE");
      return false;
    }

    const commit = await handleChallenge(hello.state, challenge, callbacks);
    if (!commit.ok) {
      logger.warn({ linkId, error: commit.error }, "CHALLENGE not accepted");
      return false;
    }

    const commitResult = await sendMessage(peerBrokerUrl, commit.message, remoteDid);
    if (!commitResult.ok) {
      logger.warn({ linkId, error: commitResult.error }, "COMMIT rejected");
      return false;
    }

    const established = commitResult.response as EstablishedMessage | undefined;
    if (
      established?.type !== "ESTABLISHED" ||
      established.collectiveDid !== remoteDid ||
      typeof established.sessionId !== "string" ||
      !isFresh(established.timestamp) ||
      !(await verifyMessage(resolver, remoteDid, established))
    ) {
      logger.warn({ linkId, remoteDid }, "peer returned an invalid ESTABLISHED");
      return false;
    }

    const finalState = handleEstablished(commit.state, established);
    if (finalState.phase !== "established" || !finalState.sessionId) {
      logger.warn({ linkId, error: finalState.error }, "handshake did not complete");
      return false;
    }

    await markSessionEstablished(
      linkId,
      localTenantId,
      finalState.sessionId,
      filterImportedPrefixes(established.initialRoutes, link.peerCidrs, remoteDid),
    );

    logger.info(
      { linkId, cfpSessionId: finalState.sessionId },
      "federation handshake completed",
    );
    return true;
  } finally {
    handshakesInFlight.delete(linkId);
  }
}


/** The broker URL from this collective's discovery document. */
export async function localBrokerUrl(tenantId: string): Promise<string> {
  const [row] = await db
    .select({ brokerEndpoint: collectiveDids.brokerEndpoint })
    .from(collectiveDids)
    .where(eq(collectiveDids.tenantId, tenantId))
    .limit(1);
  return row?.brokerEndpoint ?? config.publicUrl;
}

/** Returns null when the collective lives on another instance. */
export async function localTenantForDid(did: string): Promise<string | null> {
  const [row] = await db
    .select({ tenantId: collectiveDids.tenantId })
    .from(collectiveDids)
    .where(eq(collectiveDids.did, did))
    .limit(1);
  return row?.tenantId ?? null;
}

const AUDIT_ACTION_FOR: Record<UnsignedLinkMessage["type"], "federation_requested" | "federation_accepted" | "federation_rejected" | "federation_revoked"> = {
  LINK_REQUEST: "federation_requested",
  LINK_ACCEPT: "federation_accepted",
  LINK_REJECT: "federation_rejected",
  LINK_REVOKE: "federation_revoked",
};

function auditDelivery(
  link: Pick<FederationLink, "id" | "localTenantId" | "peerDid">,
  entry: OutboxEntry,
  delivery: "delivered" | "failed",
): void {
  const meta = {
    delivery,
    messageType: entry.message.type,
    messageId: entry.message.messageId,
    peerDid: link.peerDid,
    attempts: entry.attempts,
    ...(entry.lastError ? { error: entry.lastError } : {}),
  };
  if (delivery === "failed") logger.warn({ linkId: link.id, ...meta }, "federation link message delivery abandoned");
  else logger.info({ linkId: link.id, ...meta }, "federation link message delivered");
  if (!entry.actorUserId) return;
  logAudit({
    tenantId: link.localTenantId,
    actorUserId: entry.actorUserId,
    action: AUDIT_ACTION_FOR[entry.message.type],
    targetType: "federation_link",
    targetId: link.id,
    metadata: meta,
  });
}

/**
 * Replaces any undelivered message, so the newest operator decision wins (ADR-0019 §2).
 * The broker loop retries with backoff.
 */
export async function queueLinkMessage(
  link: Pick<FederationLink, "id" | "peerDid" | "peerBrokerUrl">,
  message: UnsignedLinkMessage,
  actorUserId: string | null,
): Promise<void> {
  if (!link.peerBrokerUrl) throw new Error("Link has no peer broker URL");
  const entry = newOutboxEntry(message, link.peerDid, link.peerBrokerUrl, actorUserId);
  await db
    .update(federationLinks)
    .set({ outbox: entry as unknown as Record<string, unknown>, updatedAt: new Date() })
    .where(eq(federationLinks.id, link.id));
  setImmediate(() => {
    deliverLinkOutbox(link.id).catch((err) =>
      logger.warn({ linkId: link.id, err }, "federation link message delivery attempt failed"),
    );
  });
}

const deliveriesInFlight = new Set<string>();

/**
 * Updates the row only if it still holds the same message, because an operator can queue a newer one.
 * Returns null when nothing is due.
 */
export async function deliverLinkOutbox(linkId: string): Promise<DeliveryOutcome | null> {
  if (deliveriesInFlight.has(linkId)) return null;
  deliveriesInFlight.add(linkId);
  try {
    const [link] = await db.select().from(federationLinks).where(eq(federationLinks.id, linkId)).limit(1);
    const entry = parseOutboxEntry(link?.outbox);
    if (!link || !entry || !isDue(entry)) return null;

    let outcome: DeliveryOutcome;
    let error: string | null = null;
    if (!(await isAllowedBrokerUrl(entry.brokerUrl))) {
      outcome = "failed";
      error = `Peer broker URL ${entry.brokerUrl} is not allowed`;
    } else {
      const signed = await signMessage(
        { ...entry.message, timestamp: new Date().toISOString() },
        (payload) => signAsCollective(link.localTenantId, payload),
      );
      const result = await sendMessage(entry.brokerUrl, signed, entry.recipientDid);
      outcome = classifyDelivery(entry.message.type, result);
      error = result.ok ? null : (result.error ?? "send failed");
    }

    const next = afterAttempt(entry, outcome, error);
    const sameMessage = and(
      eq(federationLinks.id, linkId),
      sql`${federationLinks.outbox}->'message'->>'messageId' = ${entry.message.messageId}`,
    );
    const finalOutcome: DeliveryOutcome = next === null ? "delivered" : next.failedAt ? "failed" : "retry";

    if (finalOutcome === "failed" && entry.message.type === "LINK_REQUEST") {
      // The peer refused or never took the request, so the link cannot proceed
      await db
        .update(federationLinks)
        .set({ outbox: next as unknown as Record<string, unknown>, status: "rejected", updatedAt: new Date() })
        .where(and(sameMessage, eq(federationLinks.status, "pending")));
    } else {
      await db
        .update(federationLinks)
        .set({ outbox: next as unknown as Record<string, unknown> | null, updatedAt: new Date() })
        .where(sameMessage);
    }

    if (finalOutcome === "delivered") {
      auditDelivery(link, { ...entry, attempts: entry.attempts + 1 }, "delivered");
      // The accepting side opens the session
      if (entry.message.type === "LINK_ACCEPT" && link.status === "active") {
        handshakeBackoff.delete(link.id);
        initiateOutboundHandshake(link.id, link.localTenantId).catch((err) =>
          logger.warn({ linkId: link.id, err }, "handshake after LINK_ACCEPT delivery failed"),
        );
      }
    } else if (finalOutcome === "failed") {
      auditDelivery(link, next!, "failed");
    } else {
      logger.info(
        { linkId, messageType: entry.message.type, attempts: next!.attempts, retryAt: next!.nextAttemptAt, error },
        "federation link message will be retried",
      );
    }
    return finalOutcome;
  } finally {
    deliveriesInFlight.delete(linkId);
  }
}

async function deliverPendingLinkMessages(): Promise<void> {
  const rows = await db
    .select({ id: federationLinks.id, outbox: federationLinks.outbox })
    .from(federationLinks)
    .where(isNotNull(federationLinks.outbox))
    .limit(200);
  for (const row of rows) {
    const entry = parseOutboxEntry(row.outbox);
    if (!entry || !isDue(entry)) continue;
    try {
      await deliverLinkOutbox(row.id);
    } catch (err) {
      logger.warn({ linkId: row.id, err }, "federation link message delivery attempt failed");
    }
  }
}

// Only relays tagged FEDERATION_RELAY_TAG get imported prefixes approved.
// The coordinator keeps auto-approvers in memory, so each broker tick re-asserts them.

type RouteApprovers = Record<string, string[]>;

type AclPolicy = {
  tagOwners?: Record<string, string[]>;
  autoApprovers?: { routes?: RouteApprovers; [k: string]: unknown };
  [k: string]: unknown;
};

export interface CoordinatorAutoApprovers {
  routes: RouteApprovers;
  exit_node: string[];
}

interface AutoApproverApi {
  getAutoApprovers(): Promise<Partial<CoordinatorAutoApprovers> | null | undefined>;
  setAutoApprovers(approvers: CoordinatorAutoApprovers): Promise<unknown>;
}

/** The DB row is the source of truth. The monitor replays it after a coordinator restart. */
async function storeAndPushAutoApprovers(
  tenantId: string,
  client: AutoApproverApi,
  next: CoordinatorAutoApprovers,
): Promise<void> {
  await db
    .update(tenants)
    .set({ coordinatorAutoApprovers: next, updatedAt: new Date() })
    .where(eq(tenants.id, tenantId));
  await client.setAutoApprovers(next);
}

function withRelayApprovers(routes: RouteApprovers | undefined, cidrs: string[]): RouteApprovers {
  const next = { ...(routes ?? {}) };
  for (const cidr of cidrs) {
    const approvers = next[cidr] ?? [];
    if (!approvers.includes(FEDERATION_RELAY_TAG)) next[cidr] = [...approvers, FEDERATION_RELAY_TAG];
  }
  return next;
}

function withoutRelayApprovers(routes: RouteApprovers | undefined, cidrs: string[]): RouteApprovers {
  const next = { ...(routes ?? {}) };
  for (const cidr of cidrs) {
    const remaining = (next[cidr] ?? []).filter((a) => a !== FEDERATION_RELAY_TAG);
    if (remaining.length > 0) next[cidr] = remaining;
    else delete next[cidr];
  }
  return next;
}

export function addFederatedRoutesToPolicy(policy: AclPolicy, cidrs: string[]): AclPolicy {
  const tagOwners = { ...(policy.tagOwners ?? {}) };
  tagOwners[FEDERATION_RELAY_TAG] ??= [];
  const routes = withRelayApprovers(policy.autoApprovers?.routes, cidrs);
  return { ...policy, tagOwners, autoApprovers: { ...policy.autoApprovers, routes } };
}

/** Leaves other approvers unchanged. */
export function removeFederatedRoutesFromPolicy(policy: AclPolicy, cidrs: string[]): AclPolicy {
  const routes = withoutRelayApprovers(policy.autoApprovers?.routes, cidrs);
  return { ...policy, autoApprovers: { ...policy.autoApprovers, routes } };
}

export function normalizeAutoApprovers(
  raw: Partial<CoordinatorAutoApprovers> | null | undefined,
): CoordinatorAutoApprovers {
  return {
    routes: { ...(raw?.routes ?? {}) },
    exit_node: [...(raw?.exit_node ?? [])],
  };
}

/** Keeps exit-node and other entries. */
export function addFederatedRoutesToAutoApprovers(
  current: CoordinatorAutoApprovers,
  cidrs: string[],
): CoordinatorAutoApprovers {
  return { ...current, routes: withRelayApprovers(current.routes, cidrs) };
}

export function removeFederatedRoutesFromAutoApprovers(
  current: CoordinatorAutoApprovers,
  cidrs: string[],
): CoordinatorAutoApprovers {
  return { ...current, routes: withoutRelayApprovers(current.routes, cidrs) };
}

/** Makes the relay tag approve exactly `imported`. Other approvers and exit-node entries stay. */
export function reconcileFederatedAutoApprovers(
  current: CoordinatorAutoApprovers,
  imported: string[],
): CoordinatorAutoApprovers {
  const want = new Set(imported);
  const stale = Object.entries(current.routes)
    .filter(([cidr, approvers]) => approvers.includes(FEDERATION_RELAY_TAG) && !want.has(cidr))
    .map(([cidr]) => cidr);
  return addFederatedRoutesToAutoApprovers(removeFederatedRoutesFromAutoApprovers(current, stale), imported);
}

function sameAutoApprovers(a: CoordinatorAutoApprovers, b: CoordinatorAutoApprovers): boolean {
  const norm = (x: CoordinatorAutoApprovers) =>
    JSON.stringify({
      routes: Object.keys(x.routes).sort().map((k) => [k, [...x.routes[k]].sort()]),
      exit_node: [...x.exit_node].sort(),
    });
  return norm(a) === norm(b);
}

type ControlTenantRow = {
  port: number | null;
  apiKey: string | null;
  status: string;
  coordinatorTenantId: string | null;
};

async function loadControlTenant(tenantId: string): Promise<ControlTenantRow | null> {
  const [tenant] = await db
    .select({ port: tenants.port, apiKey: tenants.apiKey, status: tenants.status, coordinatorTenantId: tenants.coordinatorTenantId })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return tenant ?? null;
}

/** Returns false when the tenant's control plane is not running. */
async function updateRouteApprovals(
  tenantId: string,
  cidrs: string[],
  mode: "add" | "remove",
): Promise<boolean> {
  const tenant = await loadControlTenant(tenantId);
  if (!tenant || tenant.status !== "running") return false;

  if (useCoordinator) {
    if (!tenant.coordinatorTenantId) return false;
    const client = getCoordinatorClient(tenant) as unknown as AutoApproverApi;
    const current = normalizeAutoApprovers(await client.getAutoApprovers());
    const next =
      mode === "add"
        ? addFederatedRoutesToAutoApprovers(current, cidrs)
        : removeFederatedRoutesFromAutoApprovers(current, cidrs);
    if (!sameAutoApprovers(current, next)) await storeAndPushAutoApprovers(tenantId, client, next);
    return true;
  }

  if (!tenant.port || !tenant.apiKey) return false;
  const client = getControlClient({ port: tenant.port, apiKey: tenant.apiKey });
  const policy = (await client.getPolicy()) as AclPolicy;
  await client.setPolicy(
    mode === "add" ? addFederatedRoutesToPolicy(policy, cidrs) : removeFederatedRoutesFromPolicy(policy, cidrs),
  );
  return true;
}

export async function installFederatedRoutes(
  tenantId: string,
  importedCidrs: string[],
): Promise<void> {
  if (importedCidrs.length === 0) return;

  try {
    const applied = await updateRouteApprovals(tenantId, importedCidrs, "add");
    if (applied) {
      logger.info({ tenantId, cidrs: importedCidrs }, "installed federated route auto-approvals");
    } else {
      logger.warn({ tenantId }, "federated routes not installed: tenant control plane not running");
    }
  } catch (err) {
    logger.warn({ tenantId, err }, "failed to install federated routes");
  }
}

/** Keeps CIDRs that another session of the tenant still imports. */
export async function withdrawFederatedRoutes(
  tenantId: string,
  cidrsToRemove: string[],
): Promise<void> {
  if (cidrsToRemove.length === 0) return;

  try {
    const stillImported = new Set((await getRouteTable(tenantId)).imported);
    const cidrs = cidrsToRemove.filter((c) => !stillImported.has(c));
    if (cidrs.length === 0) return;

    const applied = await updateRouteApprovals(tenantId, cidrs, "remove");
    if (applied) {
      logger.info({ tenantId, cidrs }, "withdrew federated route auto-approvals");
    }
  } catch (err) {
    logger.warn({ tenantId, err }, "failed to withdraw federated routes");
  }
}

/**
 * A coordinator restart or another writer can lose federated auto-approvers.
 * This re-asserts that the relay tag approves exactly what live sessions import.
 */
async function reconcileCoordinatorAutoApprovers(): Promise<void> {
  if (!useCoordinator) return;

  const rows = await db
    .select({
      tenantId: brokerSessions.localTenantId,
      status: brokerSessions.status,
      importedRoutes: brokerSessions.importedRoutes,
    })
    .from(brokerSessions);
  const importedByTenant = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = importedByTenant.get(r.tenantId) ?? new Set<string>();
    if (r.status !== "disconnected") r.importedRoutes.forEach((c) => set.add(c));
    importedByTenant.set(r.tenantId, set);
  }

  for (const [tenantId, imported] of importedByTenant) {
    try {
      const tenant = await loadControlTenant(tenantId);
      if (!tenant || tenant.status !== "running" || !tenant.coordinatorTenantId) continue;
      const client = getCoordinatorClient(tenant) as unknown as AutoApproverApi;
      const current = normalizeAutoApprovers(await client.getAutoApprovers());
      const next = reconcileFederatedAutoApprovers(current, [...imported]);
      if (!sameAutoApprovers(current, next)) {
        await storeAndPushAutoApprovers(tenantId, client, next);
        logger.info({ tenantId, cidrs: [...imported] }, "re-asserted federated route auto-approvals on the coordinator");
      }
    } catch (err) {
      logger.warn({ tenantId, err }, "failed to reconcile coordinator auto-approvers");
    }
  }
}


/**
 * Approved subnet routes, minus federated imports, which belong to a peer.
 * An unreachable control plane gives no subnets.
 */
async function approvedSubnetRoutes(tenantId: string): Promise<string[]> {
  try {
    const [tenant] = await db
      .select({ port: tenants.port, apiKey: tenants.apiKey, status: tenants.status, coordinatorTenantId: tenants.coordinatorTenantId })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!tenant?.port || !tenant.apiKey || tenant.status !== "running") return [];
    const routes = await getControlClient({ ...tenant, port: tenant.port, apiKey: tenant.apiKey }).listRoutes();
    const imported = (await getRouteTable(tenantId)).imported;
    return routes
      .filter((r) => r.enabled && !isDefaultRoute(r.prefix))
      .map((r) => r.prefix)
      .filter((prefix) => {
        const parsed = parseCidr(prefix);
        return parsed !== null && !imported.some((i) => {
          const ip = parseCidr(i);
          return ip !== null && cidrsOverlap(ip, parsed);
        });
      });
  } catch (err) {
    logger.warn({ tenantId, err }, "could not list approved subnet routes for CIDR validation");
    return [];
  }
}

/**
 * Offered CIDRs must be inside the tenant range or an approved subnet route (ADR-0019 §6).
 * Default routes are refused.
 */
export async function validateLocalCidrsForTenant(
  tenantId: string,
  cidrs: string[],
): Promise<{ cidrs: string[]; errors: string[] }> {
  if (cidrs.length === 0) return { cidrs: [], errors: [] };
  const [tenant] = await db
    .select({ ipv4Prefix: tenants.ipv4Prefix, ipv6Prefix: tenants.ipv6Prefix })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) return { cidrs: [], errors: ["Unknown tenant"] };
  const direct = validateLocalOffer(cidrs, tenant.ipv4Prefix, tenant.ipv6Prefix);
  if (direct.errors.length === 0) return direct;
  return validateLocalOffer(cidrs, tenant.ipv4Prefix, tenant.ipv6Prefix, await approvedSubnetRoutes(tenantId));
}

/**
 * Refuses default routes and overlap with the tenant range or other active imports.
 * `excludeLinkId` is the link under negotiation.
 */
export async function validatePeerCidrsForTenant(
  tenantId: string,
  cidrs: string[],
  excludeLinkId?: string,
): Promise<{ cidrs: string[]; errors: string[] }> {
  if (cidrs.length === 0) return { cidrs: [], errors: [] };
  const [tenant] = await db
    .select({ ipv4Prefix: tenants.ipv4Prefix, ipv6Prefix: tenants.ipv6Prefix })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) return { cidrs: [], errors: ["Unknown tenant"] };
  const others = await db
    .select({ id: federationLinks.id, peerCidrs: federationLinks.peerCidrs })
    .from(federationLinks)
    .where(
      and(
        eq(federationLinks.localTenantId, tenantId),
        eq(federationLinks.status, "active"),
      ),
    );
  const otherPeerCidrs = others
    .filter((l) => l.id !== excludeLinkId)
    .flatMap((l) => l.peerCidrs);
  return validatePeerOffer(cidrs, tenant.ipv4Prefix, tenant.ipv6Prefix, otherPeerCidrs);
}


export async function getRouteTable(
  tenantId: string,
): Promise<{ exported: string[]; imported: string[] }> {
  const sessions = await db
    .select({
      exportedRoutes: brokerSessions.exportedRoutes,
      importedRoutes: brokerSessions.importedRoutes,
    })
    .from(brokerSessions)
    .where(
      and(
        eq(brokerSessions.localTenantId, tenantId),
        ne(brokerSessions.status, "disconnected"),
      ),
    );

  const exported = [...new Set(sessions.flatMap((s) => s.exportedRoutes))];
  const imported = [...new Set(sessions.flatMap((s) => s.importedRoutes))];

  return { exported, imported };
}

export async function getBrokerStatus(tenantId: string): Promise<{
  sessions: Array<{
    id: string;
    peerDid: string;
    peerName: string | null;
    status: string;
    exportedRoutes: string[];
    importedRoutes: string[];
    lastKeepalive: Date | null;
  }>;
  relayNodes: Array<{
    id: string;
    status: string;
    lastHealthCheck: Date | null;
  }>;
}> {
  const sessions = await db
    .select({
      id: brokerSessions.id,
      peerDid: brokerSessions.peerDid,
      peerName: federationLinks.peerName,
      status: brokerSessions.status,
      exportedRoutes: brokerSessions.exportedRoutes,
      importedRoutes: brokerSessions.importedRoutes,
      lastKeepalive: brokerSessions.lastKeepalive,
    })
    .from(brokerSessions)
    .leftJoin(federationLinks, eq(federationLinks.id, brokerSessions.federationLinkId))
    .where(eq(brokerSessions.localTenantId, tenantId))
    .orderBy(brokerSessions.createdAt)
    .limit(200);

  const relays =
    sessions.length === 0
      ? []
      : await db
          .select()
          .from(relayNodes)
          .where(inArray(relayNodes.brokerSessionId, sessions.map((s) => s.id)))
          .limit(200);

  return {
    sessions,
    relayNodes: relays.map((r) => ({
      id: r.id,
      status: r.status,
      lastHealthCheck: r.lastHealthCheck,
    })),
  };
}
