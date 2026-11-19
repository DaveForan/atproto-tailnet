/**
 * @module oauth/provider
 * MCP OAuth 2.1 authorization server backed by our DB, implementing the SDK's
 * {@link OAuthServerProvider}. The SDK handlers (authorize/token/register/
 * revoke) do request parsing, client authentication and PKCE S256
 * verification; this class owns policy and state:
 *
 * - Dynamic client registration: public clients only (PKCE, no secret);
 *   redirect URIs must be https, or http on a loopback host.
 * - Authorization: existing Bluesky session + consent page (see oauth/router.ts).
 * - Codes: in-memory, 60 s TTL, single use; replaying a used code revokes the
 *   grant it produced (OAuth 2.1 §4.1.3).
 * - Tokens: opaque `mcp_…`, SHA-256 at rest, access 1 h, refresh 30 d rotated
 *   on every use; reuse of a rotated refresh token revokes the whole grant.
 * - Every token is bound to user + client + resource (the /mcp URL), and stops
 *   working when the grant is revoked or the user is disabled.
 */
import type { Request, Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  AccessDeniedError,
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthStore } from "./store.js";
import type { PendingAuthorization } from "./types.js";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTH_CODE_TTL_MS,
  CONSENT_TTL_MS,
  REFRESH_TOKEN_TTL_SECONDS,
  generateMcpToken,
  generateOpaqueId,
  hashToken,
  isMcpToken,
} from "./tokens.js";
import { consentPage, signInPage } from "./pages.js";
import { logger } from "../logger.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_REDIRECT_URIS = 10;
const MAX_URI_LENGTH = 2048;
const MAX_CLIENT_NAME = 100;
const MAX_PENDING_CONSENTS = 5;
/** Unused DCR registrations are pruned after this long. */
const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;
const TOUCH_DEBOUNCE_MS = 60 * 1000;

interface PendingCode {
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scopes: string[];
  expiresAt: number;
}

/** Throws InvalidClientMetadataError unless `uri` is https, or http on a loopback host. */
export function validateRedirectUri(uri: string): void {
  if (typeof uri !== "string" || uri.length > MAX_URI_LENGTH) {
    throw new InvalidClientMetadataError("redirect_uri is too long");
  }
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    throw new InvalidClientMetadataError(`Invalid redirect_uri: ${uri}`);
  }
  if (u.hash) throw new InvalidClientMetadataError("redirect_uri must not contain a fragment");
  if (u.username || u.password) {
    throw new InvalidClientMetadataError("redirect_uri must not contain credentials");
  }
  if (u.protocol === "https:") return;
  if (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname)) return;
  throw new InvalidClientMetadataError(
    "redirect_uri must use https, or http on a loopback address (localhost, 127.0.0.1, [::1])",
  );
}

/** Same resource, ignoring a fragment and one trailing slash. */
function comparableResource(value: string): string {
  const hash = value.indexOf("#");
  return (hash === -1 ? value : value.slice(0, hash)).replace(/\/$/, "");
}

export function sameResource(a: string, b: string): boolean {
  return comparableResource(a) === comparableResource(b);
}

function cleanClientName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_CLIENT_NAME);
  return cleaned || undefined;
}

export interface ProviderOptions {
  store: OAuthStore;
  /** Absolute URL of the MCP endpoint, e.g. https://example.com/mcp — the token audience. */
  resourceUrl: string;
  now?: () => number;
}

export class TailnetOAuthProvider implements OAuthServerProvider {
  readonly store: OAuthStore;
  readonly resourceUrl: string;
  private readonly now: () => number;
  private readonly codes = new Map<string, PendingCode>();
  /** Recently consumed codes → grant they produced (replay detection). */
  private readonly usedCodes = new Map<string, { grantId: string | null; expiresAt: number }>();
  private readonly lastTouch = new Map<string, number>();

