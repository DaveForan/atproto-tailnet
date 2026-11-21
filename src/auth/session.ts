/**
 * @module auth/session
 * Dashboard sessions under the device lock (ADR-0035): signed-in and pending
 * sessions, ending other sessions, and the enrolment gate.
 */

import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { memberships, trustedDevices, notifications } from "../db/schema.js";
import { logger } from "../logger.js";
import { notifyUser } from "../notifications/service.js";
import { deviceProfile } from "./device-trust.js";
import { markDeviceProof } from "./step-up.js";

/** Number of trusted devices of a user (0 = the lock is off). */
export async function trustedDeviceCount(userId: string): Promise<number> {
  const rows = await db.select({ id: trustedDevices.id }).from(trustedDevices).where(eq(trustedDevices.userId, userId));
  return rows.length;
}

/** A session ends this long after sign-in, however active it is. */
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
/** A session ends after this long without a request. */
export const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
/** `lastSeenAt` is written at most this often, so most requests do not rewrite the session row. */
export const SESSION_TOUCH_MS = 5 * 60 * 1000;

/**
 * Replace the session with a signed-in one (new session id: no fixation).
 * `atprotoSignIn` marks a sign-in that the AT Protocol callback just completed.
 * `deviceCookieHash` is the stored hash of the device cookie this request proved.
 */
export function establishSession(
  req: Request,
  data: {
    userId: string;
    did: string;
    trustedDeviceId?: string;
    deviceCookieHash?: string | null;
    mustEnrollDevice?: boolean;
    atprotoSignIn?: boolean;
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      const now = Date.now();
      req.session.userId = data.userId;
      req.session.did = data.did;
      req.session.createdAt = now;
      req.session.lastSeenAt = now;
      if (data.atprotoSignIn) req.session.authAt = now;
      if (data.trustedDeviceId) {
        req.session.trustedDeviceId = data.trustedDeviceId;
        markDeviceProof(req, data.deviceCookieHash ?? null);
      }
      if (data.mustEnrollDevice) req.session.mustEnrollDevice = true;
      req.session.save((e) => (e ? reject(e) : resolve()));
    });
  });
}

/**
 * Ends sessions past the absolute or idle lifetime; the request goes on with an empty session.
 * Security: connect-pg-simple renews the store TTL on every request, so it never expires a busy session.
 * Sessions without `createdAt` predate these limits and end too.
 */
export function enforceSessionLifetime(req: Request, _res: Response, next: NextFunction): void {
  const s = req.session;
  if (!s || (!s.userId && !s.pendingUserId)) return next();
  const now = Date.now();
  const created = s.createdAt;
  const seen = s.lastSeenAt ?? created;
  if (!created || !seen || now - created > SESSION_ABSOLUTE_MS || now - seen > SESSION_IDLE_MS) {
    s.regenerate((err) => next(err));
    return;
  }
  if (now - seen > SESSION_TOUCH_MS) s.lastSeenAt = now;
  next();
}

/** Replace the session with a pending one: identified, device not yet proven. */
export function establishPendingSession(
  req: Request,
  data: { userId: string; did: string; redirect: string },
): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      const now = Date.now();
      req.session.pendingUserId = data.userId;
      req.session.pendingDid = data.did;
      req.session.createdAt = now;
      req.session.lastSeenAt = now;
      req.session.postLoginRedirect = data.redirect;
      // Every held sign-in notifies the owner. A trusted device clears the notice when it proves itself.
      // So only attempts from other devices stay visible.
      void noteSignInOnHold(req, data.userId)
        .then((id) => {
          if (id) req.session.pendingNoticeId = id;
        })
        .finally(() => req.session.save((e) => (e ? reject(e) : resolve())));
    });
  });
}

/** End every other dashboard session of a user (optionally only those of one device). */
export async function endOtherSessions(userId: string, keepSid: string, trustedDeviceId?: string): Promise<void> {
  try {
    if (trustedDeviceId) {
      await pool.query(`DELETE FROM "session" WHERE sess->>'userId' = $1 AND sess->>'trustedDeviceId' = $2`, [
        userId,
        trustedDeviceId,
      ]);
    } else {
      await pool.query(`DELETE FROM "session" WHERE sess->>'userId' = $1 AND sid <> $2`, [userId, keepSid]);
    }
  } catch (err) {
    logger.warn({ userId, err }, "failed to end other sessions");
  }
}

/** Write the "sign-in on hold" notification; returns its id (null when the user is in no tailnet). */
async function noteSignInOnHold(req: Request, userId: string): Promise<string | null> {
  try {
    const [m] = await db
      .select({ tenantId: memberships.tenantId })
      .from(memberships)
      .where(eq(memberships.userId, userId))
      .limit(1);
    if (!m) return null;
    const seen = deviceProfile(String(req.headers["user-agent"] ?? ""), null);
    const [row] = await db
      .insert(notifications)
      .values({
        tenantId: m.tenantId,
        userId,
        type: "device_trust",
        title: "A sign-in to your account was stopped at the device check",
        body: `${seen.browser} on ${seen.os}, address ${req.ip ?? "unknown"}. The correct account was used, but the device is not one of your trusted devices. If this was not you, change the password of your AT Protocol account.`,
        link: "/#account",
      })
      .returning({ id: notifications.id });
    return row?.id ?? null;
  } catch (err) {
    logger.warn({ userId, err }, "failed to record a sign-in on hold");
    return null;
  }
}

/** The device proved itself (or a recovery code was used): the notice is no longer true. */
export async function clearSignInNotice(req: Request): Promise<void> {
  const id = req.session.pendingNoticeId;
  if (!id) return;
  await db.delete(notifications).where(eq(notifications.id, id)).catch(() => undefined);
}

/** Tell the user, in one of their tailnets, about a security event. */
export async function alertUser(userId: string, title: string, body: string): Promise<void> {
  const [m] = await db
    .select({ tenantId: memberships.tenantId })
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .limit(1);
  if (m) notifyUser(m.tenantId, userId, "device_trust", { title, body, link: "/#account" });
}

/**
 * After a recovery-code sign-in the browser must enrol before anything else.
 * Mount after the session middleware.
 */
export function enforceDeviceEnrollment(req: Request, res: Response, next: NextFunction): void {
  // Lowercased: a route that matches case-insensitively must not skip the gate.
  const path = req.path.toLowerCase();
  if (!req.session.mustEnrollDevice || !path.startsWith("/api/")) return next();
  const allowed =
    path === "/api/me" ||
    path === "/api/csrf-token" ||
    path === "/api/permissions" ||
    path === "/api/tenants" ||
    path.startsWith("/api/trusted-devices") ||
    path.startsWith("/api/public/");
  if (allowed) return next();
  res.status(403).json({ error: "Add this device as a trusted device first", code: "enroll_required" });
}
