/** Audit log, usage snapshots, notifications and instance-wide operator settings. */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  pgEnum,
  index,
} from "drizzle-orm/pg-core";
import { tenants, users } from "./tenancy.js";

export const auditActionEnum = pgEnum("audit_action", [
  "invitation_created",
  "invitation_accepted",
  "invitation_declined",
  "invitation_revoked",
  "member_removed",
  "member_permissions_updated", // Unused. PostgreSQL cannot drop enum values.
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
  "operator_settings_updated",
  "tailnet_creator_added",
  "tailnet_creator_removed",
  "tenant_suspended",
  "tenant_unsuspended",
  "tenant_deleted_by_operator",
  "user_disabled",
  "user_enabled",
  "mcp_grant_created",
  "mcp_grant_revoked",
  "device_signin_approved",
  "sign_in_succeeded",
  "sign_in_failed",
  "trusted_device_added",
  "trusted_device_removed",
  "trusted_device_approved",
  "recovery_codes_generated",
  "recovery_code_used",
  "step_up_refused",
]);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** NULL for instance-level actions. */
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

/** Dashboard notifications. One row per recipient. */
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

/** Instance-wide settings: a singleton row (id = 1) managed by operators. */
export const instanceSettings = pgTable("instance_settings", {
  id: integer("id").primaryKey().default(1),
  /** At most one top-level tailnet. Sub-collective creation is refused too. */
  singleTailnet: boolean("single_tailnet").notNull().default(false),
  /** Tailnet offered to signed-in users with no access. */
  defaultTailnetId: uuid("default_tailnet_id").references(() => tenants.id, {
    onDelete: "set null",
  }),
  /** Machine-lock refusals up to this time are already notifications. */
  machineRefusedSeenAt: timestamp("machine_refused_seen_at"),
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
