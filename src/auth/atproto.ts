/**
 * @module auth/atproto
 * AT Protocol OAuth client (confidential BFF client). State and sessions live in PostgreSQL.
 */
import { NodeOAuthClient } from "@atproto/oauth-client-node";
import { safeFetchWrap } from "@atproto-labs/fetch-node";
import type {
  NodeSavedState,
  NodeSavedSession,
} from "@atproto/oauth-client-node";
import { JoseKey } from "@atproto/jwk-jose";
import net from "node:net";
import { eq, lt } from "drizzle-orm";
import { config, isLoopbackDeployment } from "../config.js";
import { db } from "../db/index.js";
import { oauthStates, oauthSessions } from "../db/schema.js";
import { isPublicAddress } from "../identity/resolver.js";

/**
 * The only OAuth scope requested: `atproto` proves who the account is and
 * grants nothing else — no reading or writing posts, follows, messages or
 * settings. Never add `transition:*` scopes: sign-in is identification only.
 */
export const OAUTH_SCOPE = "atproto";

type StateStore = {
  get(key: string): Promise<NodeSavedState | undefined>;
  set(key: string, val: NodeSavedState): Promise<void>;
  del(key: string): Promise<void>;
};

type SessionStore = {
  get(key: string): Promise<NodeSavedSession | undefined>;
  set(key: string, val: NodeSavedSession): Promise<void>;
  del(key: string): Promise<void>;
};

const dbStateStore: StateStore = {
  async get(key) {
    const [row] = await db
      .select()
      .from(oauthStates)
      .where(eq(oauthStates.key, key));
    return row ? (JSON.parse(row.state) as NodeSavedState) : undefined;
  },
  async set(key, val) {
    await db
      .insert(oauthStates)
      .values({ key, state: JSON.stringify(val) })
      .onConflictDoUpdate({
        target: oauthStates.key,
        set: { state: JSON.stringify(val) },
      });
  },
  async del(key) {
    await db.delete(oauthStates).where(eq(oauthStates.key, key));
  },
};

/** Pending OAuth states older than this are abandoned sign-ins. */
export const OAUTH_STATE_TTL_MS = 60 * 60 * 1000;

/** Delete abandoned OAuth login states (called from the monitor sweep). */
export async function sweepExpiredOAuthStates(now = new Date()): Promise<void> {
  await db
    .delete(oauthStates)
    .where(lt(oauthStates.createdAt, new Date(now.getTime() - OAUTH_STATE_TTL_MS)));
}

const dbSessionStore: SessionStore = {
  async get(key) {
    const [row] = await db
      .select()
      .from(oauthSessions)
      .where(eq(oauthSessions.key, key));
    return row ? (JSON.parse(row.session) as NodeSavedSession) : undefined;
  },
  async set(key, val) {
    await db
      .insert(oauthSessions)
      .values({ key, session: JSON.stringify(val) })
      .onConflictDoUpdate({
        target: oauthSessions.key,
        set: { session: JSON.stringify(val), updatedAt: new Date() },
      });
  },
  async del(key) {
    await db.delete(oauthSessions).where(eq(oauthSessions.key, key));
  },
};

/** Fetch signature the OAuth client accepts. */
export type OAuthFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Host of a fetch input without IPv6 brackets. */
function inputHost(input: string | URL | Request): string {
  const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
  return url.hostname.replace(/^\[|\]$/g, "");
}

/**
 * Fetch for every OAuth lookup (did:web, PDS and auth-server metadata, token calls).
 * Security: the user picks these hosts at /auth/login. Outside a loopback deployment
 * only https to public unicast addresses is allowed, and redirects are never followed.
 */
export function createOAuthFetch(loopback: boolean, base: OAuthFetch = globalThis.fetch): OAuthFetch {
  const safe = safeFetchWrap({
    fetch: base,
    ssrfProtection: !loopback,
    allowImplicitRedirect: false,
    timeout: 10_000,
  });
  return async (input, init) => {
    // IP literals skip the connect-time DNS check, so they are judged here.
    const host = inputHost(input);
    if (!loopback && net.isIP(host) && !isPublicAddress(host)) {
      throw new TypeError("OAuth fetch refused: non-public address");
    }
    // A followed redirect could reach an address the checks never saw.
    const asked = init?.redirect ?? (input instanceof Request ? input.redirect : "follow");
    return safe(input, { ...init, redirect: asked === "follow" ? "error" : asked });
  };
}

