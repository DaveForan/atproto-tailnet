/**
 * Device-bound sign-in routes (ADR-0035): a pending session has no access
 * until a trusted device signs the challenge; changing the lock needs a fresh
 * proof; recovery codes work once and force enrolment.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync, sign } from "node:crypto";

const { results, writes, chain, tableName, poolQuery } = vi.hoisted(() => {
  const results: unknown[] = [];
  const writes: Array<{ op: string; table?: string; arg: unknown }> = [];
  function tableName(t: unknown): string | undefined {
    if (!t || typeof t !== "object") return undefined;
    const sym = Object.getOwnPropertySymbols(t).find((s) => s.description === "drizzle:Name");
    return sym ? (t as Record<symbol, string>)[sym] : undefined;
  }
  function chain(op: string, table?: string): unknown {
    let tbl = table;
    if (op === "delete") writes.push({ op, table: tbl, arg: null });
    const proxy: unknown = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === "then") {
          const next = results.length ? results.shift() : [];
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(next).then(res, rej);
        }
        if (prop === "catch") return () => proxy;
        return (...args: unknown[]) => {
          if (prop === "from") tbl = tableName(args[0]);
          if (prop === "set" || prop === "values") writes.push({ op, table: tbl, arg: args[0] });
          return proxy;
        };
      },
    });
    return proxy;
  }
  return { results, writes, chain, tableName, poolQuery: vi.fn(async () => ({ rowCount: 0 })) };
});

vi.mock("../db/index.js", () => ({
  db: {
    select: () => chain("select"),
    insert: (t: unknown) => chain("insert", tableName(t)),
    update: (t: unknown) => chain("update", tableName(t)),
    delete: (t: unknown) => chain("delete", tableName(t)),
  },
  pool: { query: poolQuery },
}));
vi.mock("../notifications/service.js", () => ({ notifyUser: vi.fn() }));

import express from "express";
import type { Request, Response, NextFunction } from "express";
import { deviceTrustRouter, enforceDeviceEnrollment } from "../routes/device-trust.js";
import { hashDeviceCookie } from "../auth/device-trust.js";

const MAC_SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const WIN_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const COOKIE = "tailnet-device";
const TOKEN = "device-cookie-token";
/** A trusted-device row whose device cookie is TOKEN. */
const row = (jwk: unknown, extra: Record<string, unknown> = {}) => ({
  id: DEV,
  userId: "u-1",
  name: "Mac",
  publicKeyJwk: jwk,
  cookieHash: hashDeviceCookie(TOKEN),
  profile: null,
  profileWarning: null,
  ...extra,
});

function device() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { kty: string; crv: string; x: string; y: string };
  return {
    jwk,
    signIt: (msg: string) => sign("sha256", Buffer.from(msg), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url"),
  };
}

// One in-memory session shared by the requests of a test
type Sess = Record<string, unknown>;
let session: Sess = {};
let destroyed = false;
const app = express();
app.use(express.json());
app.use((req: Request, _res: Response, next: NextFunction) => {
  const s = session as Sess & {
    regenerate: (cb: (e?: unknown) => void) => void;
    save: (cb: (e?: unknown) => void) => void;
    destroy: (cb: () => void) => void;
  };
  s.regenerate = (cb) => {
    for (const k of Object.keys(session)) if (!["regenerate", "save", "destroy"].includes(k)) delete session[k];
    cb();
  };
  s.save = (cb) => cb();
  s.destroy = (cb) => {
    destroyed = true;
    cb();
  };
  (req as unknown as { session: Sess; sessionID: string }).session = s;
  (req as unknown as { sessionID: string }).sessionID = "sid-1";
  next();
});
app.use(enforceDeviceEnrollment);
app.use(deviceTrustRouter);
app.get("/api/tenants/x/devices", (_req, res) => res.json({ ok: true }));
const server = app.listen(0);
afterAll(() => server.close());

// The browser's cookies: `cookieJar` is sent, and Set-Cookie replies update it
let cookieJar: Record<string, string> = {};
let userAgent = MAC_SAFARI;
async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "user-agent": userAgent,
      cookie: Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join("; "),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  for (const c of r.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    if (pair.slice(eq + 1)) cookieJar[pair.slice(0, eq)] = pair.slice(eq + 1);
    else delete cookieJar[pair.slice(0, eq)];
  }
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
}

