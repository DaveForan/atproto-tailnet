/**
 * @module routes/device-trust
 * Device-bound sign-in (ADR-0035).
 *
 * While a user has trusted devices, the AT Protocol sign-in only identifies
 * the account: the session stays *pending* until the browser proves a trusted
 * device by signing a challenge. Another browser is refused. It can ask to be
 * added, which a trusted device confirms with a short code, or the user can
 * use a recovery code.
 *
 * Changing the lock (devices, limit, recovery codes) needs a fresh proof from
 * the trusted device of the session ("step-up"), so a stolen session cookie
 * alone cannot remove the lock.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { users, memberships, trustedDevices, recoveryCodes, deviceTrustRequests, notifications } from "../db/schema.js";
import { requireSession, param } from "./helpers.js";
import { logger } from "../logger.js";
import { notifyUser } from "../notifications/service.js";
import {
  CHALLENGE_TTL_MS,
  MAX_PROOF_ATTEMPTS,
  MAX_TRUSTED_DEVICES_LIMIT,
  STEP_UP_TTL_MS,
  TRUST_REQUEST_TTL_MS,
  challengeUsable,
  cleanDeviceName,
  codesEqual,
  generatePairingCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  newChallenge,
  parseDevicePublicKey,
  verifyDeviceSignature,
  DEVICE_COOKIE_MAX_AGE_MS,
  deviceCookieName,
  deviceCookieMatches,
  deviceProfile,
  hashDeviceCookie,
  newDeviceCookieToken,
  profileChanges,
  readCookie,
} from "../auth/device-trust.js";
import { config } from "../config.js";
import { deviceProofFresh, stepUpMissing } from "../auth/step-up.js";

export const deviceTrustRouter = Router();

/** Number of trusted devices of a user (0 = the lock is off). */
export async function trustedDeviceCount(userId: string): Promise<number> {
  const rows = await db.select({ id: trustedDevices.id }).from(trustedDevices).where(eq(trustedDevices.userId, userId));
  return rows.length;
}

/** Replace the session with a signed-in one (new session id: no fixation). */
export function establishSession(
  req: Request,
  data: { userId: string; did: string; trustedDeviceId?: string; mustEnrollDevice?: boolean },
): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = data.userId;
      req.session.did = data.did;
      if (data.trustedDeviceId) {
        req.session.trustedDeviceId = data.trustedDeviceId;
        req.session.deviceVerifiedAt = Date.now();
      }
      if (data.mustEnrollDevice) req.session.mustEnrollDevice = true;
      req.session.save((e) => (e ? reject(e) : resolve()));
    });
  });
}

/** Replace the session with a pending one: identified, device not yet proven. */
export function establishPendingSession(
  req: Request,
  data: { userId: string; did: string; redirect: string },
): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.pendingUserId = data.userId;
      req.session.pendingDid = data.did;
      req.session.postLoginRedirect = data.redirect;
      // The owner is told about every sign-in that is on hold. A trusted
      // device removes the notice when it proves itself a moment later, so
      // only attempts from other devices stay visible.
      void noteSignInOnHold(req, data.userId)
        .then((id) => {
          if (id) req.session.pendingNoticeId = id;
        })
        .finally(() => req.session.save((e) => (e ? reject(e) : resolve())));
    });
  });
}

