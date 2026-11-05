import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DIDResolver, didWebToUrl, isPublicAddress, isPublicHost } from "../identity/resolver.js";

describe("didWebToUrl", () => {
  it("converts root domain to .well-known path", () => {
    expect(didWebToUrl("did:web:example.com")).toBe(
      "https://example.com/.well-known/did.json",
    );
  });

  it("converts domain with path segments", () => {
    expect(didWebToUrl("did:web:example.com:users:alice")).toBe(
      "https://example.com/users/alice/did.json",
    );
  });

  it("decodes percent-encoded port in host", () => {
    expect(didWebToUrl("did:web:localhost%3A3000")).toBe(
      "https://localhost:3000/.well-known/did.json",
    );
  });

  it("handles single sub-path", () => {
    expect(didWebToUrl("did:web:w3c.github.io:did-resolution")).toBe(
      "https://w3c.github.io/did-resolution/did.json",
    );
  });
});

describe("DIDResolver", () => {
  let resolver: DIDResolver;

  beforeEach(() => {
    resolver = new DIDResolver({ cacheTtlMs: 500, hostCheck: async () => true });
  });

  afterEach(() => {
    resolver.clearCache();
    vi.restoreAllMocks();
  });

  it("returns null for unsupported DID methods", async () => {
    const key = await resolver.resolve("did:key:z6MkpTHR8VNs64");
    expect(key).toBeNull();
  });

  it("resolves did:web by fetching .well-known/did.json", async () => {
    const mockDoc = {
      id: "did:web:example.com",
      verificationMethod: [
        {
          id: "did:web:example.com#key-1",
          type: "JsonWebKey2020",
          controller: "did:web:example.com",
          publicKeyJwk: {
            kty: "OKP",
            crv: "Ed25519",
            x: "O2onvM62pC1io6jQKm8Nc2UyFXcd4kOmOsBIoYtZ2ik",
          },
        },
      ],
      assertionMethod: ["did:web:example.com#key-1"],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockDoc,
      }),
    );

    const key = await resolver.resolve("did:web:example.com");
    expect(key).not.toBeNull();
    expect(fetch).toHaveBeenCalledWith(
      "https://example.com/.well-known/did.json",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: expect.any(String) }),
      }),
    );
  });

  it("resolves did:plc via plc.directory", async () => {
    const mockDoc = {
      id: "did:plc:abc123",
      verificationMethod: [
        {
          id: "did:plc:abc123#atproto",
          type: "JsonWebKey2020",
          publicKeyJwk: {
            kty: "OKP",
            crv: "Ed25519",
            x: "O2onvM62pC1io6jQKm8Nc2UyFXcd4kOmOsBIoYtZ2ik",
          },
        },
      ],
      authentication: ["did:plc:abc123#atproto"],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockDoc,
      }),
    );

    const key = await resolver.resolve("did:plc:abc123");
    expect(key).not.toBeNull();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("plc.directory/did%3Aplc%3Aabc123"),
      expect.any(Object),
    );
  });

  it("returns null when fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404 }),
    );

    const key = await resolver.resolve("did:web:nonexistent.example.com");
    expect(key).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error")),
    );

    const key = await resolver.resolve("did:web:unreachable.example.com");
    expect(key).toBeNull();
  });

  it("returns null for DID document with no usable keys", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: "did:web:empty.example.com",
          verificationMethod: [],
        }),
      }),
    );

    const key = await resolver.resolve("did:web:empty.example.com");
    expect(key).toBeNull();
  });

  it("caches resolved keys", async () => {
    const mockDoc = {
      id: "did:web:cached.example.com",
      verificationMethod: [
        {
          id: "did:web:cached.example.com#key-1",
          type: "JsonWebKey2020",
          publicKeyJwk: {
            kty: "OKP",
            crv: "Ed25519",
            x: "O2onvM62pC1io6jQKm8Nc2UyFXcd4kOmOsBIoYtZ2ik",
          },
        },
      ],
      assertionMethod: ["did:web:cached.example.com#key-1"],
    };

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockDoc,
    });
    vi.stubGlobal("fetch", fetchMock);

    const key1 = await resolver.resolve("did:web:cached.example.com");
    const key2 = await resolver.resolve("did:web:cached.example.com");

    expect(key1).not.toBeNull();
    expect(key2).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("invalidate() forces re-fetch", async () => {
    const mockDoc = {
      id: "did:web:inv.example.com",
      verificationMethod: [
        {
          id: "did:web:inv.example.com#key-1",
          type: "JsonWebKey2020",
          publicKeyJwk: {
            kty: "OKP",
            crv: "Ed25519",
            x: "O2onvM62pC1io6jQKm8Nc2UyFXcd4kOmOsBIoYtZ2ik",
          },
        },
      ],
      assertionMethod: ["did:web:inv.example.com#key-1"],
    };

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockDoc,
    });
    vi.stubGlobal("fetch", fetchMock);

    await resolver.resolve("did:web:inv.example.com");
    resolver.invalidate("did:web:inv.example.com");
    await resolver.resolve("did:web:inv.example.com");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to verificationMethod when no assertionMethod", async () => {
    const mockDoc = {
      id: "did:web:fallback.example.com",
      verificationMethod: [
        {
          id: "did:web:fallback.example.com#key-1",
          type: "JsonWebKey2020",
          publicKeyJwk: {
            kty: "OKP",
            crv: "Ed25519",
            x: "O2onvM62pC1io6jQKm8Nc2UyFXcd4kOmOsBIoYtZ2ik",
          },
        },
      ],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockDoc,
      }),
    );

    const key = await resolver.resolve("did:web:fallback.example.com");
    expect(key).not.toBeNull();
  });
});

