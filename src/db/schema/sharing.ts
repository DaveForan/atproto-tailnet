/** Service posts, connections, friendships and device shares (ADR-0036). */

import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { tenants, users } from "./tenancy.js";

/** One protocol and port range a rule opens. */
export interface AccessPortSpec {
  proto: "any" | "tcp" | "udp" | "icmp";
  first: number;
  last: number;
}

/**
 * A service on a board: one device and one port.
 * Public posts are visible to others only when approved. Private posts serve the author's own devices.
 */
export const servicePosts = pgTable(
  "service_posts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    board: text("board").notNull().$type<"public" | "private">(),
    title: text("title").notNull(),
    description: text("description"),
    /** DNS label of the service. Required on the private board. */
    name: text("name"),
    /** Control-plane node id of the service device. */
    nodeId: text("node_id").notNull(),
    proto: text("proto").notNull().$type<"tcp" | "udp">().default("tcp"),
    port: integer("port").notNull(),
    /** Served by the gateway as `https://<name>.<BASE_DOMAIN>` (ADR-0030). */
    web: boolean("web").notNull().default(false),
    status: text("status").notNull().$type<"pending" | "approved" | "rejected" | "removed">().default("pending"),
    rejectReason: text("reject_reason"),
    reviewedById: uuid("reviewed_by_id").references(() => users.id),
    reviewedAt: timestamp("reviewed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("service_posts_tenant_idx").on(t.tenantId, t.board, t.status),
    index("service_posts_author_idx").on(t.authorId),
    // A private name is unique per author; a public name per tailnet
    uniqueIndex("service_posts_private_name_idx")
      .on(t.tenantId, t.authorId, t.name)
      .where(sql`${t.board} = 'private' AND ${t.status} <> 'removed'`),
    uniqueIndex("service_posts_public_name_idx")
      .on(t.tenantId, t.name)
      .where(sql`${t.board} = 'public' AND ${t.status} <> 'removed' AND ${t.name} IS NOT NULL`),
  ],
);

/** A viewer's device connected to a public service post. */
export const serviceConnections = pgTable(
  "service_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    postId: uuid("post_id")
      .notNull()
      .references(() => servicePosts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    nodeId: text("node_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("service_connections_post_node_idx").on(t.postId, t.nodeId),
    index("service_connections_user_idx").on(t.userId),
  ],
);

/** Two members of a tailnet who agreed to be friends, or a pending request. */
export const friendships = pgTable(
  "friendships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    requesterId: uuid("requester_id")
      .notNull()
      .references(() => users.id),
    addresseeId: uuid("addressee_id")
      .notNull()
      .references(() => users.id),
    status: text("status").notNull().$type<"pending" | "accepted">().default("pending"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    respondedAt: timestamp("responded_at"),
  },
  (t) => [
    // One row per unordered pair per tailnet
    uniqueIndex("friendships_pair_idx").on(
      t.tenantId,
      sql`LEAST(${t.requesterId}, ${t.addresseeId})`,
      sql`GREATEST(${t.requesterId}, ${t.addresseeId})`,
    ),
    index("friendships_addressee_idx").on(t.addresseeId, t.status),
  ],
);

/** A member who refuses friend requests from another member. */
export const memberBlocks = pgTable(
  "member_blocks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    blockerId: uuid("blocker_id")
      .notNull()
      .references(() => users.id),
    blockedId: uuid("blocked_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("member_blocks_pair_idx").on(t.tenantId, t.blockerId, t.blockedId)],
);

/** Access of a friend's devices to one device. Active only after the side that did not start it accepts. */
export const deviceShares = pgTable(
  "device_shares",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    guestId: uuid("guest_id")
      .notNull()
      .references(() => users.id),
    ownerNodeId: text("owner_node_id").notNull(),
    ports: jsonb("ports").notNull().$type<AccessPortSpec[]>(),
    /** The guest's devices that may connect. Empty means all of them. */
    guestNodeIds: jsonb("guest_node_ids").notNull().$type<string[]>().default([]),
    /** "requested" by the guest or "offered" by the owner, then "active", then "ended". */
    status: text("status").notNull().$type<"requested" | "offered" | "active" | "ended">(),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    acceptedAt: timestamp("accepted_at"),
    endedAt: timestamp("ended_at"),
  },
  (t) => [
    index("device_shares_tenant_idx").on(t.tenantId, t.status),
    index("device_shares_owner_idx").on(t.ownerId),
    index("device_shares_guest_idx").on(t.guestId),
  ],
);