/** End every other dashboard session of a user (optionally only those of one device). */
async function endOtherSessions(userId: string, keepSid: string, trustedDeviceId?: string): Promise<void> {
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
async function clearSignInNotice(req: Request): Promise<void> {
  const id = req.session.pendingNoticeId;
  if (!id) return;
  await db.delete(notifications).where(eq(notifications.id, id)).catch(() => undefined);
}

/** Tell the user, in one of their tailnets, about a security event. */
async function alertUser(userId: string, title: string, body: string): Promise<void> {
  const [m] = await db
    .select({ tenantId: memberships.tenantId })
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .limit(1);
  if (m) notifyUser(m.tenantId, userId, "device_trust", { title, body, link: "/#account" });
}

// ── Device cookie and profile ───────────────────────────────────────────

const secureCookies = (): boolean => config.publicUrl.startsWith("https");

/**
 * Give this browser a new device cookie and return the hash to store. The
 * cookie is HttpOnly (page scripts cannot read it) and SameSite=Strict (it is
 * only ever needed by same-origin requests of the dashboard).
 */
function setDeviceCookie(res: Response): string {
  const token = newDeviceCookieToken();
  res.cookie(deviceCookieName(secureCookies()), token, {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "strict",
    path: "/",
    maxAge: DEVICE_COOKIE_MAX_AGE_MS,
  });
  return hashDeviceCookie(token);
}

function clearDeviceCookie(res: Response): void {
  res.clearCookie(deviceCookieName(secureCookies()), { httpOnly: true, secure: secureCookies(), sameSite: "strict", path: "/" });
}

/** True when the browser sent the device cookie that belongs to this trusted device. */
function hasDeviceCookie(req: Request, device: { cookieHash: string | null }): boolean {
  return deviceCookieMatches(device.cookieHash, readCookie(req.headers.cookie, deviceCookieName(secureCookies())));
}

function requestProfile(req: Request) {
  return deviceProfile(String(req.headers["user-agent"] ?? ""), (req.body ?? {}).profile);
}

/**
 * Compare the browser with the profile stored at enrolment. A difference
 * never refuses the sign-in (the key and the cookie decide); it is recorded
 * and the user is told, once, until they dismiss it.
 */
async function noteProfile(
  req: Request,
  device: { id: string; userId: string; name: string; profile: Record<string, string> | null; profileWarning: string | null },
): Promise<void> {
  const now = requestProfile(req);
  if (!device.profile) {
    await db.update(trustedDevices).set({ profile: now }).where(eq(trustedDevices.id, device.id));
    return;
  }
  const changes = profileChanges(device.profile, now);
  if (changes.length === 0 || device.profileWarning) return;
  await db
    .update(trustedDevices)
    .set({ profileWarning: changes.join("; "), profileWarningAt: new Date() })
    .where(eq(trustedDevices.id, device.id));
  void alertUser(
    device.userId,
    `"${device.name}" signed in from a browser that looks different`,
    `Changed: ${changes.join("; ")}. If this was not you, remove that device now: its key may have been copied.`,
  );
}

function issueChallenge(req: Request): string {
  const value = newChallenge();
  req.session.deviceChallenge = { value, issuedAt: Date.now() };
  return value;
}

/** The session's challenge, removed so that it cannot be used twice. */
function takeChallenge(req: Request): string | null {
  const c = req.session.deviceChallenge;
  delete req.session.deviceChallenge;
  return challengeUsable(c) ? c.value : null;
}

function requirePending(req: Request, res: Response): { userId: string; did: string } | null {
  const userId = req.session.pendingUserId;
  const did = req.session.pendingDid;
  if (!userId || !did || req.session.userId) {
    res.status(401).json({ error: "No sign-in is waiting for a device check" });
    return null;
  }
  if ((req.session.proofAttempts ?? 0) >= MAX_PROOF_ATTEMPTS) {
    req.session.destroy(() => {
      res.status(429).json({ error: "Too many attempts. Sign in again." });
    });
    return null;
  }
  return { userId, did };
}

// ── Pending sign-in: prove a trusted device ─────────────────────────────

deviceTrustRouter.get("/api/device-trust/pending", async (req, res) => {
  const pending = requirePending(req, res);
  if (!pending) return;
  const [user] = await db.select({ handle: users.handle }).from(users).where(eq(users.id, pending.userId));
  res.json({ handle: user?.handle ?? null, challenge: issueChallenge(req), validForMs: CHALLENGE_TTL_MS });
});

deviceTrustRouter.post("/api/device-trust/pending/verify", async (req, res) => {
  const pending = requirePending(req, res);
  if (!pending) return;
  const challenge = takeChallenge(req);
  const { deviceId, signature } = (req.body ?? {}) as { deviceId?: unknown; signature?: unknown };
  const [device] =
    typeof deviceId === "string" && /^[0-9a-f-]{36}$/i.test(deviceId)
      ? await db
          .select()
          .from(trustedDevices)
          .where(and(eq(trustedDevices.id, deviceId), eq(trustedDevices.userId, pending.userId)))
      : [];
  // Two proofs: the signature of the device key, and the device cookie
  if (
    !challenge ||
    !device ||
    !verifyDeviceSignature(device.publicKeyJwk, challenge, signature) ||
    !hasDeviceCookie(req, device)
  ) {
    req.session.proofAttempts = (req.session.proofAttempts ?? 0) + 1;
    res.status(403).json({ error: "This device could not be verified", code: "device_not_trusted" });
    return;
  }
  const redirect = req.session.postLoginRedirect || "/";
  await db.update(trustedDevices).set({ lastUsedAt: new Date() }).where(eq(trustedDevices.id, device.id));
  await noteProfile(req, device);
  await clearSignInNotice(req);
  await establishSession(req, { userId: pending.userId, did: pending.did, trustedDeviceId: device.id });
  res.json({ status: "signed_in", redirect });
});

/** A recovery code replaces the device proof once; the browser must then enrol. */
deviceTrustRouter.post("/api/device-trust/pending/recover", async (req, res) => {
  const pending = requirePending(req, res);
  if (!pending) return;
  const code = (req.body ?? {}).code;
  const hash = typeof code === "string" && code.length <= 64 ? hashRecoveryCode(code) : null;
  const used = hash
    ? await db
        .update(recoveryCodes)
        .set({ usedAt: new Date() })
        .where(and(eq(recoveryCodes.userId, pending.userId), eq(recoveryCodes.codeHash, hash), isNull(recoveryCodes.usedAt)))
        .returning({ id: recoveryCodes.id })
    : [];
  if (used.length === 0) {
    req.session.proofAttempts = (req.session.proofAttempts ?? 0) + 1;
    res.status(403).json({ error: "That recovery code is not valid" });
    return;
  }
  const redirect = req.session.postLoginRedirect || "/";
  // The recovery alert below replaces the notice
  await clearSignInNotice(req);
  await establishSession(req, { userId: pending.userId, did: pending.did, mustEnrollDevice: true });
  void alertUser(pending.userId, "A recovery code was used to sign in", "If this was not you, remove the new device and make new recovery codes.");
  res.json({ status: "signed_in", redirect });
});

/** This browser asks to become trusted; a trusted device must confirm the code. */
deviceTrustRouter.post("/api/device-trust/pending/request", async (req, res) => {
  const pending = requirePending(req, res);
  if (!pending) return;
  const name = cleanDeviceName((req.body ?? {}).name);
  const jwk = parseDevicePublicKey((req.body ?? {}).publicKeyJwk);
  if (!name || !jwk) {
    res.status(400).json({ error: "A device name and a P-256 public key are required" });
    return;
  }
  // One open request per pending sign-in
  if (req.session.trustRequestId) {
    await db.delete(deviceTrustRequests).where(eq(deviceTrustRequests.id, req.session.trustRequestId));
  }
  const open = await db
    .select({ id: deviceTrustRequests.id })
    .from(deviceTrustRequests)
    .where(
      and(
        eq(deviceTrustRequests.userId, pending.userId),
        eq(deviceTrustRequests.status, "pending"),
        gt(deviceTrustRequests.expiresAt, new Date()),
      ),
    );
  if (open.length >= 5) {
    res.status(429).json({ error: "Too many devices are waiting for approval" });
    return;
  }
  const code = generatePairingCode();
  const [row] = await db
    .insert(deviceTrustRequests)
    .values({
      userId: pending.userId,
      name,
      publicKeyJwk: jwk,
      userAgent: String(req.headers["user-agent"] ?? "").slice(0, 300) || null,
      cookieHash: setDeviceCookie(res),
      profile: requestProfile(req),
      code,
      expiresAt: new Date(Date.now() + TRUST_REQUEST_TTL_MS),
    })
    .returning();
  req.session.trustRequestId = row.id;
  void alertUser(
    pending.userId,
    "A new device wants to sign in",
    `"${name}" signed in to your account and asks to be trusted. Approve it only if this is you.`,
  );
  res.status(201).json({ id: row.id, code, expiresAt: row.expiresAt });
});

deviceTrustRouter.get("/api/device-trust/pending/request", async (req, res) => {
  const pending = requirePending(req, res);
  if (!pending) return;
  const id = req.session.trustRequestId;
  const [row] = id
    ? await db
        .select()
        .from(deviceTrustRequests)
        .where(and(eq(deviceTrustRequests.id, id), eq(deviceTrustRequests.userId, pending.userId)))
    : [];
  if (!row) {
    res.status(404).json({ error: "No request" });
    return;
  }
  const expired = row.status === "pending" && row.expiresAt.getTime() <= Date.now();
  // When approved, the trusted device has the id of the request
  res.json({ status: expired ? "expired" : row.status, deviceId: row.status === "approved" ? row.id : null });
});

// ── Signed in: manage trusted devices ───────────────────────────────────

/**
 * After a recovery-code sign-in the browser must enrol before anything else.
 * Mount after the session middleware.
 */
export function enforceDeviceEnrollment(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.mustEnrollDevice || !req.path.startsWith("/api/")) return next();
  const allowed =
    req.path === "/api/me" ||
    req.path === "/api/csrf-token" ||
    req.path === "/api/permissions" ||
    req.path === "/api/tenants" ||
    req.path.startsWith("/api/trusted-devices") ||
    req.path.startsWith("/api/public/");
  if (allowed) return next();
  res.status(403).json({ error: "Add this device as a trusted device first", code: "enroll_required" });
}

