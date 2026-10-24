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
} from "drizzle-orm/pg-core";

export const tenantStatusEnum = pgEnum("tenant_status", [
  "provisioning",
  "running",
  "stopped",
  "error",
  "deleted",
]);

export const memberRoleEnum = pgEnum("member_role", ["owner", "member"]);

export const invitationStatusEnum = pgEnum("invitation_status", [
  "pending",
  "accepted",
  "declined",
  "revoked",
]);

export const auditActionEnum = pgEnum("audit_action", [
  "invitation_created",
  "invitation_accepted",
  "invitation_declined",
  "invitation_revoked",
  "member_removed",
  "member_permissions_updated",
  "device_auth_key_created",
  "device_removed",
  "device_approval_requested",
  "device_approved",
  "device_rejected",
  "device_locked",
  "device_unlocked",
  "tenant_settings_updated",
  "lockdown_enabled",
  "lockdown_disabled",
  "role_created",
  "role_updated",
  "role_deleted",
  "member_role_changed",
  "default_role_changed",
]);

export const deviceApprovalStatusEnum = pgEnum("device_approval_status", [
  "pending",
  "approved",
  "rejected",
  "expired",
]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  did: text("did").notNull().unique(),
  handle: text("handle").notNull(),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text("name").notNull(),
    description: text("description"),
    /** JSON array of Permission strings from ALL_PERMISSIONS. */
    permissions: jsonb("permissions").notNull().$type<string[]>().default([]),
    /** System roles (originator, citizen) cannot be deleted. */
    isSystem: boolean("is_system").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("roles_tenant_name_idx").on(t.tenantId, t.name)],
);

export const tenants = pgTable("tenants", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  ownerUserId: uuid("owner_user_id")
    .notNull()
    .references(() => users.id),
  port: integer("port").notNull().unique(),
  apiKey: text("api_key").notNull(),
  containerId: text("container_id"),
  status: tenantStatusEnum("status").notNull().default("provisioning"),
  requireDeviceApproval: boolean("require_device_approval")
    .notNull()
    .default(false),
  lockdownMode: boolean("lockdown_mode").notNull().default(false),
  /** Role assigned to new members on invitation acceptance. */
  defaultRoleId: uuid("default_role_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    /** Legacy column — kept for migration compat. New code uses roleId. */
    role: memberRoleEnum("role").notNull().default("member"),
    /** FK to the composable role assigned to this member. */
    roleId: uuid("role_id").references(() => roles.id),
    /** True only for the tenant creator — can never be removed. */
    isOriginator: boolean("is_originator").notNull().default(false),
    /** Legacy columns — kept for migration compat. New code uses role permissions. */
    canInvite: boolean("can_invite").notNull().default(false),
    canKick: boolean("can_kick").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("memberships_user_tenant_idx").on(t.userId, t.tenantId)],
);

export const oauthStates = pgTable("oauth_states", {
  key: text("key").primaryKey(),
  state: text("state").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const oauthSessions = pgTable("oauth_sessions", {
  key: text("key").primaryKey(),
  session: text("session").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const invitations = pgTable("invitations", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  inviterUserId: uuid("inviter_user_id")
    .notNull()
    .references(() => users.id),
  inviteeDid: text("invitee_did").notNull(),
  inviteeHandle: text("invitee_handle").notNull(),
  status: invitationStatusEnum("status").notNull().default("pending"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const deviceApprovals = pgTable("device_approvals", {
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
});

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

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  actorUserId: uuid("actor_user_id")
    .notNull()
    .references(() => users.id),
  action: auditActionEnum("action").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
