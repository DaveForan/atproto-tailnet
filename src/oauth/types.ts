/**
 * @module oauth/types
 * Request/session augmentations for MCP OAuth.
 *
 * - `req.mcpAuth` — set by `resolveAgentToken` (routes/helpers.ts) when the
 *   request carries a valid MCP access token (`Authorization: Bearer mcp_…`).
 *   It authenticates the request AS THE USER; it is never an agent token, so
 *   `req.agentToken` stays unset.
 * - `session.mcpPendingAuthz` — consent requests awaiting Allow/Deny.
 */
import "express-session";

/** Authorization request parameters held between the consent page and its POST. */
export interface PendingAuthorization {
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource: string;
  /** ms since epoch */
  expiresAt: number;
}

declare module "express-session" {
  interface SessionData {
    mcpPendingAuthz?: Record<string, PendingAuthorization>;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Present when authenticated by an MCP OAuth access token. */
      mcpAuth?: {
        userId: string;
        clientId: string;
        grantId: string;
      };
    }
  }
}

export {};