const stepUpFresh = deviceProofFresh;

/**
 * True when the request may change the lock: no lock yet, or a fresh device
 * proof. Same freshness rule as `stepUpForSession` (`deviceProofFresh`,
 * `STEP_UP_TTL_MS`); in addition, a session without a trusted device (a
 * recovery-code session, or one whose device was removed) is refused while the
 * user still has trusted devices, which needs one database lookup.
 */
async function mayChangeLock(req: Request, res: Response): Promise<boolean> {
  if (stepUpFresh(req)) return true;
  if (!stepUpMissing(req) && (await trustedDeviceCount(req.session.userId!)) === 0) return true;
  res.status(403).json({ error: "Confirm on this trusted device first", code: "step_up_required" });
  return false;
}

/**
 * Gate for other sensitive changes of the signed-in user (for example the
 * machine lock): with trusted devices, a fresh proof is required. Sends the
 * `step_up_required` response and returns false when it is missing.
 */
export const requireFreshDeviceProof = mayChangeLock;

deviceTrustRouter.get("/api/trusted-devices", requireSession, async (req, res) => {
  const userId = req.session.userId!;
  const [user] = await db.select({ max: users.maxTrustedDevices }).from(users).where(eq(users.id, userId));
  const devices = await db
    .select()
    .from(trustedDevices)
    .where(eq(trustedDevices.userId, userId))
    .orderBy(trustedDevices.createdAt);
  const codes = await db
    .select({ id: recoveryCodes.id })
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)));
  const requests = await db
    .select()
    .from(deviceTrustRequests)
    .where(
      and(
        eq(deviceTrustRequests.userId, userId),
        eq(deviceTrustRequests.status, "pending"),
        gt(deviceTrustRequests.expiresAt, new Date()),
      ),
    );
  res.json({
    locked: devices.length > 0,
    max: user?.max ?? 3,
    currentDeviceId: req.session.trustedDeviceId ?? null,
    mustEnroll: Boolean(req.session.mustEnrollDevice),
    stepUpFresh: stepUpFresh(req),
    recoveryCodesLeft: codes.length,
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      userAgent: d.userAgent,
      profile: d.profile ? { os: d.profile.os ?? null, browser: d.profile.browser ?? null } : null,
      warning: d.profileWarning,
      warningAt: d.profileWarningAt,
      createdAt: d.createdAt,
      lastUsedAt: d.lastUsedAt,
    })),
    // The code is never sent here: the user reads it on the new device
    requests: requests.map((r) => ({ id: r.id, name: r.name, userAgent: r.userAgent, createdAt: r.createdAt })),
  });
});

