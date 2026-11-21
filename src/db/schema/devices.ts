/** Device admission: approvals, device locks and issued pre-auth keys. */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  pgEnum,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { memberships, tenants, users } from "./tenancy.js";

export const deviceApprovalStatusEnum = pgEnum("device_approval_status", [
  "pending",
  "approved",
  "rejected",
  "expired",
]);

export const deviceApprovals = pgTable(
  "device_approvals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    requesterId: uuid("requester_id")
      .notNull()
      .references(() => users.id),
    hsUsername: text("hs_username").notNull(),
    status: deviceApprovalStatusEnum("status").notNull().default("pending"),
    preAuthKey: text("pre_auth_key"),
    command: text("command"),
    reviewedById: uuid("reviewed_by_id").references(() => users.id),
    requestedAt: timestamp("requested_at").defaultNow().notNull(),
    reviewedAt: timestamp("reviewed_at"),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (t) => [index("device_approvals_tenant_idx").on(t.tenantId)],
);

export const deviceLocks = pgTable(
  "device_locks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    machineKey: text("machine_key").notNull(),
    nodeName: text("node_name"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("device_locks_membership_machine_idx").on(
      t.membershipId,
      t.machineKey,
    ),
  ],
);

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
    /** Key id on the control plane (Headscale numeric id or coordinator uuid). */
    controlKeyId: text("control_key_id"),
    /** First 12 characters of the key, shown in the UI. */
    prefix: text("prefix").notNull(),
    /** Headscale mode only. */
    hsUsername: text("hs_username"),
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
