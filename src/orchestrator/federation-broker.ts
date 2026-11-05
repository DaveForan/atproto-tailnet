/**
 * @module orchestrator/federation-broker
 *
 * Federation Control Plane (FCP) — manages broker sessions, relay nodes,
 * route propagation, and collective DID lifecycle for cross-tailnet
 * federation (ADR-0010, ADR-0016).
 *
 * The broker runs as a background service alongside the monitor. Each tick it
 * reconciles `federation_links` with `broker_sessions`, drives the CFP
 * handshake for sessions that are not yet established, exchanges keepalives,
 * and tears down sessions whose link is no longer active.
 *
 * Every active link has two sessions — one per side, each holding that
 * tenant's view (`localTenantId`) of its peer. The side that accepted the
 * link (the target) initiates the handshake.
 */

import * as crypto from "node:crypto";
import * as jose from "jose";
import { eq, and, ne, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  federationLinks,
  brokerSessions,
  relayNodes,
  collectiveDids,
  tenants,
} from "../db/schema.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { sendMessage, sendKeepalive, sendRevoke } from "../federation/transport.js";
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
import { encryptPrivateKey, loadPrivateKey, signDetached } from "../identity/keys.js";
import type {
  Capability,
  ChallengeMessage,
  EstablishedMessage,
} from "../federation/protocol.js";

const BROKER_TICK_MS = 30_000;
const KEEPALIVE_STALE_MS = 90_000;

/** Capabilities this broker implements. */
export const LOCAL_CAPABILITIES: Capability[] = ["route-exchange"];

/**
 * Tag a relay node must carry for Headscale to auto-approve the federated
 * routes it advertises. Only tagged relays may attract traffic for a peer's
 * CIDRs — an ordinary member device advertising them is not approved.
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
  if (tickRunning) return;
  tickRunning = true;
  try {
    await reconcileActiveSessions();
    await sendKeepalives();
    await checkSessionHealth();
  } catch (err) {
    logger.error({ err }, "federation broker tick failed");
  } finally {
    tickRunning = false;
  }
}

// ── Link ↔ session reconciliation ────────────────────────────────────────

/** One tenant's view of a federation link. */
export interface LinkSide {
  localTenantId: string;
  remoteTenantId: string;
  /** CIDRs this side shares with the peer. */
  localCidrs: string[];
  /** CIDRs the peer agreed to share with this side. */
  remoteCidrs: string[];
  /** Base URL of the peer's broker. */
  remoteEndpoint: string;
}

export function linkSide(
  link: Pick<
    FederationLink,
    | "requesterTenantId"
    | "targetTenantId"
    | "requesterCidrs"
    | "targetCidrs"
    | "requesterBrokerEndpoint"
    | "targetBrokerEndpoint"
  >,
  localTenantId: string,
  defaultEndpoint: string = config.publicUrl,
): LinkSide {
  const isRequester = link.requesterTenantId === localTenantId;
  return {
    localTenantId,
    remoteTenantId: isRequester ? link.targetTenantId : link.requesterTenantId,
    localCidrs: isRequester ? link.requesterCidrs : link.targetCidrs,
    remoteCidrs: isRequester ? link.targetCidrs : link.requesterCidrs,
    // Both collectives of a link live on this instance unless the link
    // recorded another broker, so the peer's broker defaults to ourselves.
    remoteEndpoint:
      (isRequester ? link.targetBrokerEndpoint : link.requesterBrokerEndpoint) ??
      defaultEndpoint,
  };
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

  // Retry handshakes that have not completed (peer was unreachable, the
  // process restarted mid-handshake, …). The accepting side initiates.
  for (const link of activeLinks) {
    const [pending] = await db
      .select({ id: brokerSessions.id })
      .from(brokerSessions)
      .where(
        and(
          eq(brokerSessions.federationLinkId, link.id),
          eq(brokerSessions.localTenantId, link.targetTenantId),
          eq(brokerSessions.status, "connecting"),
        ),
      )
      .limit(1);

    if (pending) {
      await initiateOutboundHandshake(link.id, link.targetTenantId).catch((err) => {
        logger.warn({ linkId: link.id, err }, "federation handshake attempt failed");
      });
    }
  }
}