deviceTrustRouter.post("/api/trusted-devices/challenge", requireSession, (req, res) => {
  res.json({ challenge: issueChallenge(req) });
});

/**
 * Trust this browser. Allowed for the first device (which turns the lock on)
 * and after a recovery-code sign-in. Any other new device joins through a
 * request that a trusted device approves.
 */
deviceTrustRouter.post("/api/trusted-devices", requireSession, async (req, res) => {
  const userId = req.session.userId!;
  const challenge = takeChallenge(req);
  const name = cleanDeviceName((req.body ?? {}).name);
  const jwk = parseDevicePublicKey((req.body ?? {}).publicKeyJwk);
  if (!name || !jwk || !challenge || !verifyDeviceSignature(jwk, challenge, (req.body ?? {}).signature)) {
    res.status(400).json({ error: "A device name, a P-256 public key and a signature of the challenge are required" });
    return;
  }
  const count = await trustedDeviceCount(userId);
  if (count > 0 && !req.session.mustEnrollDevice) {
    res.status(403).json({ error: "Sign in on the new device and approve it from a trusted device", code: "use_request" });
    return;
  }
  const [user] = await db.select({ max: users.maxTrustedDevices }).from(users).where(eq(users.id, userId));
  if (count >= (user?.max ?? 3)) {
    res.status(409).json({ error: "You reached your limit of trusted devices. Remove one first", code: "device_limit" });
    return;
  }
  const [device] = await db
    .insert(trustedDevices)
    .values({
      userId,
      name,
      publicKeyJwk: jwk,
      userAgent: String(req.headers["user-agent"] ?? "").slice(0, 300) || null,
      cookieHash: setDeviceCookie(res),
      profile: requestProfile(req),
      lastUsedAt: new Date(),
    })
    .returning();

  let codes: string[] | undefined;
  if (count === 0) {
    // The lock turns on: recovery codes are shown once, and every other
    // session of the account ends (they were made without a device proof).
    codes = generateRecoveryCodes();
    await db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
    await db.insert(recoveryCodes).values(codes.map((c) => ({ userId, codeHash: hashRecoveryCode(c) })));
    await endOtherSessions(userId, req.sessionID);
  }
  req.session.trustedDeviceId = device.id;
  req.session.deviceVerifiedAt = Date.now();
  delete req.session.mustEnrollDevice;
  res.status(201).json({ id: device.id, name: device.name, recoveryCodes: codes });
});

