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
 * Every active link row represents one side of a federation — `localTenantId`
 * is the local collective, `peerDid` is the remote. The side whose link has
 * direction "incoming" (the acceptor) initiates the outbound handshake.
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
    await checkRelayHealth();
  } catch (err) {
    logger.error({ err }, "federation broker tick failed");
  } finally {
    tickRunning = false;
  }
}

// ── Link ↔ session reconciliation ────────────────────────────────────────

/**
 * One tenant's view of a federation link.
 *
 * In the per-side schema each link row IS one side, so this is a thin
 * projection with a default broker URL filled in when the link has none.
 */
export interface LinkSide {
  localTenantId: string;
  peerDid: string;
  /** CIDRs this side shares with the peer. */
  localCidrs: string[];
  /** CIDRs the peer agreed to share with this side. */
  peerCidrs: string[];
  /** Base URL of the peer's broker. */
  peerBrokerUrl: string;
}

/**
 * Extract the local side's view from a federation link. In the per-side
 * schema each link row already represents one side, so this just projects
 * the relevant fields and fills in a default broker URL.
 *
 * The `_localTenantId` parameter is accepted for call-site compatibility
 * but is not used — the link's own `localTenantId` is authoritative.
 */
export function linkSide(
  link: Pick<
    FederationLink,
    | "localTenantId"
    | "peerDid"
    | "localCidrs"
    | "peerCidrs"
    | "peerBrokerUrl"
  >,
  _localTenantId?: string,
  defaultEndpoint: string = config.publicUrl,
): LinkSide {
  return {
    localTenantId: link.localTenantId,
    peerDid: link.peerDid,
    localCidrs: link.localCidrs,
    peerCidrs: link.peerCidrs,
    peerBrokerUrl: link.peerBrokerUrl ?? defaultEndpoint,
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
  // process restarted mid-handshake, …). The accepting (incoming) side initiates.
  for (const link of activeLinks) {
    if (link.direction !== "incoming") continue;

    const [pending] = await db
      .select({ id: brokerSessions.id })
      .from(brokerSessions)
      .where(
        and(
          eq(brokerSessions.federationLinkId, link.id),
          eq(brokerSessions.localTenantId, link.localTenantId),
          eq(brokerSessions.status, "connecting"),
        ),
      )
      .limit(1);

    if (pending) {
      await initiateOutboundHandshake(link.id, link.localTenantId).catch((err) => {
        logger.warn({ linkId: link.id, err }, "federation handshake attempt failed");
      });
    }
  }
}

/** Create the session row for an active link if it is missing. */
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
      // Filled in from the peer's announcements when the handshake completes.
      importedRoutes: [],
    })
    .onConflictDoNothing()
    .returning();

  if (session) {
    logger.info(
      { linkId: link.id, sessionId: session.id, localTenantId: link.localTenantId },
      "created broker session for federation link",
    );
    // Provision relay for outgoing links (we requested the federation).
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
    const { getControlClient } = await import("./control-client.js");
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

    const { createRelayHalf } = await import("./relay.js");
    const { tenantPublicUrl } = await import("../config.js");

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
      await sendRevoke(session.remoteEndpoint, revoke, session.peerDid);
    } catch (err) {
      logger.warn({ sessionId: session.id, err }, "failed to notify peer of revocation");
    }
  }

  // Tear down relay containers and deregister from Headscale.
  const relays = await db
    .select()
    .from(relayNodes)
    .where(eq(relayNodes.brokerSessionId, session.id));

  for (const relay of relays) {
    try {
      if (relay.containerId) {
        const { destroyRelayHalf } = await import("./relay.js");
        await destroyRelayHalf(relay.containerId);
      }
      if (relay.headscaleNodeId) {
        const { getControlClient } = await import("./control-client.js");
        const [tenant] = await db
          .select({ port: tenants.port, apiKey: tenants.apiKey, status: tenants.status, coordinatorTenantId: tenants.coordinatorTenantId })
          .from(tenants)
          .where(eq(tenants.id, session.localTenantId))
          .limit(1);
        if (tenant?.port && tenant.status === "running") {
          const client = getControlClient(tenant);
          try {
            await client.deleteNode(relay.headscaleNodeId);
          } catch (deleteErr) {
            if (deleteErr instanceof Error && deleteErr.message.includes("not yet supported")) {
              logger.warn({ relayId: relay.id }, "node deletion not supported in coordinator mode, skipping");
            } else {
              throw deleteErr;
            }
          }
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

// ── Keepalive ────────────────────────────────────────────────────────────

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

      // A successful round-trip proves the peer still holds the session.
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
      const { isRelayHalfRunning } = await import("./relay.js");
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

/** The active federation link from a local tenant to a specific peer DID. */
export async function findActiveLink(
  localTenantId: string,
  peerDid: string,
): Promise<FederationLink | null> {
  const [link] = await db
    .select()
    .from(federationLinks)
    .where(
      and(
        eq(federationLinks.status, "active"),
        eq(federationLinks.localTenantId, localTenantId),
        eq(federationLinks.peerDid, peerDid),
      ),
    )
    .limit(1);

  return link ?? null;
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
  const { getControlClient } = await import("./control-client.js");
  const [tenant] = await db
    .select({ port: tenants.port, apiKey: tenants.apiKey, status: tenants.status, coordinatorTenantId: tenants.coordinatorTenantId })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  if (!tenant?.port || tenant.status !== "running") return false;

  const client = getControlClient(tenant);
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