/** Create the per-side session rows of an active link if they are missing. */
async function ensureSessionsForLink(link: FederationLink): Promise<void> {
  for (const localTenantId of [link.requesterTenantId, link.targetTenantId]) {
    const side = linkSide(link, localTenantId);
    const [session] = await db
      .insert(brokerSessions)
      .values({
        federationLinkId: link.id,
        localTenantId: side.localTenantId,
        remoteTenantId: side.remoteTenantId,
        status: "connecting",
        remoteEndpoint: side.remoteEndpoint,
        protocolVersion: link.protocolVersion,
        exportedRoutes: side.localCidrs,
        // Filled in from the peer's announcements when the handshake completes.
        importedRoutes: [],
      })
      .onConflictDoNothing()
      .returning();

    if (session) {
      logger.info(
        { linkId: link.id, sessionId: session.id, localTenantId },
        "created broker session for federation link",
      );
      if (localTenantId === link.requesterTenantId) {
        await provisionRelayNode(session.id, link);
      }
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

  await db.insert(relayNodes).values({
    brokerSessionId: sessionId,
    status: "provisioning",
  });

  // TODO: Actually provision a WireGuard relay container/process,
  // register it in both Headscale instances (tagged FEDERATION_RELAY_TAG),
  // and populate localNodeId, remoteNodeId, and wireguardPublicKey.
  //
  // For now this creates the DB record so the session is tracked.
  // The relay provisioning requires Headscale API integration
  // (creating pre-auth keys on both sides, starting a tailscale
  // process dual-homed across both instances).
}

async function teardownBrokerSession(stale: BrokerSession): Promise<void> {
  // Re-read: the peer's own teardown may have revoked this session moments ago.
  const [session] = await db
    .select()
    .from(brokerSessions)
    .where(eq(brokerSessions.id, stale.id))
    .limit(1);
  if (!session) return;

  logger.info({ sessionId: session.id }, "tearing down broker session");

  if (session.cfpSessionId && session.remoteEndpoint && session.status !== "disconnected") {
    try {
      const remoteDid = await getCollectiveDid(session.remoteTenantId);
      if (remoteDid) {
        const revoke = await signMessage(
          {
            type: "REVOKE" as const,
            sessionId: session.cfpSessionId,
            reason: "link deactivated",
            permanent: false,
            timestamp: new Date().toISOString(),
          },
          (payload) => signAsCollective(session.localTenantId, payload),
        );
        await sendRevoke(session.remoteEndpoint, revoke, remoteDid);
      }
    } catch (err) {
      logger.warn({ sessionId: session.id, err }, "failed to notify peer of revocation");
    }
  }

  // relay_nodes rows reference the session, so they go first.
  // TODO: shut down the relay node process/container and deregister it from
  // both Headscale instances once relay provisioning exists.
  await db.delete(relayNodes).where(eq(relayNodes.brokerSessionId, session.id));
  await db.delete(brokerSessions).where(eq(brokerSessions.id, session.id));

  await withdrawFederatedRoutes(session.localTenantId, session.importedRoutes);
}

// ── Keepalive ────────────────────────────────────────────────────────────

async function sendKeepalives(): Promise<void> {
  const sessions = await db
    .select()
    .from(brokerSessions)
    .where(inArray(brokerSessions.status, ["established", "degraded"]));

  for (const session of sessions) {
    if (!session.remoteEndpoint || !session.cfpSessionId) continue;

    try {
      const remoteDid = await getCollectiveDid(session.remoteTenantId);
      if (!remoteDid) continue;

      const keepalive = await signMessage(
        {
          type: "KEEPALIVE" as const,
          sessionId: session.cfpSessionId,
          sequenceNumber: Date.now(),
          timestamp: new Date().toISOString(),
        },
        (payload) => signAsCollective(session.localTenantId, payload),
      );

      // A successful round-trip proves the peer still holds the session.
      if (await sendKeepalive(session.remoteEndpoint, keepalive, remoteDid)) {
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

// ── Collective DID lifecycle and signing ─────────────────────────────────

/**
 * Host component of this instance's collective DIDs. did:web percent-encodes
 * the port separator, so `localhost:3000` becomes `localhost%3A3000`.
 */
export function collectiveDidHost(): string {
  return encodeURIComponent(new URL(config.publicUrl).host);
}

export async function getCollectiveDid(tenantId: string): Promise<string | null> {
  const [row] = await db
    .select({ did: collectiveDids.did })
    .from(collectiveDids)
    .where(eq(collectiveDids.tenantId, tenantId))
    .limit(1);
  return row?.did ?? null;
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

/** RFC 7638 thumbprint of a collective's public key, for display. */
export function publicKeyFingerprint(publicKeyJwk: JsonWebKey): Promise<string> {
  return jose.calculateJwkThumbprint(publicKeyJwk as jose.JWK, "sha256");
}

/** The collective's DID and Ed25519 key pair, or null if it has no DID yet. */
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

/** Detached-JWS signature over `payload` by the tenant's collective key. */
export async function signAsCollective(
  tenantId: string,
  payload: string,
): Promise<string> {
  const keys = await loadCollectiveKeyPair(tenantId);
  if (!keys) throw new Error("No collective DID configured");
  return signDetached(keys.privateKey, payload);
}

// ── Outbound handshake ───────────────────────────────────────────────────

/** The active federation link between two local tenants, if any. */
export async function findActiveLink(
  tenantA: string,
  tenantB: string,
): Promise<FederationLink | null> {
  const links = await db
    .select()
    .from(federationLinks)
    .where(
      and(
        eq(federationLinks.status, "active"),
        inArray(federationLinks.requesterTenantId, [tenantA, tenantB]),
        inArray(federationLinks.targetTenantId, [tenantA, tenantB]),
      ),
    )
    .limit(5);

  return (
    links.find(
      (l) =>
        l.requesterTenantId !== l.targetTenantId &&
        [l.requesterTenantId, l.targetTenantId].includes(tenantA) &&
        [l.requesterTenantId, l.targetTenantId].includes(tenantB),
    ) ?? null
  );
}

/**
 * Record a completed handshake on `localTenantId`'s session for the link and
 * install the routes it imported. Used by both initiator and responder.
 */
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
 * Run the initiator side of the CFP handshake for a link:
 * HELLO → (CHALLENGE) → COMMIT → (ESTABLISHED). The peer's replies come back
 * as the HTTP responses and are verified against the peer's DID before use.
 * Returns true when the session is established.
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
    if (![link.requesterTenantId, link.targetTenantId].includes(localTenantId)) {
      logger.warn({ linkId, localTenantId }, "cannot initiate handshake: not a party to the link");
      return false;
    }

    await ensureSessionsForLink(link);
    const side = linkSide(link, localTenantId);

    // Both parties are tenants of this instance; make sure each has a DID.
    const { did: localDid } = await ensureCollectiveDid(localTenantId);
    const { did: remoteDid } = await ensureCollectiveDid(side.remoteTenantId);

    const sign = (payload: string) => signAsCollective(localTenantId, payload);
    const resolver = getResolver();
    const callbacks = makeHandshakeCallbacks({
      sign,
      resolver,
      evaluatePolicy: async () => true,
      routes: await buildAnnouncements(localDid, side.localCidrs, sign),
    });

    const hello = await initiateHello(
      createHandshake(localDid),
      remoteDid,
      "peer",
      side.localCidrs,
      LOCAL_CAPABILITIES,
      callbacks,
    );

    logger.info({ linkId, remoteDid, endpoint: side.remoteEndpoint }, "sending HELLO");
    const helloResult = await sendMessage(side.remoteEndpoint, hello.message, remoteDid);
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

    const commitResult = await sendMessage(side.remoteEndpoint, commit.message, remoteDid);
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
      filterImportedPrefixes(established.initialRoutes, side.remoteCidrs, remoteDid),
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

// ── Route installation (Headscale ACL) ───────────────────────────────────

type AclPolicy = {
  tagOwners?: Record<string, string[]>;
  autoApprovers?: { routes?: Record<string, string[]>; [k: string]: unknown };
  [k: string]: unknown;
};

/** Add federated CIDRs to a policy's route auto-approvers for the relay tag. */
export function addFederatedRoutesToPolicy(policy: AclPolicy, cidrs: string[]): AclPolicy {
  const tagOwners = { ...(policy.tagOwners ?? {}) };
  tagOwners[FEDERATION_RELAY_TAG] ??= [];

  const routes = { ...(policy.autoApprovers?.routes ?? {}) };
  for (const cidr of cidrs) {
    const approvers = routes[cidr] ?? [];
    if (!approvers.includes(FEDERATION_RELAY_TAG)) {
      routes[cidr] = [...approvers, FEDERATION_RELAY_TAG];
    }
  }

  return { ...policy, tagOwners, autoApprovers: { ...policy.autoApprovers, routes } };
}

/** Inverse of {@link addFederatedRoutesToPolicy}; other approvers are left alone. */
export function removeFederatedRoutesFromPolicy(policy: AclPolicy, cidrs: string[]): AclPolicy {
  const routes = { ...(policy.autoApprovers?.routes ?? {}) };
  for (const cidr of cidrs) {
    const remaining = (routes[cidr] ?? []).filter((a) => a !== FEDERATION_RELAY_TAG);
    if (remaining.length > 0) routes[cidr] = remaining;
    else delete routes[cidr];
  }
  return { ...policy, autoApprovers: { ...policy.autoApprovers, routes } };
}

async function updateTenantPolicy(
  tenantId: string,
  update: (policy: AclPolicy) => AclPolicy,
): Promise<boolean> {
  const { HeadscaleApiClient } = await import("./headscale-api.js");
  const [tenant] = await db
    .select({ port: tenants.port, apiKey: tenants.apiKey, status: tenants.status })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  if (!tenant?.port || tenant.status !== "running") return false;

  const client = new HeadscaleApiClient(tenant.port, tenant.apiKey);
  const policy = (await client.getPolicy()) as AclPolicy;
  await client.setPolicy(update(policy));
  return true;
}

export async function installFederatedRoutes(
  tenantId: string,
  importedCidrs: string[],
): Promise<void> {
  if (importedCidrs.length === 0) return;

  try {
    const applied = await updateTenantPolicy(tenantId, (policy) =>
      addFederatedRoutesToPolicy(policy, importedCidrs),
    );
    if (applied) {
      logger.info({ tenantId, cidrs: importedCidrs }, "installed federated routes in Headscale ACL");
    } else {
      logger.warn({ tenantId }, "federated routes not installed: tenant instance not running");
    }
  } catch (err) {
    logger.warn({ tenantId, err }, "failed to install federated routes");
  }
}

/**
 * Remove federated CIDRs from the tenant's ACL, keeping any that another of
 * its sessions still imports.
 */
export async function withdrawFederatedRoutes(
  tenantId: string,
  cidrsToRemove: string[],
): Promise<void> {
  if (cidrsToRemove.length === 0) return;

  try {
    const stillImported = new Set((await getRouteTable(tenantId)).imported);
    const cidrs = cidrsToRemove.filter((c) => !stillImported.has(c));
    if (cidrs.length === 0) return;

    const applied = await updateTenantPolicy(tenantId, (policy) =>
      removeFederatedRoutesFromPolicy(policy, cidrs),
    );
    if (applied) {
      logger.info({ tenantId, cidrs }, "withdrew federated routes from Headscale ACL");
    }
  } catch (err) {
    logger.warn({ tenantId, err }, "failed to withdraw federated routes");
  }
}

// ── Read models for the API / dashboard ──────────────────────────────────

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
    remoteTenantId: string;
    remoteSlug: string | null;
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
      remoteTenantId: brokerSessions.remoteTenantId,
      remoteSlug: tenants.slug,
      status: brokerSessions.status,
      exportedRoutes: brokerSessions.exportedRoutes,
      importedRoutes: brokerSessions.importedRoutes,
      lastKeepalive: brokerSessions.lastKeepalive,
    })
    .from(brokerSessions)
    .leftJoin(tenants, eq(tenants.id, brokerSessions.remoteTenantId))
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
