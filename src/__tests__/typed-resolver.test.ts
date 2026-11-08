import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Secp256k1Keypair, P256Keypair, verifySignature } from "@atproto/crypto";
import { DIDResolver } from "../identity/resolver.js";

const ED25519_JWK = {
  kty: "OKP",
  crv: "Ed25519",
  x: "O2onvM62pC1io6jQKm8Nc2UyFXcd4kOmOsBIoYtZ2ik",
};

describe("resolveTyped — multikey (publicKeyMultibase)", () => {
  let resolver: DIDResolver;

  beforeEach(() => {
    resolver = new DIDResolver({ cacheTtlMs: 500, hostCheck: async () => true });
  });

  afterEach(() => {
    resolver.clearCache();
    vi.restoreAllMocks();
  });

  it("resolves a secp256k1 multikey from a did:plc document", async () => {
    const kp = await Secp256k1Keypair.create({ exportable: true });
    const multikey = kp.did().replace("did:key:", "");

    const doc = {
      id: "did:plc:test-k256",
      verificationMethod: [
        {
          id: "did:plc:test-k256#atproto",
          type: "Multikey",
          controller: "did:plc:test-k256",
          publicKeyMultibase: multikey,
        },
      ],
    };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => doc,
    }));

    const resolved = await resolver.resolveTyped("did:plc:test-k256", {
      methodId: "#atproto",
      algorithms: ["ES256K"],
    });

    expect(resolved).not.toBeNull();
    expect(resolved!.algorithm).toBe("ES256K");
    expect(resolved!.methodId).toBe("#atproto");
    expect(resolved!.didKey).toMatch(/^did:key:zQ3s/);
    expect(resolved!.key).toBeDefined();
  });

  it("resolves a P-256 multikey from a did:plc document", async () => {
    const kp = await P256Keypair.create({ exportable: true });
    const multikey = kp.did().replace("did:key:", "");

    const doc = {
      id: "did:plc:test-p256",
      verificationMethod: [
        {
          id: "did:plc:test-p256#atproto",
          type: "Multikey",
          controller: "did:plc:test-p256",
          publicKeyMultibase: multikey,
        },
      ],
    };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => doc,
    }));

    const resolved = await resolver.resolveTyped("did:plc:test-p256", {
      methodId: "#atproto",
      algorithms: ["ES256K", "ES256"],
    });

    expect(resolved).not.toBeNull();
    expect(resolved!.algorithm).toBe("ES256");
    expect(resolved!.methodId).toBe("#atproto");
    expect(resolved!.didKey).toMatch(/^did:key:zDnae/);
  });

  it("imported key can verify signatures from @atproto/crypto", async () => {
    const kp = await Secp256k1Keypair.create({ exportable: true });
    const multikey = kp.did().replace("did:key:", "");
    const msg = new TextEncoder().encode("test-payload");
    const sig = await kp.sign(msg);

    const doc = {
      id: "did:plc:verify-round-trip",
      verificationMethod: [
        {
          id: "did:plc:verify-round-trip#atproto",
          type: "Multikey",
          publicKeyMultibase: multikey,
        },
      ],
    };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => doc,
    }));

    const resolved = await resolver.resolveTyped("did:plc:verify-round-trip", {
      methodId: "#atproto",
    });
    expect(resolved).not.toBeNull();

    const ok = await verifySignature(resolved!.didKey!, msg, sig);
    expect(ok).toBe(true);
  });

  it("filters by algorithm — rejects ES256 when only ES256K requested", async () => {
    const kp = await P256Keypair.create({ exportable: true });
    const multikey = kp.did().replace("did:key:", "");

    const doc = {
      id: "did:plc:alg-filter",
      verificationMethod: [
        {
          id: "did:plc:alg-filter#atproto",
          type: "Multikey",
          publicKeyMultibase: multikey,
        },
      ],
    };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => doc,
    }));

    const resolved = await resolver.resolveTyped("did:plc:alg-filter", {
      methodId: "#atproto",
      algorithms: ["ES256K"],
    });
    expect(resolved).toBeNull();
  });

  it("filters by methodId — ignores methods with wrong id", async () => {
    const kp = await Secp256k1Keypair.create({ exportable: true });
    const multikey = kp.did().replace("did:key:", "");

    const doc = {
      id: "did:plc:method-filter",
      verificationMethod: [
        {
          id: "did:plc:method-filter#atproto",
          type: "Multikey",
          publicKeyMultibase: multikey,
        },
      ],
    };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => doc,
    }));

    const resolved = await resolver.resolveTyped("did:plc:method-filter", {
      methodId: "#signing-key",
    });
    expect(resolved).toBeNull();
  });
});

