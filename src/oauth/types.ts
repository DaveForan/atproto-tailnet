/**
 * @module oauth/types
 * Request/session augmentations for MCP OAuth. `req.mcpAuth` acts AS THE USER and is never an agent token.
 * `session.mcpPendingAuthz` holds consent requests awaiting Allow/Deny.
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
  /** Whether the consent page may offer the operator checkbox (user is an operator). */
  operatorEligible?: boolean;
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
        /** The grant includes the instance-operator scope (consent checkbox). */
        operator: boolean;
      };
    }
  }
}

export {};
