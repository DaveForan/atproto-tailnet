import { describe, it, expect } from "vitest";
import * as crypto from "node:crypto";
import * as jose from "jose";
import {
  signDetached,
  verifyDetached,
  encryptPrivateKey,
  decryptPrivateKey,
  loadPrivateKey,
} from "../identity/keys.js";

const HEX_KEY = "ab".repeat(32);

function newKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  return { publicKey, privateKey, pem };
}

describe("detached signatures", () => {
  it("round-trips with an Ed25519 key", async () => {
    const { publicKey, privateKey } = newKey();
    const sig = signDetached(privateKey, "hello");
    expect(await verifyDetached(publicKey, "hello", sig)).toBe(true);
  });

  it("rejects a tampered payload, a foreign key and an empty signature", async () => {
    const a = newKey();
    const b = newKey();
    const sig = signDetached(a.privateKey, "hello");
    expect(await verifyDetached(a.publicKey, "hello!", sig)).toBe(false);
    expect(await verifyDetached(b.publicKey, "hello", sig)).toBe(false);
    expect(await verifyDetached(a.publicKey, "hello", "")).toBe(false);
  });

  it("produces the signature part of a jose compact JWS", async () => {
    const { publicKey, privateKey } = newKey();
    const jws = await new jose.CompactSign(new TextEncoder().encode("nonce-123"))
      .setProtectedHeader({ alg: "EdDSA" })
      .sign(privateKey);
    // Ed25519 is deterministic, so both implementations must agree exactly.
    expect(signDetached(privateKey, "nonce-123")).toBe(jws.split(".")[2]);
    expect(await verifyDetached(publicKey, "nonce-123", jws.split(".")[2])).toBe(true);
  });

  it("verifies against a key imported from the published JWK", async () => {
    const { publicKey, privateKey } = newKey();
    const imported = await jose.importJWK(publicKey.export({ format: "jwk" }) as jose.JWK, "EdDSA");
    const sig = signDetached(privateKey, "payload");
    expect(await verifyDetached(imported as jose.CryptoKey, "payload", sig)).toBe(true);
  });
});

describe("private key storage", () => {
  it("round-trips unencrypted (dev) storage", () => {
    const { pem } = newKey();
    expect(decryptPrivateKey(encryptPrivateKey(pem))).toBe(pem);
  });

  it("round-trips AES-256-GCM storage", () => {
    const { pem } = newKey();
    const stored = encryptPrivateKey(pem, HEX_KEY);
    expect(stored).not.toContain("PRIVATE KEY");
    expect(stored.split(":")).toHaveLength(3);
    expect(decryptPrivateKey(stored, HEX_KEY)).toBe(pem);
  });

  it("still reads keys stored before an encryption key was configured", () => {
    const { pem } = newKey();
    expect(decryptPrivateKey(encryptPrivateKey(pem), HEX_KEY)).toBe(pem);
  });

  it("fails loudly with a wrong or missing encryption key", () => {
    const { pem } = newKey();
    const stored = encryptPrivateKey(pem, HEX_KEY);
    expect(() => decryptPrivateKey(stored)).toThrow(/FEDERATION_KEY_ENCRYPTION_KEY/);
    expect(() => decryptPrivateKey(stored, "cd".repeat(32))).toThrow();
  });

  it("loads a stored key that can sign", async () => {
    const { pem, publicKey } = newKey();
    const key = loadPrivateKey(encryptPrivateKey(pem, HEX_KEY), HEX_KEY);
    expect(await verifyDetached(publicKey, "x", signDetached(key, "x"))).toBe(true);
  });
});
