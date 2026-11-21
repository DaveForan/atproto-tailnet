/** Users, tenants, roles, memberships and the ways people join a tenant. */

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

/** Route auto-approvers in the coordinator's wire shape. */
export interface AutoApprovers {
  routes: Record<string, string[]>;
  exit_node: string[];
}

export const tenantStatusEnum = pgEnum("tenant_status", [
  "provisioning",
  "running",
  "stopped",
  "error",
  "deleted",
]);

export const invitationStatusEnum = pgEnum("invitation_status", [
  "pending",
  "accepted",
  "declined",
  "revoked",
]);

export const joinRequestStatusEnum = pgEnum("join_request_status", [
  "pending",
  "approved",
  "rejected",
]);

export const federationPostureEnum = pgEnum("federation_posture", [
  "closed",
  "selective",
  "open",
]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  did: text("did").notNull().unique(),
  handle: text("handle").notNull(),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  /** Set by an instance operator: the user cannot sign in or use any credential. */
  disabledAt: timestamp("disabled_at"),
  /** Most trusted devices the user allows themselves (ADR-0035). */
  maxTrustedDevices: integer("max_trusted_devices").notNull().default(3),
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
    /** Permission strings from ALL_PERMISSIONS. */
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
  /** Operator suspension, separate from the runtime `status`. Members get 403 `tenant_suspended`. */
  suspended: boolean("suspended").notNull().default(false),
  /** The ancestor whose suspension cascaded here. Unsuspending that ancestor restores this tenant. */
  suspendedByParentId: uuid("suspended_by_parent_id"),
  requireDeviceApproval: boolean("require_device_approval")
    .notNull()
    .default(false),
  lockdownMode: boolean("lockdown_mode").notNull().default(false),
  /** When true, non-members can request to join via the public join page. */
  allowJoinRequests: boolean("allow_join_requests").notNull().default(false),
  boardEnabled: boolean("board_enabled").notNull().default(false),
  /** Device access mode (ADR-0036): "open" or "member" (own devices plus approved posts and shares). */
  accessMode: text("access_mode").notNull().default("open"),
  /** Controller board: the originator's public text (Markdown subset). */
  controllerBoardText: text("controller_board_text"),
  maxBoardPosts: integer("max_board_posts").notNull().default(20),
  maxBoardPostsDisplayed: integer("max_board_posts_displayed").notNull().default(10),
  requireServiceApproval: boolean("require_service_approval").notNull().default(true),
  requireServiceDeviceApproval: boolean("require_service_device_approval").notNull().default(true),
  /** When true, members with `create_agent_tokens` can generate API tokens. */
  allowAgentTokens: boolean("allow_agent_tokens").notNull().default(false),
  /** When true, non-originator members can create their own agent tokens (needs allowAgentTokens). */
  allowMemberAgentTokens: boolean("allow_member_agent_tokens").notNull().default(false),
  /** Days of inactivity before the instance stops. 0 disables it. */
  hibernateAfterDays: integer("hibernate_after_days").notNull().default(0),
  /** Last API access by a member or agent. Updated at most once per 5 minutes. */
  lastActivityAt: timestamp("last_activity_at").defaultNow().notNull(),
  customDerpRegions: jsonb("custom_derp_regions").$type<DerpRegion[]>().notNull().default([]),
  /** Headscale embedded DERP server. A change needs a container restart. */
  embeddedDerpEnabled: boolean("embedded_derp_enabled").notNull().default(false),
  /** When false, only custom DERP regions are used. */
  usePublicDerp: boolean("use_public_derp").notNull().default(true),
  /** Coordinator mode: last accepted ACL policy, replayed after a coordinator restart. */
  coordinatorAclPolicy: jsonb("coordinator_acl_policy"),
  ipv4Prefix: text("ipv4_prefix").notNull().default("100.64.0.0/10"),
  ipv6Prefix: text("ipv6_prefix").notNull().default("fd7a:115c:a1e0::/48"),
  /** "sequential" or "random". */
  ipAllocation: text("ip_allocation").notNull().default("sequential"),
  /** Unused. Caps are maxDevices and maxMembers. */
  planName: text("plan_name").notNull().default("free"),
  /** 0 means unlimited. */
  maxDevices: integer("max_devices").notNull().default(0),
  /** 0 means unlimited. */
  maxMembers: integer("max_members").notNull().default(0),
  /** Parent collective. NULL for a root collective. */
  parentId: uuid("parent_id").references((): any => tenants.id, {
    onDelete: "restrict",
  }),
  /** Materialized path of slugs for tree queries ("root.child.grandchild"). */
  path: text("path"),
  /** Depth in the collective tree. Root is 0. */
  depth: integer("depth").notNull().default(0),
  /** 0 means unlimited. */
  maxSubCollectives: integer("max_sub_collectives").notNull().default(10),
  /** Floor policies that sub-collectives cannot weaken. */
  floorPolicies: jsonb("floor_policies").$type<Record<string, unknown>>(),
  /** Outbound cross-collective traversal policy (ADR-0011). */
  egressPolicy: jsonb("egress_policy").$type<{ rules: unknown[]; default: string }>(),
  /** Inbound cross-collective traversal policy (ADR-0011). */
  ingressPolicy: jsonb("ingress_policy").$type<{ rules: unknown[]; default: string }>(),
  /** closed (no inbound) or open; "selective" stays in the enum for old rows but is not implemented. */
  federationPosture: federationPostureEnum("federation_posture").notNull().default("closed"),
  /** Federation scopes this collective takes part in (ADR-0015). */
  federationScopes: jsonb("federation_scopes").$type<string[]>().default(["regional"]),
  /** UN M49 region code for regional federation. */
  federationRegion: text("federation_region"),
  /** [lat, lon] for local discovery. */
  federationCoordinates: jsonb("federation_coordinates").$type<[number, number]>(),
  federationScopePolicies: jsonb("federation_scope_policies").$type<Record<string, { autoAccept: boolean; verification: string }>>(),
  /** Tenant UUID in the Rust coordinator (ADR-0023). NULL in Headscale mode. */
  coordinatorTenantId: text("coordinator_tenant_id"),
  /** Coordinator mode: last pushed route auto-approvers, replayed after a coordinator restart. */
  coordinatorAutoApprovers: jsonb("coordinator_auto_approvers").$type<AutoApprovers>(),
  /** Optional webhook fired on every notification. */
  notificationWebhookUrl: text("notification_webhook_url"),
  /** HMAC-SHA256 secret for the webhook signature. Write-only via the API. */
  notificationWebhookSecret: text("notification_webhook_secret"),
  /** Role given to new members. */
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
    roleId: uuid("role_id").references(() => roles.id),
    /** True only for the tenant creator, who can never be removed. */
    isOriginator: boolean("is_originator").notNull().default(false),
    /** Legacy: permissions come from the role. */
    canInvite: boolean("can_invite").notNull().default(false),
    canKick: boolean("can_kick").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("memberships_user_tenant_idx").on(t.userId, t.tenantId)],
);

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
  (t) => [
    index("join_requests_tenant_idx").on(t.tenantId),
    // One pending request per tenant and requester
    uniqueIndex("join_requests_pending_uq")
      .on(t.tenantId, t.requesterId)
      .where(sql`status = 'pending'`),
    index("join_requests_tenant_requester_idx").on(t.tenantId, t.requesterId, t.requestedAt),
  ],
);

/**
 * Public addresses a tailnet answers to. `tenants.slug` stays the internal id.
 * One live row per tenant is primary. Retired names stay reserved for a quarantine period.
 */
export const tenantHostnames = pgTable(
  "tenant_hostnames",
  {
    slug: text("slug").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    retiredAt: timestamp("retired_at"),
  },
  (t) => [
    index("tenant_hostnames_tenant_idx").on(t.tenantId),
    uniqueIndex("tenant_hostnames_one_primary_idx")
      .on(t.tenantId)
      .where(sql`${t.isPrimary} AND ${t.retiredAt} IS NULL`),
  ],
);
