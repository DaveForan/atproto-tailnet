/** Application fields of express-session's SessionData. */
import "express-session";

declare module "express-session" {
  interface SessionData {
    /** Internal user id; set only by `establishSession`. */
    userId?: string;
    did?: string;
    /** Local path to open after sign-in. */
    postLoginRedirect?: string;
    /** Session start and last request (ms since epoch) for the absolute and idle lifetimes. */
    createdAt?: number;
    lastSeenAt?: number;
    /** Time of the AT Protocol sign-in that made this session (absent after a device-only sign-in). */
    authAt?: number;
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
    /** Stored hash of the device cookie shown at that proof; step-up needs the same cookie. */
    deviceCookieHash?: string;
    /** Signed in with a recovery code: must enrol this browser before anything else. */
    mustEnrollDevice?: boolean;
  }
}
