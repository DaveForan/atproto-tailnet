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
 * Migrations 0018+ are hand-written SQL (no drizzle-kit snapshots) — add the
 * SQL file and a matching drizzle/meta/_journal.json entry with each change.
 */

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
  "federation_requested",
  "federation_accepted",
  "federation_rejected",
  "federation_revoked",
  "sub_collective_created",
  "sub_collective_detached",
  "sub_collective_ejected",
  "sub_collective_quota_updated",
  "credential_revoked",
  "floor_policy_updated",
  "auth_key_revoked",
  "limits_updated",
  "notification_settings_updated",
  // Instance-operator actions (0026)
  "operator_settings_updated",
  "tailnet_creator_added",
  "tailnet_creator_removed",
  "tenant_suspended",
  "tenant_unsuspended",
  "tenant_deleted_by_operator",
  "user_disabled",
  "user_enabled",
  // MCP OAuth grants (0027) — instance-level rows (tenant_id NULL)
  "mcp_grant_created",
  "mcp_grant_revoked",
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
  /**
   * Operator suspension — orthogonal to `status` (the runtime state the
   * monitor/hibernation manage). Members get 403 `tenant_suspended`; the
   * coordinator rejects the tenant's nodes (Headscale mode: container stopped).
   */
  suspended: boolean("suspended").notNull().default(false),
  /**
   * Set when this tenant was suspended only because an ancestor was (cascade):
   * the id of the ancestor whose suspension cascaded. Unsuspending that
   * ancestor restores exactly these tenants (0028).
   */
  suspendedByParentId: uuid("suspended_by_parent_id"),
  requireDeviceApproval: boolean("require_device_approval")
    .notNull()
    .default(false),
  lockdownMode: boolean("lockdown_mode").notNull().default(false),
  /** When true, non-members can request to join via the public join page. */
  allowJoinRequests: boolean("allow_join_requests").notNull().default(false),
  /** When true, the public message board is visible at /board/:slug. */
  boardEnabled: boolean("board_enabled").notNull().default(false),
  /**
   * Device access mode (ADR-0036): "open" (every device reaches every
   * device, or the ACL policy if one is set) or "member" (own devices only,
   * plus approved service posts and shares between friends).
   */
  accessMode: text("access_mode").notNull().default("open"),
  /** Controller board: the originator's public text (Markdown subset). */
  controllerBoardText: text("controller_board_text"),
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
  /** Coordinator mode: last ACL policy accepted (Headscale shape), replayed after a coordinator restart. */
  coordinatorAclPolicy: jsonb("coordinator_acl_policy"),
  /** IPv4 CIDR prefix for the tailnet (default: 100.64.0.0/10). */
  ipv4Prefix: text("ipv4_prefix").notNull().default("100.64.0.0/10"),
  /** IPv6 CIDR prefix for the tailnet (default: fd7a:115c:a1e0::/48). */
  ipv6Prefix: text("ipv6_prefix").notNull().default("fd7a:115c:a1e0::/48"),
  /** IP allocation strategy: sequential or random. */
  ipAllocation: text("ip_allocation").notNull().default("sequential"),
  /** Legacy billing plan label — no longer read or exposed (caps are maxDevices/maxMembers). */
  planName: text("plan_name").notNull().default("free"),
  /** Maximum devices allowed (0 = unlimited). */
  maxDevices: integer("max_devices").notNull().default(0),
  /** Maximum members allowed (0 = unlimited). */
  maxMembers: integer("max_members").notNull().default(0),
  /** Parent collective ID for hierarchical nesting. NULL = root collective. */
  parentId: uuid("parent_id").references((): any => tenants.id, {
    onDelete: "restrict",
  }),
  /** Materialized path for tree queries (e.g., "root_slug.child_slug.grandchild_slug"). */
  path: text("path"),
  /** Depth in the collective tree. Root = 0. */
  depth: integer("depth").notNull().default(0),
  /** Maximum allowed sub-collectives (0 = unlimited). */
  maxSubCollectives: integer("max_sub_collectives").notNull().default(10),
  /** JSONB floor policies that sub-collectives cannot weaken. */
  floorPolicies: jsonb("floor_policies").$type<Record<string, unknown>>(),
  /** Egress traversal policy (ADR-0011) — controls outbound cross-collective traffic. */
  egressPolicy: jsonb("egress_policy").$type<{ rules: unknown[]; default: string }>(),
  /** Ingress traversal policy (ADR-0011) — controls inbound cross-collective traffic. */
  ingressPolicy: jsonb("ingress_policy").$type<{ rules: unknown[]; default: string }>(),
  /** Federation posture: closed (no inbound), selective (queue for operator), open (auto-accept). */
  federationPosture: federationPostureEnum("federation_posture").notNull().default("selective"),
  /** Federation scopes this collective participates in (ADR-0015). */
  federationScopes: jsonb("federation_scopes").$type<string[]>().default(["regional"]),
  /** UN M49 region code for regional federation grouping. */
  federationRegion: text("federation_region"),
  /** [lat, lon] for proximity-based local discovery. */
  federationCoordinates: jsonb("federation_coordinates").$type<[number, number]>(),
  /** Per-scope federation policy overrides. */
  federationScopePolicies: jsonb("federation_scope_policies").$type<Record<string, { autoAccept: boolean; verification: string }>>(),
  /** UUID of this tenant in the Rust mesh coordinator (ADR-0023). NULL when using Headscale. */
  coordinatorTenantId: text("coordinator_tenant_id"),
  /**
   * Coordinator mode: last route auto-approvers pushed (`{routes, exit_node}`),
   * replayed after a coordinator restart like the ACL policy.
   */
  coordinatorAutoApprovers: jsonb("coordinator_auto_approvers").$type<AutoApprovers>(),
  /** Optional webhook (self-hosted ntfy/Gotify/Matrix bridge…) fired on every notification. */
  notificationWebhookUrl: text("notification_webhook_url"),
  /** HMAC-SHA256 secret for the webhook signature. Write-only via the API. */
  notificationWebhookSecret: text("notification_webhook_secret"),
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
  (t) => [
    index("join_requests_tenant_idx").on(t.tenantId),
    // One pending request per (tenant, requester) — migration 0028
    uniqueIndex("join_requests_pending_uq")
      .on(t.tenantId, t.requesterId)
      .where(sql`status = 'pending'`),
    index("join_requests_tenant_requester_idx").on(t.tenantId, t.requesterId, t.requestedAt),
  ],
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
    /** NULL for instance-level operator actions (settings, creators, user disable). */
    tenantId: uuid("tenant_id").references(() => tenants.id),
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