/** Prove the session's trusted device again before a sensitive change. */
deviceTrustRouter.post("/api/trusted-devices/step-up", requireSession, async (req, res) => {
  const challenge = takeChallenge(req);
  const deviceId = req.session.trustedDeviceId;
  const [device] = deviceId
    ? await db
        .select()
        .from(trustedDevices)
        .where(and(eq(trustedDevices.id, deviceId), eq(trustedDevices.userId, req.session.userId!)))
    : [];
  if (
    !challenge ||
    !device ||
    !verifyDeviceSignature(device.publicKeyJwk, challenge, (req.body ?? {}).signature) ||
    !hasDeviceCookie(req, device)
  ) {
    res.status(403).json({ error: "This device could not be verified", code: "device_not_trusted" });
    return;
  }
  req.session.deviceVerifiedAt = Date.now();
  res.json({ status: "verified", validForMs: STEP_UP_TTL_MS });
});

deviceTrustRouter.delete("/api/trusted-devices/:id", requireSession, async (req, res) => {
  if (!(await mayChangeLock(req, res))) return;
  const userId = req.session.userId!;
  const id = param(req, "id");
  const removed = await db
    .delete(trustedDevices)
    .where(and(eq(trustedDevices.id, id), eq(trustedDevices.userId, userId)))
    .returning({ id: trustedDevices.id });
  if (removed.length === 0) {
    res.status(404).json({ error: "Device not found" });
    return;
  }
  await endOtherSessions(userId, req.sessionID, id);
  const left = await trustedDeviceCount(userId);
  if (left === 0) {
    // No trusted device is left: the lock is off, and old codes must not linger
    await db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
  }
  if (req.session.trustedDeviceId === id) {
    delete req.session.deviceVerifiedAt;
    clearDeviceCookie(res);
    // While other trusted devices remain, this browser is no longer trusted:
    // keep the (now removed) device id so every sensitive action needs a
    // step-up that can never succeed here. Only with the lock off is the
    // session an ordinary one again.
    if (left === 0) delete req.session.trustedDeviceId;
  }
  res.json({ status: "removed", locked: left > 0 });
});

/**
 * "This was me": clear a profile warning. The profile is learned again at the
 * next sign-in of that device.
 */
