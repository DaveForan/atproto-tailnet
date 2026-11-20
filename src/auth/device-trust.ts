/**
 * @module auth/device-trust
 * Cryptography and rules of device-bound sign-in (ADR-0035).
 *
 * A trusted device holds an ECDSA P-256 key that its browser will use but not
 * reveal. To prove itself it signs a random, single-use challenge; the server
 * checks the signature against the stored public key. No shared secret exists,
 * so a copy of the database does not let anyone impersonate a device.
 */

import { createHash, createPublicKey, randomBytes, randomInt, timingSafeEqual, verify } from "node:crypto";

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** How long a proof counts for sensitive actions (step-up). */
export const STEP_UP_TTL_MS = 5 * 60 * 1000;
export const TRUST_REQUEST_TTL_MS = 10 * 60 * 1000;
export const RECOVERY_CODE_COUNT = 8;
export const MAX_TRUSTED_DEVICES_LIMIT = 10;
/** Wrong recovery codes or signatures allowed in one pending sign-in. */
export const MAX_PROOF_ATTEMPTS = 5;

export interface DevicePublicKey {
  kty: string;
  crv: string;
  x: string;
  y: string;
}

const B64URL = /^[A-Za-z0-9_-]+$/;

/** A P-256 public key with exactly the public members, or null. Never keeps a private `d`. */
export function parseDevicePublicKey(input: unknown): DevicePublicKey | null {
  const k = input as Record<string, unknown> | null;
  if (!k || k.kty !== "EC" || k.crv !== "P-256") return null;
  if (typeof k.x !== "string" || typeof k.y !== "string") return null;
  if (!B64URL.test(k.x) || !B64URL.test(k.y) || k.x.length !== 43 || k.y.length !== 43) return null;
  const jwk = { kty: "EC", crv: "P-256", x: k.x, y: k.y };
  try {
    createPublicKey({ key: jwk, format: "jwk" }); // rejects points that are not on the curve
    return jwk;
  } catch {
    return null;
  }
}

export function newChallenge(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * True when `signature` (base64url, raw r||s as WebCrypto produces it) is a
 * valid ECDSA P-256 / SHA-256 signature of `challenge` by `jwk`.
 */
export function verifyDeviceSignature(jwk: DevicePublicKey, challenge: string, signature: unknown): boolean {
  if (typeof signature !== "string" || !B64URL.test(signature) || signature.length > 128) return false;
  try {
    const sig = Buffer.from(signature, "base64url");
    if (sig.length !== 64) return false;
    return verify(
      "sha256",
      Buffer.from(challenge, "utf8"),
      { key: createPublicKey({ key: { ...jwk }, format: "jwk" }), dsaEncoding: "ieee-p1363" },
      sig,
    );
  } catch {
    return false;
  }
}

/** A challenge stored in the session, usable once and only while fresh. */
export interface StoredChallenge {
  value: string;
  issuedAt: number;
}

export function challengeUsable(c: StoredChallenge | undefined, now = Date.now()): c is StoredChallenge {
  return !!c && now - c.issuedAt < CHALLENGE_TTL_MS;
}

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I, L, O, 0, 1

function randomCode(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/** Recovery codes as shown to the user: `XXXXX-XXXXX` (about 49 bits each). */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => `${randomCode(5)}-${randomCode(5)}`);
}

/** Canonical form for hashing: upper case, no separators or spaces. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(normalizeRecoveryCode(code)).digest("hex");
}

/** Six characters shown on a new device and typed on a trusted one. */
export function generatePairingCode(): string {
  return randomCode(6);
}

export function codesEqual(a: string, b: string): boolean {
  const x = Buffer.from(normalizeRecoveryCode(a));
  const y = Buffer.from(normalizeRecoveryCode(b));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Display name for a device, trimmed and bounded. */
export function cleanDeviceName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const name = input.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60);
  return name.length > 0 ? name : null;
}