describe("DIDResolver trust boundaries", () => {
  const jwk = { kty: "OKP", crv: "Ed25519", x: "O2onvM62pC1io6jQKm8Nc2UyFXcd4kOmOsBIoYtZ2ik" };
  const docFor = (id: string) => ({
    id,
    verificationMethod: [{ id: `${id}#k`, type: "JsonWebKey2020", publicKeyJwk: jwk }],
    assertionMethod: [`${id}#k`],
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not fetch when the host check refuses the host", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const resolver = new DIDResolver({ hostCheck: async () => false });

    expect(await resolver.resolve("did:web:internal.example.com")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a document whose id is not the requested DID", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => docFor("did:web:evil.example.com") }),
    );
    const resolver = new DIDResolver({ hostCheck: async () => true });

    expect(await resolver.resolve("did:web:victim.example.com")).toBeNull();
  });

  it("answers locally hosted DIDs without any network access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const resolver = new DIDResolver({
      localLookup: async (did) => (did === "did:web:localhost%3A3000:collective:a" ? jwk : null),
      hostCheck: async () => false,
    });

    expect(await resolver.resolve("did:web:localhost%3A3000:collective:a")).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores non-Ed25519 keys", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: "did:web:p256.example.com",
          verificationMethod: [
            {
              id: "did:web:p256.example.com#k",
              type: "JsonWebKey2020",
              publicKeyJwk: { kty: "EC", crv: "P-256", x: "AA", y: "AA" },
            },
          ],
        }),
      }),
    );
    const resolver = new DIDResolver({ hostCheck: async () => true });

    expect(await resolver.resolve("did:web:p256.example.com")).toBeNull();
  });

  it("classifies loopback, private, link-local and mapped addresses as non-public", () => {
    for (const addr of [
      "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254",
      "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1",
    ]) {
      expect(isPublicAddress(addr), addr).toBe(false);
    }
    for (const addr of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"]) {
      expect(isPublicAddress(addr), addr).toBe(true);
    }
  });

  it("refuses IP-literal, loopback and non-default-port hosts by default", async () => {
    expect(await isPublicHost("127.0.0.1")).toBe(false);
    expect(await isPublicHost("[::1]")).toBe(false);
    expect(await isPublicHost("169.254.169.254")).toBe(false);
    expect(await isPublicHost("localhost")).toBe(false);
    expect(await isPublicHost("example.com:2019")).toBe(false);
    expect(await isPublicHost("8.8.8.8")).toBe(true);
  });
});
