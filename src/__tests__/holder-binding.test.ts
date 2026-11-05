import { describe, it, expect } from "vitest";
import * as jose from "jose";
import { verifyHolderBinding } from "../credentials/verifier.js";
import type { PublicKeyResolver } from "../credentials/verifier.js";
import { generateHolderChallenge } from "../credentials/issuer.js";

describe("holder binding verification", () => {
  let privateKey: jose.CryptoKey | jose.KeyObject;
  let publicKey: jose.CryptoKey | jose.KeyObject;
  const holderDid = "did:web:alice.example.com";

  const makeResolver = (
    forDid: string,
    key: jose.CryptoKey | jose.KeyObject,
  ): PublicKeyResolver => ({
    resolve: async (did) => (did === forDid ? key : null),
  });

  it("setup key pair", async () => {
    const kp = await jose.generateKeyPair("EdDSA", { crv: "Ed25519" });
    privateKey = kp.privateKey;
    publicKey = kp.publicKey;
  });

  it("verifies valid holder binding proof", async () => {
    const challenge = generateHolderChallenge(60);
    const resolver = makeResolver(holderDid, publicKey);

    const jws = await new jose.CompactSign(
      new TextEncoder().encode(challenge.nonce),
    )
      .setProtectedHeader({ alg: "EdDSA" })
      .sign(privateKey);

    const sig = jws.split(".")[2];

    const result = await verifyHolderBinding(
      { nonce: challenge.nonce, signature: sig, did: holderDid },
      challenge,
      resolver,
    );
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("rejects nonce mismatch", async () => {
    const challenge = generateHolderChallenge(60);
    const resolver = makeResolver(holderDid, publicKey);

    const result = await verifyHolderBinding(
      { nonce: "wrong-nonce", signature: "anysig", did: holderDid },
      challenge,
      resolver,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Nonce mismatch");
  });

  it("rejects expired challenge", async () => {
    const challenge = {
      nonce: "test-nonce",
      issuedAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    };
    const resolver = makeResolver(holderDid, publicKey);

    const result = await verifyHolderBinding(
      { nonce: "test-nonce", signature: "sig", did: holderDid },
      challenge,
      resolver,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("expired");
  });

  it("rejects unresolvable DID", async () => {
    const challenge = generateHolderChallenge(60);
    const resolver: PublicKeyResolver = { resolve: async () => null };

    const result = await verifyHolderBinding(
      { nonce: challenge.nonce, signature: "sig", did: "did:web:unknown.example.com" },
      challenge,
      resolver,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Cannot resolve");
  });

  it("rejects invalid signature", async () => {
    const challenge = generateHolderChallenge(60);
    const resolver = makeResolver(holderDid, publicKey);

    const result = await verifyHolderBinding(
      { nonce: challenge.nonce, signature: "badsig", did: holderDid },
      challenge,
      resolver,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Signature verification failed");
  });

  it("rejects proof signed by different key", async () => {
    const otherKp = await jose.generateKeyPair("EdDSA", { crv: "Ed25519" });
    const challenge = generateHolderChallenge(60);
    const resolver = makeResolver(holderDid, publicKey);

    const jws = await new jose.CompactSign(
      new TextEncoder().encode(challenge.nonce),
    )
      .setProtectedHeader({ alg: "EdDSA" })
      .sign(otherKp.privateKey);

    const wrongSig = jws.split(".")[2];

    const result = await verifyHolderBinding(
      { nonce: challenge.nonce, signature: wrongSig, did: holderDid },
      challenge,
      resolver,
    );
    expect(result.valid).toBe(false);
  });
});
