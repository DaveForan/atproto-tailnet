/**
 * @module schema
 *
 * Drizzle ORM schema defining all PostgreSQL tables, enums, and indexes.
 *
 * Tables: users, tenants, roles, memberships, oauth_states, oauth_sessions,
 * invitations, device_approvals, join_requests, device_locks, service_devices,
 * services, board_posts, agent_tokens, audit_logs.
 *
 * Enums are used for status columns (tenant_status, invitation_status, etc.)
 * and the audit_action enum tracks all auditable events in the system.
 *
 * Migrations are generated with `npx drizzle-kit generate` — never edit
 * migration SQL files by hand.
 */

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

export interface DerpRegionNode {
  name: string;
  hostname: string;
  stunPort?: number;
  derpPort?: number;
}

export interface DerpRegion {
  regionId: number;
  regionCode: string;
  regionName: string;
  nodes: DerpRegionNode[];
}

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
  "member_permissions_updated", // legacy: PG enums can't drop values; superseded by member_role_changed
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
  "join_requests_enabled",
  "join_requests_disabled",
  "join_request_created",
  "join_request_approved",
  "join_request_rejected",
  "board_enabled",
  "board_disabled",
  "board_settings_updated",
  "board_post_created",
  "board_post_removed",
  "service_device_requested",
  "service_device_approved",
  "service_device_rejected",
  "service_device_removed",
  "service_created",
  "service_approved",
  "service_rejected",
  "service_removed",
  "agent_token_created",
  "agent_token_revoked",
  "tenant_deleted",
  "tenant_started",
  "tenant_stopped",
  "tenant_hibernated",
  "acl_updated",
  "derp_updated",
  "ip_config_updated",
  "route_enabled",
  "route_disabled",
  "route_deleted",
  "plan_updated",
]);

export const deviceApprovalStatusEnum = pgEnum("device_approval_status", [
  "pending",
  "approved",
  "rejected",
  "expired",
]);

export const joinRequestStatusEnum = pgEnum("join_request_status", [
  "pending",
  "approved",
  "rejected",
]);

export const serviceDeviceStatusEnum = pgEnum("service_device_status", [
  "pending",
  "approved",
  "rejected",
]);

export const serviceStatusEnum = pgEnum("service_status", [
  "pending",
  "active",
  "disabled",
]);

export const boardPostStatusEnum = pgEnum("board_post_status", [
  "active",
  "removed",
]);

