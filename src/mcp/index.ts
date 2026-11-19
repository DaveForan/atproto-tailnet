/**
 * @module mcp
 * Process-wide routers for the remote MCP server and its OAuth endpoints,
 * mounted by src/index.ts.
 */
import { config } from "../config.js";
import { oauthProvider, MCP_RESOURCE_URL } from "../oauth/index.js";
import { createOAuthRouter, protectedResourceMetadataUrl } from "../oauth/router.js";
import { createMcpRouter } from "./server.js";

/** /.well-known OAuth metadata + /oauth/* (register, authorize, consent, token, revoke). */
export const oauthRouter = createOAuthRouter({ provider: oauthProvider, publicUrl: config.publicUrl });

/** /mcp Streamable HTTP endpoint (bearer-protected); tools call the REST API on loopback. */
export const mcpRouter = createMcpRouter({
  verifier: oauthProvider,
  resourceUrl: MCP_RESOURCE_URL,
  resourceMetadataUrl: protectedResourceMetadataUrl(config.publicUrl),
  apiBaseUrl: `http://127.0.0.1:${config.port}`,
});

export { isInternalMcpCall } from "./internal.js";
