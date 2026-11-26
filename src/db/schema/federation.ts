/** Federation between collectives: links, collective DIDs, broker sessions and relay nodes. */

import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  pgEnum,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { tenants, users } from "./tenancy.js";

export const federationStatusEnum = pgEnum("federation_status", [
  "pending",
  "active",
  "rejected",
  "revoked",
]);

export const linkDirectionEnum = pgEnum("link_direction", [
  "outgoing",
  "incoming",
]);

export const brokerSessionStatusEnum = pgEnum("broker_session_status", [
  "connecting",
  "established",
  "degraded",
  "disconnected",
]);

export const relayNodeStatusEnum = pgEnum("relay_node_status", [
  "provisioning",
  "active",
  "unhealthy",
  "decommissioned",
]);

export interface FederationRouteEntry {
  prefix: string;
  collectiveChain: string[];
  origin: string;
  timestamp: string;
}

export const federationLinks = pgTable(
  "federation_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** The local collective that owns this side of the link. */
    localTenantId: uuid("local_tenant_id")
      .notNull()
      .references(() => tenants.id),
    /** The remote collective's DID. It can be on another instance. */
    peerDid: text("peer_did").notNull(),
    /** The peer's broker URL from discovery. */
    peerBrokerUrl: text("peer_broker_url"),
    /** Display name from the peer's discovery document. */
    peerName: text("peer_name"),
    /** outgoing: we asked. incoming: they asked. */
    direction: linkDirectionEnum("direction").notNull(),
    status: federationStatusEnum("status").notNull().default("pending"),
    /** Optional note from the requester. */
    message: text("message"),
    /** CIDRs we share with the peer. */
    localCidrs: jsonb("local_cidrs").$type<string[]>().notNull().default([]),
    /** CIDRs the peer shares with us. */
    peerCidrs: jsonb("peer_cidrs").$type<string[]>().notNull().default([]),
    reviewedById: uuid("reviewed_by_id").references(() => users.id),
    /** DID-signed request payload (base64url JWS). */
    signedRequest: text("signed_request"),
    protocolVersion: integer("protocol_version").notNull().default(1),
    /** Set by a permanent revocation from either side. The broker never re-handshakes such a link. */
    revokedPermanently: boolean("revoked_permanently").notNull().default(false),
    /** Undelivered LINK_* message, retried and re-signed by the broker. Shape owned by `federation/outbox.ts`. */
    outbox: jsonb("outbox").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("federation_links_local_idx").on(t.localTenantId),
    index("federation_links_peer_did_idx").on(t.peerDid),
    uniqueIndex("federation_links_local_peer_active_uq")
      .on(t.localTenantId, t.peerDid)
      .where(sql`status IN ('pending', 'active')`),
  ],
);

export const collectiveDids = pgTable("collective_dids", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id)
    .unique(),
  did: text("did").notNull().unique(),
  publicKeyJwk: jsonb("public_key_jwk").notNull(),
  encryptedPrivateKey: text("encrypted_private_key").notNull(),
  brokerEndpoint: text("broker_endpoint"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  rotatedAt: timestamp("rotated_at").defaultNow().notNull(),
});

export const brokerSessions = pgTable(
  "broker_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    federationLinkId: uuid("federation_link_id")
      .notNull()
      .references(() => federationLinks.id),
    localTenantId: uuid("local_tenant_id")
      .notNull()
      .references(() => tenants.id),
    peerDid: text("peer_did").notNull(),
    status: brokerSessionStatusEnum("status").notNull().default("connecting"),
    /** CFP session id agreed in the handshake. It identifies the session to the peer. */
    cfpSessionId: text("cfp_session_id"),
    remoteEndpoint: text("remote_endpoint"),
    protocolVersion: integer("protocol_version").notNull().default(1),
    exportedRoutes: jsonb("exported_routes").$type<string[]>().notNull().default([]),
    importedRoutes: jsonb("imported_routes").$type<string[]>().notNull().default([]),
    lastKeepalive: timestamp("last_keepalive"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("broker_sessions_link_idx").on(t.federationLinkId),
    index("broker_sessions_local_idx").on(t.localTenantId),
    index("broker_sessions_cfp_idx").on(t.cfpSessionId),
    // Each side of a link has exactly one session
    uniqueIndex("broker_sessions_link_local_uq").on(t.federationLinkId, t.localTenantId),
  ],
);

export const relayNodes = pgTable(
  "relay_nodes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    brokerSessionId: uuid("broker_session_id")
      .notNull()
      .references(() => brokerSessions.id),
    containerId: text("container_id"),
    /** The relay half's node in the coordinator. */
    controlNodeId: text("control_node_id"),
    localNodeId: text("local_node_id"),
    remoteNodeId: text("remote_node_id"),
    wireguardPublicKey: text("wireguard_public_key"),
    advertisedRoutes: jsonb("advertised_routes").$type<string[]>().notNull().default([]),
    status: relayNodeStatusEnum("status").notNull().default("provisioning"),
    lastHealthCheck: timestamp("last_health_check"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [index("relay_nodes_session_idx").on(t.brokerSessionId)],
);