describe("resolveTyped — JWK keys", () => {
  let resolver: DIDResolver;

  beforeEach(() => {
    resolver = new DIDResolver({ cacheTtlMs: 500, hostCheck: async () => true });
  });

  afterEach(() => {
    resolver.clearCache();
    vi.restoreAllMocks();
  });

  it("resolves an Ed25519 JWK as EdDSA", async () => {
    const doc = {
      id: "did:web:example.com",
      verificationMethod: [
        {
          id: "did:web:example.com#signing-key",
          type: "JsonWebKey2020",
          publicKeyJwk: ED25519_JWK,
        },
      ],
    };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => doc,
    }));

    const resolved = await resolver.resolveTyped("did:web:example.com", {
      methodId: "#signing-key",
      algorithms: ["EdDSA"],
    });

    expect(resolved).not.toBeNull();
    expect(resolved!.algorithm).toBe("EdDSA");
    expect(resolved!.methodId).toBe("#signing-key");
    expect(resolved!.didKey).toBeUndefined();
  });

  it("resolves an EC P-256 JWK as ES256", async () => {
    const { createECDH } = await import("node:crypto");
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const x = ecdh.getPublicKey().subarray(1, 33);
    const y = ecdh.getPublicKey().subarray(33, 65);
    const { base64url } = await import("jose");

    const doc = {
      id: "did:web:ec.example.com",
      verificationMethod: [
        {
          id: "did:web:ec.example.com#atproto",
          type: "JsonWebKey2020",
          publicKeyJwk: {
            kty: "EC",
            crv: "P-256",
            x: base64url.encode(x),
            y: base64url.encode(y),
          },
        },
      ],
    };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => doc,
    }));

    const resolved = await resolver.resolveTyped("did:web:ec.example.com", {
      methodId: "#atproto",
      algorithms: ["ES256"],
    });

    expect(resolved).not.toBeNull();
    expect(resolved!.algorithm).toBe("ES256");
    expect(resolved!.methodId).toBe("#atproto");
  });
});

describe("resolveTyped — local lookup", () => {
  it("resolves local collective keys without network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const resolver = new DIDResolver({
      localLookup: async (did) =>
        did === "did:web:localhost%3A3000:collective:a" ? ED25519_JWK : null,
      hostCheck: async () => false,
    });

    const resolved = await resolver.resolveTyped(
      "did:web:localhost%3A3000:collective:a",
      { methodId: "#signing-key", algorithms: ["EdDSA"] },
    );

    expect(resolved).not.toBeNull();
    expect(resolved!.algorithm).toBe("EdDSA");
    expect(resolved!.methodId).toBe("#signing-key");
    expect(fetchMock).not.toHaveBeenCalled();

    resolver.clearCache();
    vi.restoreAllMocks();
  });
});

describe("resolveTyped — caching", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("caches typed resolutions and invalidate clears them", async () => {
    const kp = await Secp256k1Keypair.create({ exportable: true });
    const multikey = kp.did().replace("did:key:", "");

    const doc = {
      id: "did:plc:cache-test",
      verificationMethod: [
        {
          id: "did:plc:cache-test#atproto",
          type: "Multikey",
          publicKeyMultibase: multikey,
        },
      ],
    };

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => doc,
    });
    vi.stubGlobal("fetch", fetchMock);

    const resolver = new DIDResolver({ cacheTtlMs: 5000, hostCheck: async () => true });

    await resolver.resolveTyped("did:plc:cache-test", { methodId: "#atproto" });
    await resolver.resolveTyped("did:plc:cache-test", { methodId: "#atproto" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolver.invalidate("did:plc:cache-test");
    await resolver.resolveTyped("did:plc:cache-test", { methodId: "#atproto" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolver.clearCache();
  });
});
