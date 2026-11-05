/**
 * @module auth/atproto
 * AT Protocol OAuth client setup using the BFF (backend-for-frontend) pattern.
 * The server acts as a confidential client: it holds the private key, performs
 * DPoP-bound token requests, and manages PKCE state -- the browser never sees tokens.
 * OAuth state and sessions are persisted to PostgreSQL via Drizzle-backed stores
 * so they survive server restarts.
 */
import { NodeOAuthClient } from "@atproto/oauth-client-node";
import type {
  NodeSavedState,
  NodeSavedSession,
} from "@atproto/oauth-client-node";
import { JoseKey } from "@atproto/jwk-jose";
import { eq } from "drizzle-orm";
import { config, isLoopbackDeployment } from "../config.js";
import { db } from "../db/index.js";
import { oauthStates, oauthSessions } from "../db/schema.js";

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

let clientInstance: NodeOAuthClient | null = null;

/**
 * Returns the singleton NodeOAuthClient, creating it on first call.
 * In dev (localhost) uses a loopback client_id with no keyset;
 * in production uses private_key_jwt auth with a JWK loaded from ATPROTO_PRIVATE_KEY.
 */
export async function getOAuthClient(): Promise<NodeOAuthClient> {
  if (clientInstance) return clientInstance;

  const url = config.publicUrl;
  const enc = encodeURIComponent;

  if (isLoopbackDeployment) {
    // Loopback clients must be redirected to an IP literal, never the name
    // "localhost" (RFC 8252 §7.3) — the OAuth client rejects it outright.
    const callback = new URL("/auth/callback", url);
    if (callback.hostname === "localhost") callback.hostname = "127.0.0.1";
    const redirectUri = callback.toString();

    clientInstance = new NodeOAuthClient({
      clientMetadata: {
        client_name: "atproto-tailnet (dev)",
        client_id: `http://localhost?redirect_uri=${enc(redirectUri)}&scope=${enc("atproto transition:generic")}`,
        client_uri: url,
        redirect_uris: [redirectUri],
        scope: "atproto transition:generic",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        application_type: "web",
        token_endpoint_auth_method: "none",
        dpop_bound_access_tokens: true,
      },
      stateStore: dbStateStore,
      sessionStore: dbSessionStore,
    });
  } else {
    const privateKey = await JoseKey.fromImportable(
      config.atprotoPrivateKey ?? "",
      "key1",
    );

    clientInstance = new NodeOAuthClient({
      clientMetadata: {
        client_name: "atproto-tailnet",
        client_id: `${url}/.well-known/atproto-client-metadata.json`,
        client_uri: url,
        redirect_uris: [`${url}/auth/callback`],
        scope: "atproto transition:generic",
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
    scope: "atproto transition:generic",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    application_type: "web",
    token_endpoint_auth_method: "private_key_jwt",
    token_endpoint_auth_signing_alg: "ES256",
    jwks_uri: `${url}/.well-known/jwks.json`,
    dpop_bound_access_tokens: true,
  };
}

/** Returns the public JWKS, served at `/.well-known/jwks.json`. Empty if no private key is configured. */
export async function getPublicJwks(): Promise<{ keys: unknown[] }> {
  const keyStr = config.atprotoPrivateKey;
  if (!keyStr) return { keys: [] };
  const key = await JoseKey.fromImportable(keyStr, "key1");
  const pub = key.publicJwk;
  return { keys: pub ? [pub] : [] };
}