const DEV = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
beforeEach(() => {
  results.length = 0;
  writes.length = 0;
  session = {};
  cookieJar = { [COOKIE]: TOKEN };
  userAgent = MAC_SAFARI;
  destroyed = false;
  vi.clearAllMocks();
});

describe("pending sign-in", () => {
  it("has no challenge without a pending session, and none for a signed-in one", async () => {
    expect((await call("GET", "/api/device-trust/pending")).status).toBe(401);
    session = { userId: "u-1", pendingUserId: "u-1", pendingDid: "did:plc:x" };
    expect((await call("GET", "/api/device-trust/pending")).status).toBe(401);
  });

  it("a trusted device signs the challenge and the session becomes signed in", async () => {
    const d = device();
    session = { pendingUserId: "u-1", pendingDid: "did:plc:x", postLoginRedirect: "/invite/abc" };
    results.push([{ handle: "dave.test" }]);
    const { json } = await call("GET", "/api/device-trust/pending");
    results.push([row(d.jwk)]);
    const r = await call("POST", "/api/device-trust/pending/verify", { deviceId: DEV, signature: d.signIt(json.challenge) });
    expect(r.status).toBe(200);
    expect(r.json.redirect).toBe("/invite/abc");
    expect(session).toMatchObject({ userId: "u-1", did: "did:plc:x", trustedDeviceId: DEV });
    expect(session.pendingUserId).toBeUndefined();
  });

  it("another key, an unknown device or a replayed challenge is refused", async () => {
    const trusted = device();
    const attacker = device();
    session = { pendingUserId: "u-1", pendingDid: "did:plc:x" };
    results.push([{ handle: "h" }]);
    const { json } = await call("GET", "/api/device-trust/pending");

    // The attacker signs with their own key
    results.push([row(trusted.jwk)]);
    const bad = await call("POST", "/api/device-trust/pending/verify", { deviceId: DEV, signature: attacker.signIt(json.challenge) });
    expect(bad.status).toBe(403);
    expect(session.userId).toBeUndefined();

    // The challenge was consumed: even the right key cannot reuse it
    results.push([row(trusted.jwk)]);
    const replay = await call("POST", "/api/device-trust/pending/verify", { deviceId: DEV, signature: trusted.signIt(json.challenge) });
    expect(replay.status).toBe(403);

    // A device id of another user finds nothing
    results.push([{ handle: "h" }]);
    const again = await call("GET", "/api/device-trust/pending");
    results.push([]);
    expect((await call("POST", "/api/device-trust/pending/verify", { deviceId: DEV, signature: trusted.signIt(again.json.challenge) })).status).toBe(403);
    expect(session.userId).toBeUndefined();
  });

  it("too many failed proofs end the pending sign-in", async () => {
    session = { pendingUserId: "u-1", pendingDid: "did:plc:x", proofAttempts: 5 };
    expect((await call("POST", "/api/device-trust/pending/recover", { code: "AAAAA-AAAAA" })).status).toBe(429);
    expect(destroyed).toBe(true);
  });

  it("a recovery code signs in once and forces enrolment", async () => {
    session = { pendingUserId: "u-1", pendingDid: "did:plc:x" };
    results.push([{ id: "code-1" }]); // update ... returning: one unused code matched
    const r = await call("POST", "/api/device-trust/pending/recover", { code: "abcde fghjk" });
    expect(r.status).toBe(200);
    expect(session).toMatchObject({ userId: "u-1", mustEnrollDevice: true });
    expect(session.trustedDeviceId).toBeUndefined();

    // Until the browser enrols, the rest of the API is closed
    expect((await call("GET", "/api/tenants/x/devices")).json.code).toBe("enroll_required");
  });

  it("a wrong recovery code is refused and counted", async () => {
    session = { pendingUserId: "u-1", pendingDid: "did:plc:x" };
    results.push([]);
    expect((await call("POST", "/api/device-trust/pending/recover", { code: "nope" })).status).toBe(403);
    expect(session.proofAttempts).toBe(1);
    expect(session.userId).toBeUndefined();
  });

  it("a new device asks to be trusted and gets a code to show", async () => {
    const d = device();
    session = { pendingUserId: "u-1", pendingDid: "did:plc:x" };
    results.push([], [{ id: "req-1", expiresAt: new Date(Date.now() + 60_000) }]);
    const r = await call("POST", "/api/device-trust/pending/request", { name: "New phone", publicKeyJwk: { ...d.jwk, d: "leak" } });
    expect(r.status).toBe(201);
    expect(r.json.code).toMatch(/^[A-Z2-9]{6}$/);
    const insert = writes.find((w) => w.op === "insert" && w.table === "device_trust_requests")!.arg as Record<string, any>;
    expect(insert.publicKeyJwk).toEqual(d.jwk); // no private member is stored
  });
});

