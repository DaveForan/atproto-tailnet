/**
 * @module orchestrator/federation-broker
 *
 * Federation Control Plane (FCP) — manages broker sessions, relay nodes,
 * route propagation, and collective DID lifecycle for cross-tailnet
 * federation (ADR-0010).
 *
 * The broker runs as a background service alongside the monitor. It
 * periodically checks active federation links and manages the data-plane
 * infrastructure that connects them.
 */

import { eq, and, sql, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  federationLinks,
  brokerSessions,
  relayNodes,
  collectiveDids,
  tenants,
} from "../db/schema.js";
import { logger } from "../logger.js";
import * as crypto from "crypto";

const BROKER_TICK_MS = 30_000;
const KEEPALIVE_STALE_MS = 90_000;

let brokerInterval: ReturnType<typeof setInterval> | null = null;

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
  try {
    await reconcileActiveSessions();
    await checkSessionHealth();
  } catch (err) {
    logger.error({ err }, "federation broker tick failed");
  }
}

async function reconcileActiveSessions(): Promise<void> {
  const activeLinks = await db
    .select()
    .from(federationLinks)
    .where(eq(federationLinks.status, "active"));

  for (const link of activeLinks) {
    const [existing] = await db
      .select({ id: brokerSessions.id })
      .from(brokerSessions)
      .where(eq(brokerSessions.federationLinkId, link.id));

    if (!existing) {
      await createBrokerSession(link);
    }
  }

  const sessions = await db.select().from(brokerSessions);
  for (const session of sessions) {
    const [link] = await db
      .select({ status: federationLinks.status })
      .from(federationLinks)
      .where(eq(federationLinks.id, session.federationLinkId));

    if (!link || link.status !== "active") {
      await teardownBrokerSession(session.id);
    }
  }
}

interface FederationLink {
  id: string;
  requesterTenantId: string;
  targetTenantId: string;
  requesterCidrs: string[];
  targetCidrs: string[];
  requesterBrokerEndpoint: string | null;
  targetBrokerEndpoint: string | null;
  protocolVersion: number;
}

async function createBrokerSession(link: FederationLink): Promise<void> {
  logger.info(
    {
      linkId: link.id,
      requester: link.requesterTenantId,
      target: link.targetTenantId,
    },
    "creating broker session for federation link",
  );

  const [session] = await db
    .insert(brokerSessions)
    .values({
      federationLinkId: link.id,
      localTenantId: link.requesterTenantId,
      remoteTenantId: link.targetTenantId,
      status: "connecting",
      remoteEndpoint: link.targetBrokerEndpoint,
      protocolVersion: link.protocolVersion,
      exportedRoutes: link.requesterCidrs,
      importedRoutes: link.targetCidrs,
    })
    .returning();

  await provisionRelayNode(session.id, link);
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
  // register it in both Headscale instances, and populate
  // localNodeId, remoteNodeId, and wireguardPublicKey.
  //
  // For now this creates the DB record so the session is tracked.
  // The relay provisioning requires Headscale API integration
  // (creating pre-auth keys on both sides, starting a tailscale
  // process dual-homed across both instances).
}

async function teardownBrokerSession(sessionId: string): Promise<void> {
  logger.info({ sessionId }, "tearing down broker session");

  await db
    .update(relayNodes)
    .set({ status: "decommissioned", updatedAt: new Date() })
    .where(eq(relayNodes.brokerSessionId, sessionId));

  // TODO: Actually shut down the relay node process/container and
  // deregister from both Headscale instances.

  await db.delete(brokerSessions).where(eq(brokerSessions.id, sessionId));
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

export async function ensureCollectiveDid(
  tenantId: string,
  domain: string,
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

  const encrypted = encrypt(privateKeyPem);

  await db.insert(collectiveDids).values({
    tenantId,
    did,
    publicKeyJwk,
    encryptedPrivateKey: encrypted,
  });

  logger.info({ tenantId, did }, "created collective DID");

  return { did, publicKeyJwk };
}

export async function rotateCollectiveDid(
  tenantId: string,
  domain: string,
): Promise<{ did: string; publicKeyJwk: JsonWebKey }> {
  await db.delete(collectiveDids).where(eq(collectiveDids.tenantId, tenantId));
  return ensureCollectiveDid(tenantId, domain);
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
    remoteTenantId: string;
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
    .select()
    .from(brokerSessions)
    .where(eq(brokerSessions.localTenantId, tenantId));

  const allRelays = [];
  for (const session of sessions) {
    const relays = await db
      .select()
      .from(relayNodes)
      .where(eq(relayNodes.brokerSessionId, session.id));
    allRelays.push(...relays);
  }

  return {
    sessions: sessions.map((s) => ({
      id: s.id,
      remoteTenantId: s.remoteTenantId,
      status: s.status,
      exportedRoutes: s.exportedRoutes,
      importedRoutes: s.importedRoutes,
      lastKeepalive: s.lastKeepalive,
    })),
    relayNodes: allRelays.map((r) => ({
      id: r.id,
      status: r.status,
      lastHealthCheck: r.lastHealthCheck,
    })),
  };
}

function encrypt(plaintext: string): string {
  const key = process.env.FEDERATION_KEY_ENCRYPTION_KEY;
  if (!key) {
    return Buffer.from(plaintext).toString("base64");
  }
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    Buffer.from(key, "hex"),
    iv,
  );
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString("hex"),
    tag.toString("hex"),
    encrypted.toString("hex"),
  ].join(":");
}
