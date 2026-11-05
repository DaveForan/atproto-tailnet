/**
 * @module identity/keys
 * Collective signing-key primitives (ADR-0016, ADR-0017): at-rest encryption
 * of the Ed25519 private key and detached-JWS signing/verification.
 *
 * This is the single implementation of both — the federation broker, the
 * inbound CFP endpoints and the credential issuer all go through it. Pure
 * functions only (no DB), so they are unit-testable with real keys.
 */

import * as crypto from "node:crypto";
import * as jose from "jose";

type VerifyKey = jose.CryptoKey | jose.KeyObject;

/** Protected header of every detached signature this service produces. */
const JWS_HEADER_B64 = jose.base64url.encode(
  new TextEncoder().encode(JSON.stringify({ alg: "EdDSA" })),
);

function signingInput(payload: string): string {
  return `${JWS_HEADER_B64}.${jose.base64url.encode(new TextEncoder().encode(payload))}`;
}

/**
 * Sign `payload` with an Ed25519 key. Returns the base64url signature part of
 * a compact JWS (`{"alg":"EdDSA"}` header) — a "detached JWS" in the sense
 * used by ADR-0014, interoperable with `jose.CompactSign`.
 */
export function signDetached(privateKey: crypto.KeyObject, payload: string): string {
  return crypto
    .sign(null, Buffer.from(signingInput(payload)), privateKey)
    .toString("base64url");
}

/** Verify a signature produced by {@link signDetached}. Never throws. */
export async function verifyDetached(
  publicKey: VerifyKey,
  payload: string,
  signature: string,
): Promise<boolean> {
  if (typeof signature !== "string" || signature.length === 0) return false;
  try {
    await jose.compactVerify(`${signingInput(payload)}.${signature}`, publicKey, {
      algorithms: ["EdDSA"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Encode a PEM private key for the `collective_dids.encrypted_private_key`
 * column. With a 32-byte hex key: AES-256-GCM as `iv:tag:ciphertext` (hex).
 * Without one (dev only): plain base64.
 */
export function encryptPrivateKey(pem: string, hexKey?: string): string {
  if (!hexKey) return Buffer.from(pem).toString("base64");
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(hexKey, "hex"), iv);
  const encrypted = Buffer.concat([cipher.update(pem, "utf8"), cipher.final()]);
  return [iv.toString("hex"), cipher.getAuthTag().toString("hex"), encrypted.toString("hex")].join(":");
}

/** Inverse of {@link encryptPrivateKey}; the stored form says which mode was used. */
export function decryptPrivateKey(stored: string, hexKey?: string): string {
  if (!stored.includes(":")) {
    return Buffer.from(stored, "base64").toString("utf8");
  }
  if (!hexKey) {
    throw new Error(
      "Collective private key is encrypted but FEDERATION_KEY_ENCRYPTION_KEY is not set",
    );
  }
  const [ivHex, tagHex, encHex] = stored.split(":");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(hexKey, "hex"),
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(encHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

/** Load a stored private key as a KeyObject ready for {@link signDetached} / jose. */
export function loadPrivateKey(stored: string, hexKey?: string): crypto.KeyObject {
  return crypto.createPrivateKey(decryptPrivateKey(stored, hexKey));
}
