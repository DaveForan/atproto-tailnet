/**
 * Augments express-session's SessionData with application-specific fields.
 *
 * - `userId` — internal UUID set after AT Proto OAuth callback
 * - `did` — AT Protocol DID (e.g. `did:plc:...`) for the authenticated user
 * - `postLoginRedirect` — local path to redirect to after login (e.g. `/join/:slug`)
 */
import "express-session";

declare module "express-session" {
  interface SessionData {
    userId?: string;
    did?: string;
    postLoginRedirect?: string;
  }
}
