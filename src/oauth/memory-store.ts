/**
 * @module oauth/memory-store
 * In-memory {@link OAuthStore} used by tests (same semantics as DbOAuthStore).
 */
import { randomUUID } from "node:crypto";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type {
  ConnectionView,
  GrantRow,
  OAuthStore,
  TokenKind,
  TokenRow,
  UserRow,
} from "./store.js";

export class MemoryOAuthStore implements OAuthStore {
  clients = new Map<string, { info: OAuthClientInformationFull; createdAt: Date }>();
  grants = new Map<string, GrantRow>();
  tokens = new Map<string, TokenRow>();
  users = new Map<string, UserRow>();
  audits: Array<{ actorUserId: string; action: string; grantId: string; metadata?: Record<string, unknown> }> = [];

  async getClient(clientId: string) {
    return this.clients.get(clientId)?.info;
  }
  async createClient(client: OAuthClientInformationFull) {
    this.clients.set(client.client_id, { info: client, createdAt: new Date() });
  }
  async pruneUnusedClients(before: Date) {
    for (const [id, c] of this.clients) {
      const used = [...this.grants.values()].some((g) => g.clientId === id);
      if (!used && c.createdAt < before) this.clients.delete(id);
    }
  }
  async createGrant(g: { userId: string; clientId: string; resource: string; scopes: string[]; operator?: boolean }) {
    const row: GrantRow = {
      id: randomUUID(),
      ...g,
      operator: g.operator === true,
      createdAt: new Date(),
      lastUsedAt: null,
      revokedAt: null,
    };
    this.grants.set(row.id, row);
    return row;
  }
  async revokeOtherGrants(userId: string, clientId: string, keepGrantId: string) {
    const out: string[] = [];
    for (const g of this.grants.values()) {
      if (g.userId === userId && g.clientId === clientId && g.id !== keepGrantId && !g.revokedAt) {
        await this.revokeGrant(g.id);
        out.push(g.id);
      }
    }
    return out;
  }
  async revokeGrant(grantId: string) {
    const g = this.grants.get(grantId);
    const wasActive = Boolean(g && !g.revokedAt);
    const now = new Date();
    if (g && !g.revokedAt) g.revokedAt = now;
    for (const t of this.tokens.values()) if (t.grantId === grantId && !t.revokedAt) t.revokedAt = now;
    return wasActive;
  }
  async revokeAllGrantsForUser(userId: string) {
    const out: string[] = [];
    for (const g of this.grants.values()) {
      if (g.userId === userId && !g.revokedAt && (await this.revokeGrant(g.id))) out.push(g.id);
    }
    return out;
  }
  async touchGrant(grantId: string) {
    const g = this.grants.get(grantId);
    if (g) g.lastUsedAt = new Date();
  }
  async listActiveGrants(userId: string): Promise<ConnectionView[]> {
    return [...this.grants.values()]
      .filter((g) => g.userId === userId && !g.revokedAt)
      .map((g) => ({
        id: g.id,
        clientId: g.clientId,
        clientName: this.clients.get(g.clientId)?.info.client_name ?? "Unnamed client",
        operator: g.operator,
        createdAt: g.createdAt,
        lastUsedAt: g.lastUsedAt,
      }));
  }
  async getGrant(grantId: string) {
    return this.grants.get(grantId);
  }
  async createToken(t: { grantId: string; kind: TokenKind; tokenHash: string; expiresAt: Date }) {
    const row: TokenRow = { id: randomUUID(), ...t, rotatedAt: null, revokedAt: null };
    this.tokens.set(row.tokenHash, row);
  }
  async findToken(tokenHash: string) {
    const token = this.tokens.get(tokenHash);
    if (!token) return undefined;
    const grant = this.grants.get(token.grantId);
    if (!grant) return undefined;
    const user = this.users.get(grant.userId);
    if (!user) return undefined;
    return { token, grant, user };
  }
  async markRotated(tokenId: string) {
    for (const t of this.tokens.values()) {
      if (t.id === tokenId) {
        if (t.rotatedAt || t.revokedAt) return false;
        t.rotatedAt = new Date();
        return true;
      }
    }
    return false;
  }
  async revokeToken(tokenId: string) {
    for (const t of this.tokens.values()) if (t.id === tokenId && !t.revokedAt) t.revokedAt = new Date();
  }
  async getUser(userId: string) {
    return this.users.get(userId);
  }
  audit(e: { actorUserId: string; action: string; grantId: string; metadata?: Record<string, unknown> }) {
    this.audits.push(e);
  }
}