deviceTrustRouter.post("/api/trusted-devices/:id/dismiss-warning", requireSession, async (req, res) => {
  if (!(await mayChangeLock(req, res))) return;
  const done = await db
    .update(trustedDevices)
    .set({ profileWarning: null, profileWarningAt: null, profile: null })
    .where(and(eq(trustedDevices.id, param(req, "id")), eq(trustedDevices.userId, req.session.userId!)))
    .returning({ id: trustedDevices.id });
  if (done.length === 0) {
    res.status(404).json({ error: "Device not found" });
    return;
  }
  res.json({ status: "dismissed" });
});

deviceTrustRouter.put("/api/trusted-devices/limit", requireSession, async (req, res) => {
  if (!(await mayChangeLock(req, res))) return;
  const userId = req.session.userId!;
  const max = (req.body ?? {}).max;
  if (!Number.isInteger(max) || max < 1 || max > MAX_TRUSTED_DEVICES_LIMIT) {
    res.status(400).json({ error: `The limit must be 1 to ${MAX_TRUSTED_DEVICES_LIMIT}` });
    return;
  }
  if (max < (await trustedDeviceCount(userId))) {
    res.status(409).json({ error: "Remove devices first: you have more than that limit" });
    return;
  }
  await db.update(users).set({ maxTrustedDevices: max, updatedAt: new Date() }).where(eq(users.id, userId));
  res.json({ max });
});

/** Approve a new device: the user types the code that the new device shows. */
deviceTrustRouter.post("/api/trusted-devices/requests/:id/approve", requireSession, async (req, res) => {
  const userId = req.session.userId!;
  if (!stepUpFresh(req)) {
    res.status(403).json({ error: "Confirm on this trusted device first", code: "step_up_required" });
    return;
  }
  const [request] = await db
    .select()
    .from(deviceTrustRequests)
    .where(and(eq(deviceTrustRequests.id, param(req, "id")), eq(deviceTrustRequests.userId, userId)));
  if (!request || request.status !== "pending" || request.expiresAt.getTime() <= Date.now()) {
    res.status(404).json({ error: "Request not found or expired" });
    return;
  }
  const code = (req.body ?? {}).code;
  if (typeof code !== "string" || !codesEqual(code, request.code)) {
    // A wrong code ends the request: the code cannot be guessed by retrying
    await db.update(deviceTrustRequests).set({ status: "denied" }).where(eq(deviceTrustRequests.id, request.id));
    res.status(403).json({ error: "The code does not match. Start again on the new device" });
    return;
  }
  const [user] = await db.select({ max: users.maxTrustedDevices }).from(users).where(eq(users.id, userId));
  if ((await trustedDeviceCount(userId)) >= (user?.max ?? 3)) {
    res.status(409).json({ error: "You reached your limit of trusted devices. Remove one first", code: "device_limit" });
    return;
  }
  await db.insert(trustedDevices).values({
    id: request.id,
    userId,
    name: request.name,
    publicKeyJwk: request.publicKeyJwk,
    userAgent: request.userAgent,
    cookieHash: request.cookieHash,
    profile: request.profile,
  });
  await db.update(deviceTrustRequests).set({ status: "approved" }).where(eq(deviceTrustRequests.id, request.id));
  res.json({ status: "approved", deviceId: request.id });
});

deviceTrustRouter.post("/api/trusted-devices/requests/:id/deny", requireSession, async (req, res) => {
  await db
    .update(deviceTrustRequests)
    .set({ status: "denied" })
    .where(
      and(
        eq(deviceTrustRequests.id, param(req, "id")),
        eq(deviceTrustRequests.userId, req.session.userId!),
        eq(deviceTrustRequests.status, "pending"),
      ),
    );
  res.json({ status: "denied" });
});

deviceTrustRouter.post("/api/trusted-devices/recovery-codes", requireSession, async (req, res) => {
  const userId = req.session.userId!;
  if (!stepUpFresh(req)) {
    res.status(403).json({ error: "Confirm on this trusted device first", code: "step_up_required" });
    return;
  }
  const codes = generateRecoveryCodes();
  await db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
  await db.insert(recoveryCodes).values(codes.map((c) => ({ userId, codeHash: hashRecoveryCode(c) })));
  res.json({ recoveryCodes: codes });
});