/** Agent API token lifecycle states. */
export const agentTokenStatusEnum = pgEnum("agent_token_status", [
  "active",
  "revoked",
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
  /** When true, non-members can request to join via the public join page. */
  allowJoinRequests: boolean("allow_join_requests").notNull().default(false),
  /** When true, the public message board is visible at /board/:slug. */
  boardEnabled: boolean("board_enabled").notNull().default(false),
  /** Maximum number of board posts allowed. */
  maxBoardPosts: integer("max_board_posts").notNull().default(20),
  /** Maximum number of posts shown on the public board page. */
  maxBoardPostsDisplayed: integer("max_board_posts_displayed").notNull().default(10),
  /** When true, services must be approved before going active. */
  requireServiceApproval: boolean("require_service_approval").notNull().default(true),
  /** When true, service devices require approval before getting an auth key. */
  requireServiceDeviceApproval: boolean("require_service_device_approval").notNull().default(true),
  /** When true, members with `create_agent_tokens` can generate API tokens. */
  allowAgentTokens: boolean("allow_agent_tokens").notNull().default(false),
  /** When true, non-originator members can create their own agent tokens (requires allowAgentTokens). */
  allowMemberAgentTokens: boolean("allow_member_agent_tokens").notNull().default(false),
  /** Days of inactivity before auto-stopping the instance. 0 = disabled. */
  hibernateAfterDays: integer("hibernate_after_days").notNull().default(0),
  /** Last time a member or agent accessed this tenant's API. Updated at most once per 5 minutes. */
  lastActivityAt: timestamp("last_activity_at").defaultNow().notNull(),
  /** Custom DERP relay regions for this tenant's Headscale instance. */
  customDerpRegions: jsonb("custom_derp_regions").$type<DerpRegion[]>().notNull().default([]),
  /** When true, Headscale runs an embedded DERP server (requires container restart). */
  embeddedDerpEnabled: boolean("embedded_derp_enabled").notNull().default(false),
  /** When false, Tailscale's public DERP relays are disabled — only custom regions are used. */
  usePublicDerp: boolean("use_public_derp").notNull().default(true),
  /** IPv4 CIDR prefix for the tailnet (default: 100.64.0.0/10). */
  ipv4Prefix: text("ipv4_prefix").notNull().default("100.64.0.0/10"),
  /** IPv6 CIDR prefix for the tailnet (default: fd7a:115c:a1e0::/48). */
  ipv6Prefix: text("ipv6_prefix").notNull().default("fd7a:115c:a1e0::/48"),
  /** IP allocation strategy: sequential or random. */
  ipAllocation: text("ip_allocation").notNull().default("sequential"),
  /** Billing plan name (free, starter, pro, enterprise). */
  planName: text("plan_name").notNull().default("free"),
  /** Maximum devices allowed (0 = unlimited). */
  maxDevices: integer("max_devices").notNull().default(0),
  /** Maximum members allowed (0 = unlimited). */
  maxMembers: integer("max_members").notNull().default(0),
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

export const invitations = pgTable(
  "invitations",
  {
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
  },
  (t) => [
    index("invitations_tenant_idx").on(t.tenantId),
    index("invitations_invitee_did_idx").on(t.inviteeDid),
  ],
);

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

export const joinRequests = pgTable(
  "join_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    requesterId: uuid("requester_id")
      .notNull()
      .references(() => users.id),
    message: text("message"),
    status: joinRequestStatusEnum("status").notNull().default("pending"),
    reviewedById: uuid("reviewed_by_id").references(() => users.id),
    requestedAt: timestamp("requested_at").defaultNow().notNull(),
    reviewedAt: timestamp("reviewed_at"),
  },
  (t) => [index("join_requests_tenant_idx").on(t.tenantId)],
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

export const serviceDevices = pgTable(
  "service_devices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    description: text("description"),
    status: serviceDeviceStatusEnum("status").notNull().default("pending"),
    hsUsername: text("hs_username"),
    preAuthKey: text("pre_auth_key"),
    command: text("command"),
    reviewedById: uuid("reviewed_by_id").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    reviewedAt: timestamp("reviewed_at"),
  },
  (t) => [index("service_devices_tenant_idx").on(t.tenantId)],
);

export const services = pgTable(
  "services",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    serviceDeviceId: uuid("service_device_id")
      .notNull()
      .references(() => serviceDevices.id),
    name: text("name").notNull(),
    description: text("description"),
    url: text("url").notNull(),
    status: serviceStatusEnum("status").notNull().default("pending"),
    reviewedById: uuid("reviewed_by_id").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [index("services_tenant_idx").on(t.tenantId)],
);

export const boardPosts = pgTable(
  "board_posts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id),
    title: text("title").notNull(),
    description: text("description"),
    status: boardPostStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [index("board_posts_tenant_idx").on(t.tenantId)],
);

/**
 * API tokens for AI agent access. The raw token is shown once at creation;
 * only the SHA-256 hash is stored. Tokens are scoped to a subset of the
 * creator's permissions and carry a mandatory expiry.
 */
export const agentTokens = pgTable(
  "agent_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    /** SHA-256 hex hash of the raw token. */
    tokenHash: text("token_hash").notNull().unique(),
    /** First 8 chars of the raw token for identification in the UI. */
    tokenPrefix: text("token_prefix").notNull(),
    /** JSONB array of Permission strings — token cannot exceed creator's role permissions. */
    permissions: jsonb("permissions").notNull().$type<string[]>().default([]),
    status: agentTokenStatusEnum("status").notNull().default("active"),
    expiresAt: timestamp("expires_at").notNull(),
    lastUsedAt: timestamp("last_used_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    revokedAt: timestamp("revoked_at"),
  },
  (t) => [
    index("agent_tokens_tenant_idx").on(t.tenantId),
    index("agent_tokens_hash_idx").on(t.tokenHash),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
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
  },
  (t) => [index("audit_logs_tenant_created_idx").on(t.tenantId, t.createdAt)],
);

export const usageSnapshots = pgTable(
  "usage_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    deviceCount: integer("device_count").notNull(),
    memberCount: integer("member_count").notNull(),
    routeCount: integer("route_count").notNull().default(0),
    onlineDevices: integer("online_devices").notNull().default(0),
    recordedAt: timestamp("recorded_at").defaultNow().notNull(),
  },
  (t) => [index("usage_snapshots_tenant_recorded_idx").on(t.tenantId, t.recordedAt)],
);