describe("managing trusted devices", () => {
  const signedIn = (extra: Sess = {}) => ({ userId: "u-1", did: "did:plc:x", ...extra });

  it("the first device turns the lock on, returns recovery codes once and ends other sessions", async () => {
    const d = device();
    session = signedIn();
    const { json } = await call("POST", "/api/trusted-devices/challenge");
    results.push([], [{ max: 3 }], [{ id: DEV, name: "Mac" }]);
    const r = await call("POST", "/api/trusted-devices", { name: "Mac", publicKeyJwk: d.jwk, signature: d.signIt(json.challenge) });
    expect(r.status).toBe(201);
    expect(r.json.recoveryCodes).toHaveLength(8);
    expect(session.trustedDeviceId).toBe(DEV);
    expect(poolQuery).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM "session"'), ["u-1", "sid-1"]);
    const stored = writes.find((w) => w.op === "insert" && w.table === "recovery_codes")!.arg as Array<Record<string, string>>;
    expect(stored.every((c) => /^[0-9a-f]{64}$/.test(c.codeHash))).toBe(true); // hashes only
  });

  it("enrolment needs a signature by the key being enrolled", async () => {
    const d = device();
    const other = device();
    session = signedIn();
    const { json } = await call("POST", "/api/trusted-devices/challenge");
    const r = await call("POST", "/api/trusted-devices", { name: "Mac", publicKeyJwk: d.jwk, signature: other.signIt(json.challenge) });
    expect(r.status).toBe(400);
  });

  it("with the lock on, a session cannot simply add another device", async () => {
    const d = device();
    session = signedIn({ trustedDeviceId: DEV, deviceVerifiedAt: Date.now() });
    const { json } = await call("POST", "/api/trusted-devices/challenge");
    results.push([{ id: DEV }]);
    const r = await call("POST", "/api/trusted-devices", { name: "X", publicKeyJwk: d.jwk, signature: d.signIt(json.challenge) });
    expect(r.json.code).toBe("use_request");
  });

  it("the device limit is enforced", async () => {
    const d = device();
    session = signedIn({ mustEnrollDevice: true });
    const { json } = await call("POST", "/api/trusted-devices/challenge");
    results.push([{ id: "a" }, { id: "b" }], [{ max: 2 }]);
    const r = await call("POST", "/api/trusted-devices", { name: "X", publicKeyJwk: d.jwk, signature: d.signIt(json.challenge) });
    expect(r.json.code).toBe("device_limit");
  });

  it("removing a device needs a fresh proof when the lock is on", async () => {
    session = signedIn({ trustedDeviceId: DEV, deviceVerifiedAt: Date.now() - 10 * 60_000 });
    results.push([{ id: DEV }]);
    expect((await call("DELETE", `/api/trusted-devices/${DEV}`)).json.code).toBe("step_up_required");
    expect(writes.some((w) => w.op === "delete" && w.table === "trusted_devices")).toBe(false);
  });

  it("a stolen session without the device key cannot step up", async () => {
    const trusted = device();
    const thief = device();
    session = signedIn({ trustedDeviceId: DEV });
    const { json } = await call("POST", "/api/trusted-devices/challenge");
    results.push([row(trusted.jwk)]);
    expect((await call("POST", "/api/trusted-devices/step-up", { signature: thief.signIt(json.challenge) })).status).toBe(403);
    expect(session.deviceVerifiedAt).toBeUndefined();
  });

  it("step-up with the device key allows the change; removing the last device turns the lock off", async () => {
    const d = device();
    session = signedIn({ trustedDeviceId: DEV });
    const { json } = await call("POST", "/api/trusted-devices/challenge");
    results.push([row(d.jwk)]);
    expect((await call("POST", "/api/trusted-devices/step-up", { signature: d.signIt(json.challenge) })).status).toBe(200);

    results.push([{ id: DEV }], []); // delete returning; none left
    const r = await call("DELETE", `/api/trusted-devices/${DEV}`);
    expect(r.json).toEqual({ status: "removed", locked: false });
    expect(writes.some((w) => w.op === "delete" && w.table === "recovery_codes")).toBe(true);
    expect(session.trustedDeviceId).toBeUndefined();
  });

  it("approving a new device needs a fresh proof and the right code; a wrong code ends the request", async () => {
    session = signedIn({ trustedDeviceId: DEV, deviceVerifiedAt: Date.now() - 10 * 60_000 });
    expect((await call("POST", "/api/trusted-devices/requests/req-1/approve", { code: "ABCDEF" })).json.code).toBe("step_up_required");

    const request = { id: "req-1", userId: "u-1", name: "Phone", publicKeyJwk: device().jwk, code: "ABCDEF", status: "pending", expiresAt: new Date(Date.now() + 60_000) };
    session = signedIn({ trustedDeviceId: DEV, deviceVerifiedAt: Date.now() });
    results.push([request]);
    expect((await call("POST", "/api/trusted-devices/requests/req-1/approve", { code: "ZZZZZZ" })).status).toBe(403);
    expect(writes.find((w) => w.op === "update" && w.table === "device_trust_requests")?.arg).toEqual({ status: "denied" });

    writes.length = 0;
    results.push([request], [{ max: 3 }], [{ id: DEV }]);
    const ok = await call("POST", "/api/trusted-devices/requests/req-1/approve", { code: "abcdef" });
    expect(ok.status).toBe(200);
    expect((writes.find((w) => w.op === "insert" && w.table === "trusted_devices")!.arg as Record<string, unknown>).id).toBe("req-1");
  });

  it("an expired request cannot be approved", async () => {
    session = signedIn({ trustedDeviceId: DEV, deviceVerifiedAt: Date.now() });
    results.push([{ id: "req-1", userId: "u-1", code: "ABCDEF", status: "pending", expiresAt: new Date(Date.now() - 1) }]);
    expect((await call("POST", "/api/trusted-devices/requests/req-1/approve", { code: "ABCDEF" })).status).toBe(404);
  });

  it("the limit cannot go below the number of devices, or out of range", async () => {
    session = signedIn({ trustedDeviceId: DEV, deviceVerifiedAt: Date.now() });
    expect((await call("PUT", "/api/trusted-devices/limit", { max: 0 })).status).toBe(400);
    results.push([{ id: "a" }, { id: "b" }]);
    expect((await call("PUT", "/api/trusted-devices/limit", { max: 1 })).status).toBe(409);
  });

  it("new recovery codes need a fresh proof", async () => {
    session = signedIn({ trustedDeviceId: DEV });
    expect((await call("POST", "/api/trusted-devices/recovery-codes")).json.code).toBe("step_up_required");
  });
});

