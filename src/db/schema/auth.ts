/** Sign-in state, agent tokens and MCP OAuth (the remote MCP server at /mcp). */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  jsonb,
  pgEnum,
  index,
} from "drizzle-orm/pg-core";
import { tenants, users } from "./tenancy.js";

export const agentTokenStatusEnum = pgEnum("agent_token_status", [
  "active",
  "revoked",
]);

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

/** API tokens for AI agents. Only the SHA-256 hash of the token is stored. */
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
    /** First 8 characters of the raw token, shown in the UI. */
    tokenPrefix: text("token_prefix").notNull(),
    /** Permission strings. They never exceed the creator's role permissions. */
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

/** OAuth clients from dynamic client registration. Public clients with PKCE only. */
export const mcpOauthClients = pgTable("mcp_oauth_clients", {
  /** Generated client_id (UUID string). */
  id: text("id").primaryKey(),
  clientName: text("client_name"),
  redirectUris: jsonb("redirect_uris").notNull().$type<string[]>(),
  /** Registered client metadata as returned to the client. It never holds a secret. */
  metadata: jsonb("metadata").notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/** One user consent: user, client and resource. */
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
    /** RFC 8707 resource (the /mcp URL) the grant's tokens are bound to. */
    resource: text("resource").notNull(),
    scopes: jsonb("scopes").notNull().$type<string[]>().default([]),
    /** Instance-operator scope. Opt-in at consent, operators only. */
    operator: boolean("operator").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at"),
    revokedAt: timestamp("revoked_at"),
  },
  (t) => [index("mcp_oauth_grants_user_idx").on(t.userId, t.createdAt)],
);

/** Access and refresh tokens. Only SHA-256 hex hashes are stored. */
export const mcpOauthTokens = pgTable(
  "mcp_oauth_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => mcpOauthGrants.id, { onDelete: "cascade" }),
    /** "access" or "refresh". */
    kind: text("kind").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    /** Set when a refresh token is exchanged. Reuse revokes the grant. */
    rotatedAt: timestamp("rotated_at"),
    revokedAt: timestamp("revoked_at"),
  },
  (t) => [index("mcp_oauth_tokens_grant_idx").on(t.grantId)],
);
