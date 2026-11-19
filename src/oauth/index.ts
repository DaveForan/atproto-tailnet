/**
 * @module oauth
 * Process-wide MCP OAuth provider (DB-backed) and helpers used by the request
 * auth middleware (routes/helpers.ts), the /mcp endpoint and the connections API.
 */
import { config } from "../config.js";
import { DbOAuthStore } from "./store.js";
import { TailnetOAuthProvider } from "./provider.js";
import { isOperatorDid } from "../operator/policy.js";
import "./types.js";

/** The MCP endpoint URL — the resource (audience) every MCP token is bound to. */
export const MCP_RESOURCE_URL = new URL("/mcp", config.publicUrl).href;

export const oauthProvider = new TailnetOAuthProvider({
  store: new DbOAuthStore(),
  resourceUrl: MCP_RESOURCE_URL,
  // Lazy: avoids depending on module evaluation order (policy ↔ routes cycle).
  isOperatorDid: (did) => isOperatorDid(did),
});

export { MCP_TOKEN_PREFIX, isMcpToken, hashToken } from "./tokens.js";
