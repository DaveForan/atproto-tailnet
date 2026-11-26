/** Device admission: issued pre-auth keys and devices that wait. */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { tenants, users } from "./tenancy.js";

/** Issued pre-auth keys. The secret is never stored, only its prefix and the control-plane key id. */
export const authKeys = pgTable(
  "auth_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    /** Member the key was issued for. Devices it registers are theirs. */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /** Key id in the coordinator. */
    controlKeyId: text("control_key_id"),
    /** First 12 characters of the key, shown in the UI. */
    prefix: text("prefix").notNull(),
    /** "device" or "service_device". */
    kind: text("kind").notNull().default("device"),
    reusable: boolean("reusable").notNull().default(false),
    ephemeral: boolean("ephemeral").notNull().default(false),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    revokedAt: timestamp("revoked_at"),
  },
  (t) => [
    index("auth_keys_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("auth_keys_tenant_user_idx").on(t.tenantId, t.userId),
  ],
);

/**
 * Devices that wait for admission, as the monitor saw them (ADR-0039).
 * `firstSeenAt` starts the expiry; a row exists only while the device waits.
 */
export const waitingDevices = pgTable(
  "waiting_devices",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** The coordinator's node id. */
    nodeId: text("node_id").notNull(),
    /** Owner (our user id) when the wait began. Another owner starts a new wait. */
    ownerId: text("owner_id"),
    firstSeenAt: timestamp("first_seen_at").defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.nodeId] })],
);