describe("device cookie and profile", () => {
  const pendingChallenge = async () => {
    session = { pendingUserId: "u-1", pendingDid: "did:plc:x" };
    results.push([{ handle: "h" }]);
    return (await call("GET", "/api/device-trust/pending")).json.challenge as string;
  };

  it("a copied key without the device cookie cannot sign in", async () => {
    const d = device();
    const challenge = await pendingChallenge();
    cookieJar = {}; // the attacker has the key store but not the cookies
    results.push([row(d.jwk)]);
    const r = await call("POST", "/api/device-trust/pending/verify", { deviceId: DEV, signature: d.signIt(challenge) });
    expect(r.json.code).toBe("device_not_trusted");
    expect(session.userId).toBeUndefined();
  });

  it("the cookie of another device, or a device with no cookie on record, is refused", async () => {
    const d = device();
    let challenge = await pendingChallenge();
    cookieJar = { [COOKIE]: "some-other-token" };
    results.push([row(d.jwk)]);
    expect((await call("POST", "/api/device-trust/pending/verify", { deviceId: DEV, signature: d.signIt(challenge) })).status).toBe(403);

    challenge = await pendingChallenge();
    cookieJar = { [COOKIE]: TOKEN };
    results.push([row(d.jwk, { cookieHash: null })]);
    expect((await call("POST", "/api/device-trust/pending/verify", { deviceId: DEV, signature: d.signIt(challenge) })).status).toBe(403);
  });

  it("step-up needs the device cookie too", async () => {
    const d = device();
    session = { userId: "u-1", did: "did:plc:x", trustedDeviceId: DEV };
    const { json } = await call("POST", "/api/trusted-devices/challenge");
    cookieJar = {};
    results.push([row(d.jwk)]);
    expect((await call("POST", "/api/trusted-devices/step-up", { signature: d.signIt(json.challenge) })).status).toBe(403);
    expect(session.deviceVerifiedAt).toBeUndefined();
  });

  it("enrolment sets an HttpOnly cookie and stores only its hash, with the profile", async () => {
    const d = device();
    cookieJar = {};
    session = { userId: "u-1", did: "did:plc:x" };
    const { json } = await call("POST", "/api/trusted-devices/challenge");
    results.push([], [{ max: 3 }], [{ id: DEV, name: "Mac" }]);
    await call("POST", "/api/trusted-devices", { name: "Mac", publicKeyJwk: d.jwk, signature: d.signIt(json.challenge), profile: { cores: 10, touch: false } });
    const stored = writes.find((w) => w.op === "insert" && w.table === "trusted_devices")!.arg as Record<string, any>;
    expect(cookieJar[COOKIE]).toBeTruthy();
    expect(stored.cookieHash).toBe(hashDeviceCookie(cookieJar[COOKIE]));
    expect(JSON.stringify(stored)).not.toContain(cookieJar[COOKIE]);
    expect(stored.profile).toEqual({ os: "macOS", browser: "Safari", cores: "10", touch: "false" });
  });

  it("a new device gets its cookie when it asks, and approval carries it over", async () => {
    cookieJar = {};
    session = { pendingUserId: "u-1", pendingDid: "did:plc:x" };
    results.push([], [{ id: "req-1", expiresAt: new Date() }]);
    await call("POST", "/api/device-trust/pending/request", { name: "Phone", publicKeyJwk: device().jwk });
    const asked = writes.find((w) => w.op === "insert" && w.table === "device_trust_requests")!.arg as Record<string, any>;
    expect(asked.cookieHash).toBe(hashDeviceCookie(cookieJar[COOKIE]));

    writes.length = 0;
    session = { userId: "u-1", did: "did:plc:x", trustedDeviceId: DEV, deviceVerifiedAt: Date.now() };
    const request = { id: "req-1", userId: "u-1", name: "Phone", publicKeyJwk: asked.publicKeyJwk, code: "ABCDEF", status: "pending", expiresAt: new Date(Date.now() + 60_000), cookieHash: asked.cookieHash, profile: asked.profile };
    results.push([request], [{ max: 3 }], [{ id: DEV }]);
    await call("POST", "/api/trusted-devices/requests/req-1/approve", { code: "ABCDEF" });
    expect((writes.find((w) => w.op === "insert" && w.table === "trusted_devices")!.arg as Record<string, any>).cookieHash).toBe(asked.cookieHash);
  });

  it("the first sign-in stores the profile; the same machine later raises nothing", async () => {
    const d = device();
    let challenge = await pendingChallenge();
    results.push([row(d.jwk)]);
    await call("POST", "/api/device-trust/pending/verify", { deviceId: DEV, signature: d.signIt(challenge), profile: { cores: 10 } });
    const learned = writes.filter((w) => w.op === "update" && w.table === "trusted_devices").map((w) => w.arg as Record<string, any>);
    expect(learned.some((a) => a.profile?.os === "macOS")).toBe(true);

    writes.length = 0;
    challenge = await pendingChallenge();
    userAgent = MAC_SAFARI.replace("Version/18.0", "Version/19.1"); // a browser update
    results.push([row(d.jwk, { profile: { os: "macOS", browser: "Safari", cores: "10" } })]);
    const r = await call("POST", "/api/device-trust/pending/verify", { deviceId: DEV, signature: d.signIt(challenge), profile: { cores: 10 } });
    expect(r.status).toBe(200);
    expect(writes.some((w) => (w.arg as Record<string, any>)?.profileWarning)).toBe(false);
  });

  it("a trusted key on a machine that looks different still signs in, and a warning is recorded once", async () => {
    const d = device();
    const enrolled = { os: "macOS", browser: "Safari", cores: "10" };
    let challenge = await pendingChallenge();
    userAgent = WIN_CHROME;
    results.push([row(d.jwk, { profile: enrolled })]);
    const r = await call("POST", "/api/device-trust/pending/verify", { deviceId: DEV, signature: d.signIt(challenge), profile: { cores: 4 } });
    expect(r.status).toBe(200);
    const warned = writes.find((w) => (w.arg as Record<string, any>)?.profileWarning)!.arg as Record<string, any>;
    expect(warned.profileWarning).toBe("system: macOS → Windows; browser: Safari → Chrome; processor count: 10 → 4");

    writes.length = 0;
    challenge = await pendingChallenge();
    results.push([row(d.jwk, { profile: enrolled, profileWarning: warned.profileWarning })]);
    await call("POST", "/api/device-trust/pending/verify", { deviceId: DEV, signature: d.signIt(challenge) });
    expect(writes.some((w) => (w.arg as Record<string, any>)?.profileWarning)).toBe(false);
  });

  it("clearing a warning needs a fresh proof, then forgets the profile", async () => {
    session = { userId: "u-1", did: "did:plc:x", trustedDeviceId: DEV, deviceVerifiedAt: Date.now() - 10 * 60_000 };
    results.push([{ id: DEV }]);
    expect((await call("POST", `/api/trusted-devices/${DEV}/dismiss-warning`)).json.code).toBe("step_up_required");
    session.deviceVerifiedAt = Date.now();
    results.push([{ id: DEV }]);
    expect((await call("POST", `/api/trusted-devices/${DEV}/dismiss-warning`)).status).toBe(200);
    expect(writes.find((w) => w.op === "update" && w.table === "trusted_devices")!.arg).toEqual({ profileWarning: null, profileWarningAt: null, profile: null });
  });
});