export const federationLinks = pgTable(
  "federation_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** The local collective that owns this side of the link. */
    localTenantId: uuid("local_tenant_id")
      .notNull()
      .references(() => tenants.id),
    /** The remote collective's DID (may be on another instance). */
    peerDid: text("peer_did").notNull(),
    /** Where the peer's broker is reachable (from discovery). */
    peerBrokerUrl: text("peer_broker_url"),
    /** Display name from the peer's discovery document. */
    peerName: text("peer_name"),
    /** Who initiated: outgoing = we asked, incoming = they asked. */
    direction: linkDirectionEnum("direction").notNull(),
    status: federationStatusEnum("status").notNull().default("pending"),
    /** Optional note from the requester. */
    message: text("message"),
    /** CIDRs we share with the peer (JSONB array). */
    localCidrs: jsonb("local_cidrs").$type<string[]>().notNull().default([]),
    /** CIDRs the peer shares with us (JSONB array). */
    peerCidrs: jsonb("peer_cidrs").$type<string[]>().notNull().default([]),
    reviewedById: uuid("reviewed_by_id").references(() => users.id),
    /** DID-signed request payload (base64url JWS). */
    signedRequest: text("signed_request"),
    /** Protocol version agreed on link establishment. */
    protocolVersion: integer("protocol_version").notNull().default(1),
    /**
     * Set when the link ended with a permanent revocation (REVOKE /
     * LINK_REVOKE `permanent: true`, from either side). The broker never
     * re-handshakes such a link; federating again needs a new link request.
     */
    revokedPermanently: boolean("revoked_permanently").notNull().default(false),
    /**
     * Cross-instance link message (LINK_REQUEST/ACCEPT/REJECT/REVOKE) not yet
     * delivered to the peer's broker; retried with backoff by the broker loop
     * and re-signed (fresh timestamp, same messageId) on every attempt.
     * Null when nothing is pending. Shape owned by `federation/outbox.ts`.
     */
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

export const brokerSessionStatusEnum = pgEnum("broker_session_status", [
  "connecting",
  "established",
  "degraded",
  "disconnected",
]);

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
    /** CFP session id agreed in the handshake; identifies the session to the peer. */
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
    /** Each side of a link has exactly one session (its own view of the peer). */
    uniqueIndex("broker_sessions_link_local_uq").on(t.federationLinkId, t.localTenantId),
  ],
);

export const relayNodeStatusEnum = pgEnum("relay_node_status", [
  "provisioning",
  "active",
  "unhealthy",
  "decommissioned",
]);

