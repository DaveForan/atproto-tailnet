/** Application fields of express-session's SessionData. */
import "express-session";

declare module "express-session" {
  interface SessionData {
    /** Internal user id. Only `establishSession` sets it. */
    userId?: string;
    did?: string;
    postLoginRedirect?: string;
    /** Session start and last request, in ms since epoch, for the absolute and idle lifetimes. */
    createdAt?: number;
    lastSeenAt?: number;
    /** Time of the AT Protocol sign-in for this session. Absent after a device-only sign-in. */
    authAt?: number;
    csrfToken?: string;
    /** Nonces sent as OAuth `state` at /auth/login. The callback must match one. */
    oauthLoginNonces?: string[];

    // Device-bound sign-in (ADR-0035)
    /** Identified by AT Protocol, but the device is not proven yet. It gives no access. */
    pendingUserId?: string;
    pendingDid?: string;
    /** Single-use challenge the browser signs with its device key. */
    deviceChallenge?: { value: string; issuedAt: number };
    proofAttempts?: number;
    trustRequestId?: string;
    /** Owner notice about this held sign-in. It is removed when the device proves itself. */
    pendingNoticeId?: string;
    trustedDeviceId?: string;
    /** Last device proof (sign-in or step-up), in ms since epoch. */
    deviceVerifiedAt?: number;
    /** Hash of the device cookie at that proof. Step-up needs the same cookie. */
    deviceCookieHash?: string;
    /** Set after a recovery-code sign-in. The browser must enrol before anything else. */
    mustEnrollDevice?: boolean;
  }
}