describe("sign-in on hold notice", () => {
  it("a pending session tells the owner, with the browser and the address", async () => {
    const { establishPendingSession } = await import("../routes/device-trust.js");
    const sess: Record<string, unknown> = {};
    const req = {
      headers: { "user-agent": WIN_CHROME },
      ip: "203.0.113.9",
      session: Object.assign(sess, {
        regenerate: (cb: (e?: unknown) => void) => cb(),
        save: (cb: (e?: unknown) => void) => cb(),
      }),
    };
    results.push([{ tenantId: "t-1" }], [{ id: "notice-1" }]);
    await establishPendingSession(req as never, { userId: "u-1", did: "did:plc:x", redirect: "/" });
    const notice = writes.find((w) => w.op === "insert" && w.table === "notifications")!.arg as Record<string, string>;
    expect(notice).toMatchObject({ tenantId: "t-1", userId: "u-1", type: "device_trust" });
    expect(notice.body).toContain("Chrome on Windows");
    expect(notice.body).toContain("203.0.113.9");
    expect(sess).toMatchObject({ pendingUserId: "u-1", pendingNoticeId: "notice-1" });
    expect(sess.userId).toBeUndefined();
  });

  it("a user in no tailnet still gets a pending session", async () => {
    const { establishPendingSession } = await import("../routes/device-trust.js");
    const sess: Record<string, unknown> = {};
    const req = { headers: {}, session: Object.assign(sess, { regenerate: (cb: () => void) => cb(), save: (cb: () => void) => cb() }) };
    results.push([]);
    await establishPendingSession(req as never, { userId: "u-1", did: "did:plc:x", redirect: "/" });
    expect(sess.pendingUserId).toBe("u-1");
    expect(sess.pendingNoticeId).toBeUndefined();
  });

  it("the notice is removed when the trusted device proves itself, and kept when the proof fails", async () => {
    const d = device();
    session = { pendingUserId: "u-1", pendingDid: "did:plc:x", pendingNoticeId: "notice-1" };
    results.push([{ handle: "h" }]);
    let challenge = (await call("GET", "/api/device-trust/pending")).json.challenge;
    results.push([row(d.jwk)]);
    expect((await call("POST", "/api/device-trust/pending/verify", { deviceId: DEV, signature: device().signIt(challenge) })).status).toBe(403);
    expect(writes.some((w) => w.op === "delete" && w.table === "notifications")).toBe(false);

    results.push([{ handle: "h" }]);
    challenge = (await call("GET", "/api/device-trust/pending")).json.challenge;
    results.push([row(d.jwk)]);
    expect((await call("POST", "/api/device-trust/pending/verify", { deviceId: DEV, signature: d.signIt(challenge) })).status).toBe(200);
    expect(writes.some((w) => w.op === "delete" && w.table === "notifications")).toBe(true);
  });
});