export const relayNodes = pgTable(
  "relay_nodes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    brokerSessionId: uuid("broker_session_id")
      .notNull()
      .references(() => brokerSessions.id),
    containerId: text("container_id"),
    headscaleNodeId: text("headscale_node_id"),
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

export const credentialRevocations = pgTable(
  "credential_revocations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** The credential's `jti`; unique only per issuer, never globally. */
    credentialId: text("credential_id").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    issuerDid: text("issuer_did").notNull(),
    reason: text("reason"),
    revokedAt: timestamp("revoked_at").defaultNow().notNull(),
  },
  (t) => [
    index("cred_revocations_cred_idx").on(t.credentialId),
    uniqueIndex("cred_revocations_issuer_cred_idx").on(t.issuerDid, t.credentialId),
  ],
);

export const holderBindingChallenges = pgTable(
  "holder_binding_challenges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    nonce: text("nonce").notNull().unique(),
    holderDid: text("holder_did"),
    expiresAt: timestamp("expires_at").notNull(),
    consumed: boolean("consumed").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("holder_challenges_nonce_idx").on(t.nonce)],
);

export const serviceAuthJtiCache = pgTable(
  "service_auth_jti_cache",
  {
    jti: text("jti").primaryKey(),
    issuerDid: text("issuer_did").notNull(),
    audienceDid: text("audience_did").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("service_auth_jti_expires_idx").on(t.expiresAt)],
);

export interface FederationRouteEntry {
  prefix: string;
  collectiveChain: string[];
  origin: string;
  timestamp: string;
}

/**
 * Pre-auth keys issued through the service (both control-plane modes). The
 * secret key itself is never stored — only its prefix and the control plane's
 * non-secret key id, so keys can be listed and revoked later.
 */
export const authKeys = pgTable(
  "auth_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    /** Member the key was issued for (devices it registers are theirs). */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /** Key id on the control plane (Headscale numeric id / coordinator uuid). */
    controlKeyId: text("control_key_id"),
    /** First 12 chars of the key, for identification in the UI. */
    prefix: text("prefix").notNull(),
    /** Headscale user the key belongs to (Headscale mode only). */
    hsUsername: text("hs_username"),
    /** "device" (members' devices) or "service_device". */
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

/** Dashboard notifications — one row per recipient. */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    link: text("link"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    readAt: timestamp("read_at"),
  },
  (t) => [
    index("notifications_user_tenant_created_idx").on(t.userId, t.tenantId, t.createdAt),
  ],
);

/**
 * Instance-wide settings, a singleton row (id = 1) managed by operators.
 * `defaultTailnetId` is the tailnet offered to signed-in users with no access.
 */
