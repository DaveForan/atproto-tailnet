import { NodeOAuthClient } from "@atproto/oauth-client-node";
import type { NodeSavedState, NodeSavedSession } from "@atproto/oauth-client-node";
import { JoseKey } from "@atproto/jwk-jose";
import { config } from "../config.js";

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

const stateStore = new Map<string, NodeSavedState>();
const sessionStore = new Map<string, NodeSavedSession>();

const memoryStateStore: StateStore = {
  async get(key) { return stateStore.get(key); },
  async set(key, val) { stateStore.set(key, val); },
  async del(key) { stateStore.delete(key); },
};

const memorySessionStore: SessionStore = {
  async get(key) { return sessionStore.get(key); },
  async set(key, val) { sessionStore.set(key, val); },
  async del(key) { sessionStore.delete(key); },
};

let clientInstance: NodeOAuthClient | null = null;

export async function getOAuthClient(): Promise<NodeOAuthClient> {
  if (clientInstance) return clientInstance;

  const url = config.publicUrl;
  const enc = encodeURIComponent;

  const isLocalhost =
    url.includes("://localhost") || url.includes("://127.0.0.1");

  if (isLocalhost) {
    clientInstance = new NodeOAuthClient({
      clientMetadata: {
        client_name: "atproto-tailnet (dev)",
        client_id: `http://localhost?redirect_uri=${enc(`${url}/auth/callback`)}&scope=${enc("atproto transition:generic")}`,
        client_uri: url,
        redirect_uris: [`${url}/auth/callback`],
        scope: "atproto transition:generic",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        application_type: "web",
        token_endpoint_auth_method: "none",
        dpop_bound_access_tokens: true,
      },
      stateStore: memoryStateStore,
      sessionStore: memorySessionStore,
    });
  } else {
    const privateKey = await JoseKey.fromImportable(
      process.env.ATPROTO_PRIVATE_KEY ?? "",
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
      stateStore: memoryStateStore,
      sessionStore: memorySessionStore,
    });
  }

  return clientInstance;
}
