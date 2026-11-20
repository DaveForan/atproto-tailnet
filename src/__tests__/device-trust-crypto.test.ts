/** Device trust cryptography (ADR-0035). */
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign, webcrypto } from "node:crypto";
import {
  parseDevicePublicKey,
  verifyDeviceSignature,
  newChallenge,
  challengeUsable,
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
  codesEqual,
  cleanDeviceName,
  generatePairingCode,
  CHALLENGE_TTL_MS,
} from "../auth/device-trust.js";

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { kty: string; crv: string; x: string; y: string };
  const signIt = (msg: string) => sign("sha256", Buffer.from(msg), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return { jwk, signIt };
}

describe("parseDevicePublicKey", () => {
  it("accepts a P-256 public key and keeps only public members", () => {
    const { jwk } = keyPair();
    expect(parseDevicePublicKey({ ...jwk, d: "private", ext: true })).toEqual({ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y });
  });
  it.each([
    null,
    {},
    { kty: "RSA" },
    { kty: "EC", crv: "P-384", x: "a", y: "b" },
    { kty: "EC", crv: "P-256", x: "A".repeat(43), y: "A".repeat(43) }, // not on the curve
    { kty: "EC", crv: "P-256", x: 1, y: 2 },
  ])("refuses %j", (bad) => {
    expect(parseDevicePublicKey(bad)).toBeNull();
  });
});

describe("verifyDeviceSignature", () => {
  it("accepts the right key over the right challenge only", () => {
    const a = keyPair();
    const b = keyPair();
    const challenge = newChallenge();
    const sig = a.signIt(challenge);
    expect(verifyDeviceSignature(a.jwk, challenge, sig)).toBe(true);
    expect(verifyDeviceSignature(b.jwk, challenge, sig)).toBe(false);
    expect(verifyDeviceSignature(a.jwk, newChallenge(), sig)).toBe(false);
  });
  it("refuses malformed signatures without throwing", () => {
    const a = keyPair();
    for (const bad of [undefined, 42, "", "not base64!", "AAAA", "A".repeat(200)]) {
      expect(verifyDeviceSignature(a.jwk, "c", bad)).toBe(false);
    }
  });
  it("verifies a signature made by WebCrypto, as browsers make it", async () => {
    const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const jwk = (await webcrypto.subtle.exportKey("jwk", pair.publicKey)) as { kty: string; crv: string; x: string; y: string };
    const challenge = newChallenge();
    const sig = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(challenge));
    expect(verifyDeviceSignature(parseDevicePublicKey(jwk)!, challenge, Buffer.from(sig).toString("base64url"))).toBe(true);
  });
});

describe("challenges", () => {
  it("are random and expire", () => {
    expect(newChallenge()).not.toBe(newChallenge());
    const now = Date.now();
    expect(challengeUsable({ value: "x", issuedAt: now - 1000 }, now)).toBe(true);
    expect(challengeUsable({ value: "x", issuedAt: now - CHALLENGE_TTL_MS }, now)).toBe(false);
    expect(challengeUsable(undefined, now)).toBe(false);
  });
});

describe("recovery and pairing codes", () => {
  it("recovery codes are distinct and hash the same however they are typed", () => {
    const codes = generateRecoveryCodes();
    expect(new Set(codes).size).toBe(8);
    expect(codes[0]).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect(hashRecoveryCode(codes[0])).toBe(hashRecoveryCode(` ${codes[0].toLowerCase().replace("-", " ")} `));
    expect(hashRecoveryCode(codes[0])).not.toBe(hashRecoveryCode(codes[1]));
    expect(normalizeRecoveryCode("ab-cd 12")).toBe("ABCD12");
  });
  it("pairing codes compare in constant time and ignore case", () => {
    const code = generatePairingCode();
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    expect(codesEqual(code, code.toLowerCase())).toBe(true);
    expect(codesEqual(code, "ZZZZZZ")).toBe(code === "ZZZZZZ");
    expect(codesEqual("", "")).toBe(false);
  });
});

describe("cleanDeviceName", () => {
  it("trims, strips control characters and bounds the length", () => {
    expect(cleanDeviceName("  Dave's\u0000 Mac \n")).toBe("Dave's Mac");
    expect(cleanDeviceName("x".repeat(100))).toHaveLength(60);
    expect(cleanDeviceName("   ")).toBeNull();
    expect(cleanDeviceName(7)).toBeNull();
  });
});