export const instanceSettings = pgTable("instance_settings", {
  id: integer("id").primaryKey().default(1),
  /** At most one top-level tailnet; sub-collective creation refused too. */
  singleTailnet: boolean("single_tailnet").notNull().default(false),
  defaultTailnetId: uuid("default_tailnet_id").references(() => tenants.id, {
    onDelete: "set null",
  }),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/** DIDs an operator has allowed to create their own tailnet. */
export const tailnetCreators = pgTable("tailnet_creators", {
  id: uuid("id").defaultRandom().primaryKey(),
  did: text("did").notNull().unique(),
  handle: text("handle"),
  addedByUserId: uuid("added_by_user_id")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── MCP OAuth (remote MCP server at /mcp, see src/oauth/) ──────────────

/** OAuth clients registered via dynamic client registration (public clients, PKCE only). */
export const mcpOauthClients = pgTable("mcp_oauth_clients", {
  /** Generated client_id (UUID string). */
  id: text("id").primaryKey(),
  clientName: text("client_name"),
  redirectUris: jsonb("redirect_uris").notNull().$type<string[]>(),
  /** Full registered client metadata as returned to the client (never a secret). */
  metadata: jsonb("metadata").notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/** One row per user consent ("connection"): user + client + resource. */
export const mcpOauthGrants = pgTable(
  "mcp_oauth_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    clientId: text("client_id")
      .notNull()
      .references(() => mcpOauthClients.id, { onDelete: "cascade" }),
    /** RFC 8707 resource (audience) the grant's tokens are bound to — the /mcp URL. */
    resource: text("resource").notNull(),
    scopes: jsonb("scopes").notNull().$type<string[]>().default([]),
    /** Instance-operator scope: opt-in checkbox at consent, operators only (0028). */
    operator: boolean("operator").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at"),
    revokedAt: timestamp("revoked_at"),
  },
  (t) => [index("mcp_oauth_grants_user_idx").on(t.userId, t.createdAt)],
);

/** Access + refresh tokens. Raw tokens (`mcp_…`) are never stored — only SHA-256 hex. */
export const mcpOauthTokens = pgTable(
  "mcp_oauth_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => mcpOauthGrants.id, { onDelete: "cascade" }),
    /** "access" | "refresh" */
    kind: text("kind").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    /** Set when a refresh token is exchanged (rotation); reuse revokes the grant. */
    rotatedAt: timestamp("rotated_at"),
    revokedAt: timestamp("revoked_at"),
  },
  (t) => [index("mcp_oauth_tokens_grant_idx").on(t.grantId)],
);

/**
 * Public addresses (`<slug>.<BASE_DOMAIN>`) a tailnet answers to. `tenants.slug`
 * stays the permanent internal id (coordinator tenant slug, collective DID);
 * these rows are what Caddy routes and what new devices are told to use.
 * Exactly one live row per tenant is primary; older names stay as aliases so
 * enrolled devices keep working. A retired row is no longer routed and its
 * name stays reserved for a quarantine period before anyone may take it.
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

// ── Device visibility and consensual sharing (ADR-0036) ─────────────────

/** One protocol + port range a rule opens. */
export interface AccessPortSpec {
  proto: "any" | "tcp" | "udp" | "icmp";
  first: number;
  last: number;
}

/**
 * A service on a board: one device and one port.
 *
 * - `board = "public"`: offered to the members of the tailnet. Visible to
 *   others only when `status = "approved"`; a viewer then connects chosen
 *   devices (`service_connections`).
 * - `board = "private"`: for the author's own devices, reached at the private
 *   DNS name `<name>.<BASE_DOMAIN>`. Needs no approval.
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
    /** DNS label of the service (required on the private board). */
    name: text("name"),
    /** Control-plane node id of the service device. */
    nodeId: text("node_id").notNull(),
    proto: text("proto").notNull().$type<"tcp" | "udp">().default("tcp"),
    port: integer("port").notNull(),
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

/** Two members of a tailnet who agreed to be friends (or a pending request). */
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

/**
 * Access of a friend's devices to one device: the owner exposes, the guest
 * connects. Active only after the side that did not start it accepts.
 */
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
    /** The owner's device being exposed. */
    ownerNodeId: text("owner_node_id").notNull(),
    ports: jsonb("ports").notNull().$type<AccessPortSpec[]>(),
    /** The guest's devices that may connect; empty = all of the guest's devices. */
    guestNodeIds: jsonb("guest_node_ids").notNull().$type<string[]>().default([]),
    /** "requested" by the guest, "offered" by the owner, then "active", then "ended". */
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

// ── Device-bound access (ADR-0035) ──────────────────────────────────────

/**
 * A browser the user trusts for sign-in. While a user has any, a sign-in must
 * prove one of them: the browser signs a challenge with a key that cannot be
 * read out of it. Only the public key is stored here.
 */
export const trustedDevices = pgTable(
  "trusted_devices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** "device-key": WebCrypto ECDSA P-256 key held by the browser. */
    kind: text("kind").notNull().default("device-key"),
    publicKeyJwk: jsonb("public_key_jwk").notNull().$type<{ kty: string; crv: string; x: string; y: string }>(),
    /** Browser and system at enrolment, shown to the user (information only). */
    userAgent: text("user_agent"),
    /**
     * SHA-256 of the device cookie: a random token in an HttpOnly cookie that
     * page scripts cannot read. A proof needs the key and the cookie.
     */
    cookieHash: text("cookie_hash"),
    /** Traits of the browser at enrolment; a sign-in that looks different raises a warning. */
    profile: jsonb("profile").$type<Record<string, string>>(),
    /** Set when a sign-in with this key came from a browser that looked different. */
    profileWarning: text("profile_warning"),
    profileWarningAt: timestamp("profile_warning_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at"),
  },
  (t) => [index("trusted_devices_user_idx").on(t.userId)],
);

/** Single-use recovery codes; only SHA-256 hashes are stored. */
export const recoveryCodes = pgTable(
  "recovery_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("recovery_codes_user_idx").on(t.userId)],
);

/**
 * A new browser asking to become trusted. It shows a short code; the user
 * confirms the same code on a device that is already trusted.
 */
export const deviceTrustRequests = pgTable(
  "device_trust_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    publicKeyJwk: jsonb("public_key_jwk").notNull().$type<{ kty: string; crv: string; x: string; y: string }>(),
    userAgent: text("user_agent"),
    cookieHash: text("cookie_hash"),
    profile: jsonb("profile").$type<Record<string, string>>(),
    /** Shown on the new device and typed on the trusted one. */
    code: text("code").notNull(),
    status: text("status").notNull().$type<"pending" | "approved" | "denied">().default("pending"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (t) => [index("device_trust_requests_user_idx").on(t.userId, t.status)],
);