  constructor(opts: ProviderOptions) {
    this.store = opts.store;
    this.resourceUrl = opts.resourceUrl;
    this.now = opts.now ?? (() => Date.now());
  }

  // ── Clients (dynamic registration) ──────────────────────────────────

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId: string) => this.store.getClient(clientId),
      registerClient: async (client) => {
        const full = client as OAuthClientInformationFull;
        if (!Array.isArray(full.redirect_uris) || full.redirect_uris.length === 0) {
          throw new InvalidClientMetadataError("At least one redirect_uri is required");
        }
        if (full.redirect_uris.length > MAX_REDIRECT_URIS) {
          throw new InvalidClientMetadataError(`At most ${MAX_REDIRECT_URIS} redirect_uris are allowed`);
        }
        for (const uri of full.redirect_uris) validateRedirectUri(uri);
        const grantTypes = full.grant_types ?? ["authorization_code", "refresh_token"];
        if (grantTypes.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
          throw new InvalidClientMetadataError("Only authorization_code and refresh_token grants are supported");
        }
        const responseTypes = full.response_types ?? ["code"];
        if (responseTypes.some((r) => r !== "code")) {
          throw new InvalidClientMetadataError("Only the code response type is supported");
        }
        // Public clients only: PKCE protects the code, so no secret is issued
        // or stored (RFC 7591 lets the server replace requested metadata).
        const info: OAuthClientInformationFull = {
          ...full,
          client_name: cleanClientName(full.client_name),
          grant_types: grantTypes,
          response_types: responseTypes,
          token_endpoint_auth_method: "none",
        };
        delete info.client_secret;
        delete info.client_secret_expires_at;
        await this.store.createClient(info);
        this.store
          .pruneUnusedClients(new Date(this.now() - UNUSED_CLIENT_TTL_MS))
          .catch((err) => logger.warn({ err }, "pruning unused MCP OAuth clients failed"));
        return info;
      },
    };
  }

  // ── Authorization (sign-in + consent) ───────────────────────────────

  /** Normalises the requested resource; undefined means "the MCP endpoint". */
  private checkResource(resource: URL | string | undefined): string {
    if (resource === undefined) return this.resourceUrl;
    if (!sameResource(String(resource), this.resourceUrl)) {
      throw new InvalidTargetError(`Unknown resource; this server issues tokens for ${this.resourceUrl}`);
    }
    return this.resourceUrl;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const req = res.req as Request;
    const resource = this.checkResource(params.resource);
    const clientName = client.client_name ?? "An MCP client";

    const userId = req.session?.userId;
    if (!userId) {
      // Into the existing Bluesky login; /auth/login stores `redirect` as the
      // post-login destination (a local path) and brings the user back here.
      const q = new URLSearchParams({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: params.redirectUri,
        code_challenge: params.codeChallenge,
        code_challenge_method: "S256",
      });
      if (params.state !== undefined) q.set("state", params.state);
      if (params.scopes && params.scopes.length > 0) q.set("scope", params.scopes.join(" "));
      if (params.resource) q.set("resource", String(params.resource));
      res.status(200).type("html").send(signInPage({ clientName, returnTo: `/oauth/authorize?${q}` }));
      return;
    }

    const user = await this.store.getUser(userId);
    if (!user || user.disabledAt) {
      throw new AccessDeniedError("This account cannot authorize applications");
    }

    const now = this.now();
    const pending: Record<string, PendingAuthorization> = {};
    // Keep only live entries and cap their number.
    const existing = Object.entries(req.session.mcpPendingAuthz ?? {})
      .filter(([, p]) => p.expiresAt > now)
      .slice(-(MAX_PENDING_CONSENTS - 1));
    for (const [k, v] of existing) pending[k] = v;
    const requestId = generateOpaqueId();
    pending[requestId] = {
      userId,
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes ?? [],
      resource,
      expiresAt: now + CONSENT_TTL_MS,
    };
    req.session.mcpPendingAuthz = pending;
    if (!req.session.csrfToken) req.session.csrfToken = generateOpaqueId();

    let redirectHost = params.redirectUri;
    try {
      redirectHost = new URL(params.redirectUri).host;
    } catch {
      /* validated by the SDK already */
    }
    res.status(200).type("html").send(
      consentPage({
        clientName,
        handle: user.handle,
        redirectHost,
        requestId,
        csrfToken: req.session.csrfToken,
      }),
    );
  }

  /** Mints a single-use authorization code after the user clicked Allow. */
  issueAuthorizationCode(p: Omit<PendingCode, "expiresAt">): string {
    this.sweep();
    const code = generateOpaqueId();
    this.codes.set(code, { ...p, expiresAt: this.now() + AUTH_CODE_TTL_MS });
    return code;
  }

  private sweep(): void {
    const now = this.now();
    for (const [k, v] of this.codes) if (v.expiresAt <= now) this.codes.delete(k);
    for (const [k, v] of this.usedCodes) if (v.expiresAt <= now) this.usedCodes.delete(k);
  }

  private async rejectReplayedCode(code: string): Promise<never> {
    const used = this.usedCodes.get(code);
    if (used?.grantId) {
      const grant = await this.store.getGrant(used.grantId);
      if (await this.store.revokeGrant(used.grantId)) {
        if (grant) {
          this.store.audit({
            actorUserId: grant.userId,
            action: "mcp_grant_revoked",
            grantId: used.grantId,
            metadata: { clientId: grant.clientId, reason: "authorization_code_replay" },
          });
        }
      }
      logger.warn({ grantId: used.grantId }, "MCP authorization code replayed; grant revoked");
    }
    throw new InvalidGrantError("Authorization code is invalid, expired or already used");
  }

  private liveCode(client: OAuthClientInformationFull, code: string): PendingCode | undefined {
    const c = this.codes.get(code);
    if (!c) return undefined;
    if (c.expiresAt <= this.now()) {
      this.codes.delete(code);
      return undefined;
    }
    if (c.clientId !== client.client_id) return undefined;
    return c;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const c = this.liveCode(client, authorizationCode);
    if (!c) return this.rejectReplayedCode(authorizationCode);
    return c.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const c = this.liveCode(client, authorizationCode);
    if (!c) return this.rejectReplayedCode(authorizationCode);
    // Single use: consume synchronously before any await.
    this.codes.delete(authorizationCode);
    const used = { grantId: null as string | null, expiresAt: this.now() + 10 * AUTH_CODE_TTL_MS };
    this.usedCodes.set(authorizationCode, used);

    if (redirectUri !== undefined && redirectUri !== c.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    if (resource !== undefined && !sameResource(resource.href, c.resource)) {
      throw new InvalidTargetError("resource does not match the authorization request");
    }
    const user = await this.store.getUser(c.userId);
    if (!user || user.disabledAt) throw new InvalidGrantError("User cannot use this application");

    const grant = await this.store.createGrant({
      userId: c.userId,
      clientId: c.clientId,
      resource: c.resource,
      scopes: c.scopes,
    });
    used.grantId = grant.id;
    this.store.audit({
      actorUserId: c.userId,
      action: "mcp_grant_created",
      grantId: grant.id,
      metadata: { clientId: c.clientId, clientName: client.client_name ?? null },
    });
    // One connection per client: a fresh consent replaces the previous one.
    const replaced = await this.store.revokeOtherGrants(c.userId, c.clientId, grant.id);
    for (const id of replaced) {
      this.store.audit({
        actorUserId: c.userId,
        action: "mcp_grant_revoked",
        grantId: id,
        metadata: { clientId: c.clientId, reason: "replaced_by_new_grant" },
      });
    }
    return this.issueTokens(grant.id);
  }

  private async issueTokens(grantId: string): Promise<OAuthTokens> {
    const access = generateMcpToken();
    const refresh = generateMcpToken();
    const now = this.now();
    await this.store.createToken({
      grantId,
      kind: "access",
      tokenHash: hashToken(access),
      expiresAt: new Date(now + ACCESS_TOKEN_TTL_SECONDS * 1000),
    });
    await this.store.createToken({
      grantId,
      kind: "refresh",
      tokenHash: hashToken(refresh),
      expiresAt: new Date(now + REFRESH_TOKEN_TTL_SECONDS * 1000),
    });
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refresh,
    };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const invalid = () => new InvalidGrantError("Refresh token is invalid, expired or revoked");
    if (!isMcpToken(refreshToken)) throw invalid();
    const found = await this.store.findToken(hashToken(refreshToken));
    if (!found || found.token.kind !== "refresh" || found.grant.clientId !== client.client_id) {
      throw invalid();
    }
    const { token, grant, user } = found;
    if (token.rotatedAt) {
      // Reuse of a rotated refresh token: assume theft, kill the grant.
      await this.revokeGrantAudited(grant.id, grant.userId, grant.clientId, "refresh_token_reuse");
      throw invalid();
    }
    if (token.revokedAt || grant.revokedAt || token.expiresAt.getTime() <= this.now()) throw invalid();
    if (user.disabledAt) throw invalid();
    if (resource !== undefined && !sameResource(resource.href, grant.resource)) {
      throw new InvalidTargetError("resource does not match the grant");
    }
    if (!(await this.store.markRotated(token.id))) {
      await this.revokeGrantAudited(grant.id, grant.userId, grant.clientId, "refresh_token_reuse");
      throw invalid();
    }
    return this.issueTokens(grant.id);
  }

  private async revokeGrantAudited(grantId: string, userId: string, clientId: string, reason: string) {
    if (await this.store.revokeGrant(grantId)) {
      this.store.audit({ actorUserId: userId, action: "mcp_grant_revoked", grantId, metadata: { clientId, reason } });
    }
  }

  // ── Resource-server side ────────────────────────────────────────────

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (!isMcpToken(token)) throw new InvalidTokenError("Invalid access token");
    const found = await this.store.findToken(hashToken(token));
    if (!found || found.token.kind !== "access") throw new InvalidTokenError("Invalid access token");
    const { token: row, grant, user } = found;
    if (row.revokedAt || grant.revokedAt) throw new InvalidTokenError("Access token has been revoked");
    if (row.expiresAt.getTime() <= this.now()) throw new InvalidTokenError("Access token has expired");
    if (user.disabledAt) throw new InvalidTokenError("User account is disabled");

    const last = this.lastTouch.get(grant.id) ?? 0;
    if (this.now() - last > TOUCH_DEBOUNCE_MS) {
      this.lastTouch.set(grant.id, this.now());
      this.store.touchGrant(grant.id).catch(() => {});
    }

    return {
      token,
      clientId: grant.clientId,
      scopes: grant.scopes,
      expiresAt: Math.floor(row.expiresAt.getTime() / 1000),
      resource: new URL(grant.resource),
      extra: { userId: user.id, grantId: grant.id, did: user.did, handle: user.handle },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    if (!isMcpToken(request.token)) return;
    const found = await this.store.findToken(hashToken(request.token));
    if (!found || found.grant.clientId !== client.client_id) return; // RFC 7009: no error
    if (found.token.kind === "refresh") {
      await this.revokeGrantAudited(found.grant.id, found.grant.userId, found.grant.clientId, "client_revoked");
    } else {
      await this.store.revokeToken(found.token.id);
    }
  }

  /** Dashboard revocation (GET/DELETE /api/mcp/connections). */
  async revokeGrantForUser(userId: string, grantId: string): Promise<boolean> {
    const grant = await this.store.getGrant(grantId);
    if (!grant || grant.userId !== userId || grant.revokedAt) return false;
    await this.revokeGrantAudited(grant.id, userId, grant.clientId, "user_revoked");
    return true;
  }
}
