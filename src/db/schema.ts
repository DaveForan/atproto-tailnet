import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
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

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  did: text("did").notNull().unique(),
  handle: text("handle").notNull(),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

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
    role: memberRoleEnum("role").notNull().default("member"),
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
