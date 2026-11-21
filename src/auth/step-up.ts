/**
 * @module auth/step-up
 * Step-up for sensitive actions (ADR-0035): a trusted-device session needs a recent device proof.
 */

import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import { logAudit } from "../audit/log.js";
import { STEP_UP_TTL_MS, deviceCookieMatches, deviceCookieName, readCookie } from "./device-trust.js";

/** Record a device proof made now, bound to the device cookie it showed. */
export function markDeviceProof(req: Request, deviceCookieHash: string | null): void {
  req.session.deviceVerifiedAt = Date.now();
  if (deviceCookieHash) req.session.deviceCookieHash = deviceCookieHash;
  else delete req.session.deviceCookieHash;
}

/**
 * True when the session's trusted device proved itself in the last few minutes
 * and this request carries the same device cookie.
 * Security: a copied session cookie alone cannot use the step-up window.
 */
export function deviceProofFresh(req: Request): boolean {
  const s = req.session;
  const at = s?.deviceVerifiedAt;
  if (!s?.trustedDeviceId || !at || Date.now() - at >= STEP_UP_TTL_MS) return false;
  const token = readCookie(req.headers?.cookie, deviceCookieName(config.publicUrl.startsWith("https")));
  return deviceCookieMatches(s.deviceCookieHash ?? null, token);
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
    refuseStepUp(req, res);
    return;
  }
  next();
}

/** Send the `step_up_required` answer and audit the refusal (no ids beyond the path). */
export function refuseStepUp(req: Request, res: Response): void {
  const userId = req.session?.userId;
  if (userId) {
    logAudit({
      tenantId: null,
      actorUserId: userId,
      action: "step_up_refused",
      metadata: { method: req.method, path: req.path },
    });
  }
  res.status(403).json({ error: "Confirm on this trusted device first", code: "step_up_required" });
}
