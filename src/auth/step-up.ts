/**
 * Step-up for sensitive actions (ADR-0035).
 *
 * A session that a trusted device made carries `trustedDeviceId`. For such a
 * session, a sensitive action needs a device proof from the last few minutes
 * (`deviceVerifiedAt`), so a stolen session cookie cannot perform it: the
 * thief has neither the device key nor the device cookie.
 *
 * A user with the lock on has no session without `trustedDeviceId` that can
 * use the API: turning the lock on ends all other sessions, and a
 * recovery-code session can only enrol. So no database lookup is needed here.
 */

import type { Request, Response, NextFunction } from "express";
import { STEP_UP_TTL_MS } from "./device-trust.js";

/** True when the session's trusted device proved itself in the last few minutes. */
export function deviceProofFresh(req: Request): boolean {
  const at = req.session?.deviceVerifiedAt;
  return !!req.session?.trustedDeviceId && !!at && Date.now() - at < STEP_UP_TTL_MS;
}

/** True when this request must show a fresh proof and does not have one. */
export function stepUpMissing(req: Request): boolean {
  return !!req.session?.userId && !!req.session.trustedDeviceId && !deviceProofFresh(req);
}

/**
 * Middleware for sensitive routes. Requests without a dashboard session
 * (agent tokens, MCP tokens) pass: they have their own limits, and making
 * them needs a step-up.
 */
export function stepUpForSession(req: Request, res: Response, next: NextFunction): void {
  if (stepUpMissing(req)) {
    res.status(403).json({ error: "Confirm on this trusted device first", code: "step_up_required" });
    return;
  }
  next();
}
