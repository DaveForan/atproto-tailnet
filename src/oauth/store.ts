/**
 * @module oauth/store
 * Persistence for MCP OAuth: registered clients, grants (one per consent) and
 * hashed tokens. {@link DbOAuthStore} is the Postgres implementation; tests use
 * `MemoryOAuthStore` (oauth/memory-store.ts) through the same interface.
 */
import { and, desc, eq, isNull, lt, notExists, sql } from "drizzle-orm";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { db } from "../db/index.js";
import {
  auditLogs,
  mcpOauthClients,
  mcpOauthGrants,
  mcpOauthTokens,
  users,
} from "../db/schema.js";
import { logger } from "../logger.js";

export type TokenKind = "access" | "refresh";

export interface GrantRow {
  id: string;
  userId: string;
  clientId: string;
  resource: string;
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface TokenRow {
  id: string;
  grantId: string;
  kind: TokenKind;
  tokenHash: string;
  expiresAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
}

export interface UserRow {
  id: string;
  did: string;
  handle: string;
  disabledAt: Date | null;
}

export interface ConnectionView {
  id: string;
  clientId: string;
  clientName: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface OAuthStore {
  getClient(clientId: string): Promise<OAuthClientInformationFull | undefined>;
  createClient(client: OAuthClientInformationFull): Promise<void>;
  /** Delete registered clients older than `before` that never got a grant. */
  pruneUnusedClients(before: Date): Promise<void>;

  createGrant(g: { userId: string; clientId: string; resource: string; scopes: string[] }): Promise<GrantRow>;
  /** Revoke the user's other active grants for this client (one connection per client). */
  revokeOtherGrants(userId: string, clientId: string, keepGrantId: string): Promise<string[]>;
  /** Revoke a grant and all its tokens. Returns false if it was already revoked / missing. */
  revokeGrant(grantId: string): Promise<boolean>;
  touchGrant(grantId: string): Promise<void>;
  listActiveGrants(userId: string): Promise<ConnectionView[]>;
  getGrant(grantId: string): Promise<GrantRow | undefined>;

  createToken(t: { grantId: string; kind: TokenKind; tokenHash: string; expiresAt: Date }): Promise<void>;
  findToken(tokenHash: string): Promise<{ token: TokenRow; grant: GrantRow; user: UserRow } | undefined>;
  /** Atomically mark a refresh token as used. False if it was already rotated/revoked. */
  markRotated(tokenId: string): Promise<boolean>;
  revokeToken(tokenId: string): Promise<void>;

  getUser(userId: string): Promise<UserRow | undefined>;
  audit(e: {
    actorUserId: string;
    action: "mcp_grant_created" | "mcp_grant_revoked";
    grantId: string;
    metadata?: Record<string, unknown>;
  }): void;
}

/** `users.disabledAt` is read defensively so this works before/after that column lands. */
function disabledAtOf(row: object): Date | null {
  const v = (row as { disabledAt?: Date | null }).disabledAt;
  return v ?? null;
}

function toGrant(r: typeof mcpOauthGrants.$inferSelect): GrantRow {
  return { ...r, scopes: (r.scopes ?? []) as string[] };
}

function toToken(r: typeof mcpOauthTokens.$inferSelect): TokenRow {
  return { ...r, kind: r.kind as TokenKind };
}

export class DbOAuthStore implements OAuthStore {
  async getClient(clientId: string) {
    const [row] = await db
      .select()
      .from(mcpOauthClients)
      .where(eq(mcpOauthClients.id, clientId));
    if (!row) return undefined;
    return row.metadata as unknown as OAuthClientInformationFull;
  }

  async createClient(client: OAuthClientInformationFull) {
    await db.insert(mcpOauthClients).values({
      id: client.client_id,
      clientName: client.client_name ?? null,
      redirectUris: client.redirect_uris,
      metadata: client as unknown as Record<string, unknown>,
    });
  }

  async pruneUnusedClients(before: Date) {
    await db
      .delete(mcpOauthClients)
      .where(
        and(
          lt(mcpOauthClients.createdAt, before),
          notExists(
            db
              .select({ one: sql`1` })
              .from(mcpOauthGrants)
              .where(eq(mcpOauthGrants.clientId, mcpOauthClients.id)),
          ),
        ),
      );
  }

  async createGrant(g: { userId: string; clientId: string; resource: string; scopes: string[] }) {
    const [row] = await db.insert(mcpOauthGrants).values(g).returning();
    return toGrant(row);
  }

