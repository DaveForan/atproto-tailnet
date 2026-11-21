/** Step-up for sensitive actions (ADR-0035): a session of a trusted device needs a recent proof. */
import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { deviceProofFresh, markDeviceProof, stepUpForSession, stepUpMissing } from "../auth/step-up.js";
import { STEP_UP_TTL_MS, deviceCookieName, hashDeviceCookie } from "../auth/device-trust.js";

const TOKEN = "device-cookie-token";
const HASH = hashDeviceCookie(TOKEN);
// Tests run with a loopback http PUBLIC_URL, so the cookie has no __Host- prefix.
const COOKIE = `${deviceCookieName(false)}=${TOKEN}`;
const req = (session?: Record<string, unknown>, cookie: string | undefined = COOKIE) =>
  ({ session, headers: cookie ? { cookie } : {} }) as unknown as Request;
function run(session?: Record<string, unknown>, cookie?: string) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  const next = vi.fn();
  stepUpForSession(req(session, cookie), res as unknown as Response, next);
  return { res, next };
}

describe("step-up", () => {
  it("a session of a trusted device with a recent proof passes", () => {
    const s = { userId: "u", trustedDeviceId: "d", deviceVerifiedAt: Date.now() - 60_000, deviceCookieHash: HASH };
    expect(deviceProofFresh(req(s))).toBe(true);
    expect(run(s).next).toHaveBeenCalled();
  });

  it("a copied session cookie without the device cookie cannot use a fresh proof", () => {
    const s = { userId: "u", trustedDeviceId: "d", deviceVerifiedAt: Date.now(), deviceCookieHash: HASH };
    expect(deviceProofFresh(req(s, ""))).toBe(false);
    expect(deviceProofFresh(req(s, `${deviceCookieName(false)}=another-token`))).toBe(false);
    expect(run(s, "unrelated=1").res.status).toHaveBeenCalledWith(403);
    // A proof recorded without a cookie hash never counts
    expect(deviceProofFresh(req({ userId: "u", trustedDeviceId: "d", deviceVerifiedAt: Date.now() }))).toBe(false);
  });

  it("markDeviceProof binds the proof to the cookie it saw", () => {
    const session: Record<string, unknown> = { userId: "u", trustedDeviceId: "d", deviceCookieHash: "old" };
    markDeviceProof(req(session), HASH);
    expect(session.deviceCookieHash).toBe(HASH);
    expect(deviceProofFresh(req(session))).toBe(true);
    markDeviceProof(req(session), null);
    expect(session.deviceCookieHash).toBeUndefined();
    expect(deviceProofFresh(req(session))).toBe(false);
  });

  it("an old proof, or none, is refused with step_up_required", () => {
    for (const s of [
      { userId: "u", trustedDeviceId: "d", deviceVerifiedAt: Date.now() - STEP_UP_TTL_MS - 1 },
      { userId: "u", trustedDeviceId: "d" },
    ]) {
      expect(stepUpMissing(req(s))).toBe(true);
      const { res, next } = run(s);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "step_up_required" }));
    }
  });

  it("a proof time without a trusted device does not count", () => {
    expect(deviceProofFresh(req({ userId: "u", deviceVerifiedAt: Date.now() }))).toBe(false);
  });

  it("a user without the lock, and token requests without a session, pass", () => {
    expect(run({ userId: "u" }).next).toHaveBeenCalled();
    expect(run({}).next).toHaveBeenCalled();
    expect(run(undefined).next).toHaveBeenCalled();
  });
});