let clientInstance: NodeOAuthClient | null = null;

/**
 * The singleton OAuth client: a loopback client_id in local development,
 * private_key_jwt with ATPROTO_PRIVATE_KEY otherwise.
 */
export async function getOAuthClient(): Promise<NodeOAuthClient> {
  if (clientInstance) return clientInstance;

  const url = config.publicUrl;
  const enc = encodeURIComponent;
  const fetch = createOAuthFetch(isLoopbackDeployment);

  if (isLoopbackDeployment) {
    // Loopback clients must be redirected to an IP literal, never the name
    // "localhost" (RFC 8252 §7.3) — the OAuth client rejects it outright.
    const callback = new URL("/auth/callback", url);
    if (callback.hostname === "localhost") callback.hostname = "127.0.0.1";
    const redirectUri = callback.toString();

    clientInstance = new NodeOAuthClient({
      clientMetadata: {
        client_name: "atproto-tailnet (dev)",
        client_id: `http://localhost?redirect_uri=${enc(redirectUri)}&scope=${enc(OAUTH_SCOPE)}`,
        client_uri: url,
        redirect_uris: [redirectUri],
        scope: OAUTH_SCOPE,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        application_type: "web",
        token_endpoint_auth_method: "none",
        dpop_bound_access_tokens: true,
      },
      stateStore: dbStateStore,
      sessionStore: dbSessionStore,
      fetch,
    });
  } else {
    const privateKey = await JoseKey.fromImportable(
      config.atprotoPrivateKey ?? "",
      atprotoKeyId(config.atprotoPrivateKey),
    );

    clientInstance = new NodeOAuthClient({
      clientMetadata: {
        client_name: "atproto-tailnet",
        client_id: `${url}/.well-known/atproto-client-metadata.json`,
        client_uri: url,
        redirect_uris: [`${url}/auth/callback`],
        scope: OAUTH_SCOPE,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        application_type: "web",
        token_endpoint_auth_method: "private_key_jwt",
        token_endpoint_auth_signing_alg: "ES256",
        jwks_uri: `${url}/.well-known/jwks.json`,
        dpop_bound_access_tokens: true,
      },
      keyset: [privateKey],
      stateStore: dbStateStore,
      sessionStore: dbSessionStore,
      fetch,
    });
  }

  return clientInstance;
}

/** Returns the production client metadata object, served at `/.well-known/atproto-client-metadata.json`. */
export function getClientMetadata(): object {
  const url = config.publicUrl;
  return {
    client_name: "atproto-tailnet",
    client_id: `${url}/.well-known/atproto-client-metadata.json`,
    client_uri: url,
    redirect_uris: [`${url}/auth/callback`],
    scope: OAUTH_SCOPE,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    application_type: "web",
    token_endpoint_auth_method: "private_key_jwt",
    token_endpoint_auth_signing_alg: "ES256",
    jwks_uri: `${url}/.well-known/jwks.json`,
    dpop_bound_access_tokens: true,
  };
}

/** Use the JWK's own `kid` when it has one; a mismatched kid breaks every login. */
export function atprotoKeyId(keyStr: string | undefined): string {
  try {
    const kid = (JSON.parse(keyStr ?? "") as { kid?: unknown }).kid;
    if (typeof kid === "string" && kid.length > 0) return kid;
  } catch {
    // PEM or malformed input: fall through to the default
  }
  return "key1";
}

/** Returns the public JWKS, served at `/.well-known/jwks.json`. Empty if no private key is configured. */
export async function getPublicJwks(): Promise<{ keys: unknown[] }> {
  const keyStr = config.atprotoPrivateKey;
  if (!keyStr) return { keys: [] };
  const key = await JoseKey.fromImportable(keyStr, atprotoKeyId(keyStr));
  const pub = key.publicJwk;
  return { keys: pub ? [pub] : [] };
}

/** Revoke and delete every stored OAuth session (the service keeps no account tokens). Best effort; rows are always deleted. */
export async function purgeStoredOAuthSessions(): Promise<number> {
  const rows = await db.select({ key: oauthSessions.key }).from(oauthSessions);
  if (rows.length === 0) return 0;
  const client = await getOAuthClient();
  for (const row of rows) {
    await client.revoke(row.key).catch(() => {});
    await db.delete(oauthSessions).where(eq(oauthSessions.key, row.key));
  }
  return rows.length;
}
