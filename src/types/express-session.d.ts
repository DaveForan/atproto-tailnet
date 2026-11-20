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
    csrfToken?: string;
    /** Nonces sent as OAuth `state` at /auth/login; the callback must match one. */
    oauthLoginNonces?: string[];

    // ── Device-bound sign-in (ADR-0035) ──
    /** Identified by AT Protocol, device not yet proven: no access yet. */
    pendingUserId?: string;
    pendingDid?: string;
    /** Single-use challenge the browser signs with its device key. */
    deviceChallenge?: { value: string; issuedAt: number };
    /** Failed proofs in this pending sign-in. */
    proofAttempts?: number;
    /** Open request of this browser to become trusted. */
    trustRequestId?: string;
    /** Notification that tells the owner about this sign-in on hold; removed when the device proves itself. */
    pendingNoticeId?: string;
    /** Trusted device that made this session. */
    trustedDeviceId?: string;
    /** Last time the device was proven (sign-in or step-up), ms since epoch. */
    deviceVerifiedAt?: number;
    /** Signed in with a recovery code: must enrol this browser before anything else. */
    mustEnrollDevice?: boolean;
  }
}
