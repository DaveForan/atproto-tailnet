/**
 * Cross-implementation CFP signing vectors. The same fixture is checked by the
 * Rust coordinator (coordinator/crates/coord-federation/tests/cfp_vectors.rs),
 * so a message signed by either implementation verifies in the other.
 */
import { describe, it, expect } from "vitest";
import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize } from "../federation/jcs.js";
import { routeOriginPayload, signedPayload, verifyMessage } from "../federation/auth.js";
import { challengeResponsePayload } from "../federation/handshake.js";
import { signDetached, verifyDetached } from "../identity/keys.js";
import type { PublicKeyResolver } from "../credentials/verifier.js";

interface Vectors {
  jwsProtectedHeader: string;
  key: { seedHex: string; publicKeyHex: string; publicKeyJwk: crypto.JsonWebKey; did: string };
  jcs: Array<{ name: string; inputJson: string; canonical: string }>;
  messages: Array<{ name: string; message: Record<string, unknown>; signingPayload: string; signature: string }>;
  payloads: Array<{ name: string; payload: string; signature: string }>;
}

const fixturePath = fileURLToPath(
  new URL("../../coordinator/crates/coord-federation/tests/fixtures/cfp_vectors.json", import.meta.url),
);
const v = JSON.parse(readFileSync(fixturePath, "utf8")) as Vectors;

const privateKey = crypto.createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(v.key.seedHex, "hex")]),
  format: "der",
  type: "pkcs8",
});
const publicKey = crypto.createPublicKey({ key: v.key.publicKeyJwk, format: "jwk" });
const resolver: PublicKeyResolver = { resolve: async (did) => (did === v.key.did ? publicKey : null) };

describe("CFP cross-implementation vectors", () => {
  it("uses the fixture key", () => {
    expect(Buffer.from(v.key.publicKeyJwk.x as string, "base64url").toString("hex")).toBe(v.key.publicKeyHex);
    expect(Buffer.from(crypto.createPublicKey(privateKey).export({ format: "jwk" }).x as string, "base64url").toString("hex"))
      .toBe(v.key.publicKeyHex);
  });

  for (const c of v.jcs) {
    it(`JCS: ${c.name}`, () => {
      expect(canonicalize(JSON.parse(c.inputJson))).toBe(c.canonical);
    });
  }

  for (const m of v.messages) {
    it(`message ${m.name}: payload, signature and verification match`, async () => {
      expect(signedPayload(m.message)).toBe(m.signingPayload);
      expect(m.message.signature).toBe(m.signature);
      // Ed25519 is deterministic: we produce exactly the fixture signature.
      expect(signDetached(privateKey, m.signingPayload)).toBe(m.signature);
      expect(await verifyMessage(resolver, v.key.did, m.message)).toBe(true);
      const reordered = Object.fromEntries(Object.entries(m.message).reverse());
      expect(await verifyMessage(resolver, v.key.did, reordered)).toBe(true);
      expect(await verifyMessage(resolver, v.key.did, { ...m.message, timestamp: "2026-11-19T12:00:01.000Z" })).toBe(false);
    });
  }

  it("challenge-response and route-origin payloads", async () => {
    const byName = Object.fromEntries(v.payloads.map((p) => [p.name, p]));
    const commit = v.messages.find((m) => m.name === "commit")!.message as {
      collectiveDid: string;
      challengeNonce: string;
      challengeSignature: string;
    };
    const challenge = v.messages.find((m) => m.name === "challenge")!.message as { collectiveDid: string };
    expect(challengeResponsePayload(commit.challengeNonce, commit.collectiveDid, challenge.collectiveDid))
      .toBe(byName["challenge-response"].payload);
    expect(commit.challengeSignature).toBe(byName["challenge-response"].signature);
    expect(routeOriginPayload("100.64.1.0/24", v.key.did)).toBe(byName["route-origin"].payload);
    for (const p of v.payloads) {
      expect(signDetached(privateKey, p.payload)).toBe(p.signature);
      expect(await verifyDetached(publicKey, p.payload, p.signature)).toBe(true);
    }
  });

  it("rejects values JCS cannot represent", () => {
    expect(() => canonicalize({ n: Number.NaN })).toThrow();
    expect(() => canonicalize({ s: "\ud800" })).toThrow();
    expect(() => canonicalize({ b: 1n })).toThrow();
    expect(canonicalize({ a: undefined, b: [undefined] })).toBe('{"b":[null]}');
  });
});
