/** Dashboard sessions end after an absolute lifetime and after idling; sign-in records when it happened. */
import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../db/index.js", () => ({ db: {}, pool: {} }));

import {
  enforceSessionLifetime,
  establishSession,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SESSION_TOUCH_MS,
} from "../auth/session.js";

type Sess = Record<string, unknown> & { regenerate: (cb: (e?: unknown) => void) => void; save: (cb: (e?: unknown) => void) => void };

function fakeSession(data: Record<string, unknown>): { sess: Sess; regenerated: () => boolean } {
  let regenerated = false;
  const sess = {
    ...data,
    regenerate(cb: (e?: unknown) => void) {
      regenerated = true;
      for (const k of Object.keys(sess)) if (k !== "regenerate" && k !== "save") delete (sess as Record<string, unknown>)[k];
      cb();
    },
    save(cb: (e?: unknown) => void) {
      cb();
    },
  } as Sess;
  return { sess, regenerated: () => regenerated };
}

function run(data: Record<string, unknown>) {
  const { sess, regenerated } = fakeSession(data);
  const next = vi.fn();
  enforceSessionLifetime({ session: sess } as unknown as Request, {} as Response, next);
  return { sess, next, regenerated: regenerated() };
}

describe("session lifetime", () => {
  const now = Date.now();

  it("an active session inside both limits stays", () => {
    const r = run({ userId: "u", createdAt: now - 60_000, lastSeenAt: now - 60_000 });
    expect(r.regenerated).toBe(false);
    expect(r.next).toHaveBeenCalledWith();
    expect(r.sess.userId).toBe("u");
  });

  it("a session older than the absolute lifetime ends even when busy", () => {
    const r = run({ userId: "u", createdAt: now - SESSION_ABSOLUTE_MS - 1, lastSeenAt: now });
    expect(r.regenerated).toBe(true);
    expect(r.sess.userId).toBeUndefined();
    expect(r.next).toHaveBeenCalled();
  });

  it("an idle session ends", () => {
    const r = run({ userId: "u", createdAt: now - 2 * SESSION_IDLE_MS, lastSeenAt: now - SESSION_IDLE_MS - 1 });
    expect(r.regenerated).toBe(true);
    expect(r.sess.userId).toBeUndefined();
  });

  it("pending sessions are limited too, and sessions without a start time end", () => {
    expect(run({ pendingUserId: "u", createdAt: now - SESSION_ABSOLUTE_MS - 1, lastSeenAt: now }).regenerated).toBe(true);
    expect(run({ userId: "u" }).regenerated).toBe(true);
  });

  it("anonymous sessions are left alone", () => {
    expect(run({ oauthLoginNonces: ["n"] }).regenerated).toBe(false);
  });

  it("lastSeenAt moves forward at most every few minutes", () => {
    const fresh = run({ userId: "u", createdAt: now - 60_000, lastSeenAt: now - 60_000 });
    expect(fresh.sess.lastSeenAt).toBe(now - 60_000);
    const stale = run({ userId: "u", createdAt: now - SESSION_TOUCH_MS * 3, lastSeenAt: now - SESSION_TOUCH_MS - 1000 });
    expect(stale.sess.lastSeenAt as number).toBeGreaterThanOrEqual(now);
  });
});

describe("establishSession", () => {
  it("records the start and, for an AT Protocol sign-in only, authAt", async () => {
    const a = fakeSession({ oauthLoginNonces: ["n"] });
    await establishSession({ session: a.sess } as unknown as Request, { userId: "u", did: "did:plc:x", atprotoSignIn: true });
    expect(a.regenerated()).toBe(true);
    expect(a.sess).toMatchObject({ userId: "u", did: "did:plc:x" });
    expect(typeof a.sess.createdAt).toBe("number");
    expect(a.sess.lastSeenAt).toBe(a.sess.createdAt);
    expect(a.sess.authAt).toBe(a.sess.createdAt);
    expect(a.sess.oauthLoginNonces).toBeUndefined();

    const b = fakeSession({});
    await establishSession({ session: b.sess } as unknown as Request, {
      userId: "u",
      did: "did:plc:x",
      trustedDeviceId: "dev",
      deviceCookieHash: "h",
    });
    expect(b.sess.authAt).toBeUndefined();
    expect(b.sess).toMatchObject({ trustedDeviceId: "dev", deviceCookieHash: "h" });
    expect(typeof b.sess.deviceVerifiedAt).toBe("number");
  });
});