  async revokeOtherGrants(userId: string, clientId: string, keepGrantId: string) {
    const active = await db
      .select({ id: mcpOauthGrants.id })
      .from(mcpOauthGrants)
      .where(
        and(
          eq(mcpOauthGrants.userId, userId),
          eq(mcpOauthGrants.clientId, clientId),
          isNull(mcpOauthGrants.revokedAt),
        ),
      );
    const revoked: string[] = [];
    for (const { id } of active) {
      if (id !== keepGrantId && (await this.revokeGrant(id))) revoked.push(id);
    }
    return revoked;
  }

  async revokeGrant(grantId: string) {
    const now = new Date();
    const updated = await db
      .update(mcpOauthGrants)
      .set({ revokedAt: now })
      .where(and(eq(mcpOauthGrants.id, grantId), isNull(mcpOauthGrants.revokedAt)))
      .returning({ id: mcpOauthGrants.id });
    await db
      .update(mcpOauthTokens)
      .set({ revokedAt: now })
      .where(and(eq(mcpOauthTokens.grantId, grantId), isNull(mcpOauthTokens.revokedAt)));
    return updated.length > 0;
  }

  async touchGrant(grantId: string) {
    await db
      .update(mcpOauthGrants)
      .set({ lastUsedAt: new Date() })
      .where(eq(mcpOauthGrants.id, grantId));
  }

  async listActiveGrants(userId: string) {
    const rows = await db
      .select({
        id: mcpOauthGrants.id,
        clientId: mcpOauthGrants.clientId,
        clientName: mcpOauthClients.clientName,
        createdAt: mcpOauthGrants.createdAt,
        lastUsedAt: mcpOauthGrants.lastUsedAt,
      })
      .from(mcpOauthGrants)
      .innerJoin(mcpOauthClients, eq(mcpOauthGrants.clientId, mcpOauthClients.id))
      .where(and(eq(mcpOauthGrants.userId, userId), isNull(mcpOauthGrants.revokedAt)))
      .orderBy(desc(mcpOauthGrants.createdAt))
      .limit(200);
    return rows.map((r) => ({ ...r, clientName: r.clientName ?? "Unnamed client" }));
  }

  async getGrant(grantId: string) {
    const [row] = await db.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.id, grantId));
    return row ? toGrant(row) : undefined;
  }

  async createToken(t: { grantId: string; kind: TokenKind; tokenHash: string; expiresAt: Date }) {
    await db.insert(mcpOauthTokens).values(t);
  }

  async findToken(tokenHash: string) {
    const [row] = await db
      .select({ token: mcpOauthTokens, grant: mcpOauthGrants, user: users })
      .from(mcpOauthTokens)
      .innerJoin(mcpOauthGrants, eq(mcpOauthTokens.grantId, mcpOauthGrants.id))
      .innerJoin(users, eq(mcpOauthGrants.userId, users.id))
      .where(eq(mcpOauthTokens.tokenHash, tokenHash));
    if (!row) return undefined;
    return {
      token: toToken(row.token),
      grant: toGrant(row.grant),
      user: {
        id: row.user.id,
        did: row.user.did,
        handle: row.user.handle,
        disabledAt: disabledAtOf(row.user),
      },
    };
  }

  async markRotated(tokenId: string) {
    const updated = await db
      .update(mcpOauthTokens)
      .set({ rotatedAt: new Date() })
      .where(
        and(
          eq(mcpOauthTokens.id, tokenId),
          isNull(mcpOauthTokens.rotatedAt),
          isNull(mcpOauthTokens.revokedAt),
        ),
      )
      .returning({ id: mcpOauthTokens.id });
    return updated.length > 0;
  }

  async revokeToken(tokenId: string) {
    await db
      .update(mcpOauthTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(mcpOauthTokens.id, tokenId), isNull(mcpOauthTokens.revokedAt)));
  }

  async getUser(userId: string) {
    const [row] = await db.select().from(users).where(eq(users.id, userId));
    if (!row) return undefined;
    return { id: row.id, did: row.did, handle: row.handle, disabledAt: disabledAtOf(row) };
  }

  audit(e: {
    actorUserId: string;
    action: "mcp_grant_created" | "mcp_grant_revoked";
    grantId: string;
    metadata?: Record<string, unknown>;
  }) {
    // Instance-level audit row (tenant_id NULL, migration 0026).
    db.insert(auditLogs)
      .values({
        tenantId: null,
        actorUserId: e.actorUserId,
        action: e.action,
        targetType: "mcp_grant",
        targetId: e.grantId,
        metadata: e.metadata ?? null,
      })
      .catch((err) => logger.error({ err }, "MCP audit log write failed"));
  }
}
