import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as jose from "jose";
import {
  Secp256k1Keypair,
  P256Keypair,
  formatDidKey,
  parseMultikey,
} from "@atproto/crypto";

vi.mock("../db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
}));

let mockResolveTyped = vi.fn().mockResolvedValue(null);

vi.mock("../identity/resolver.js", () => ({
  getResolver: () => ({
    resolve: vi.fn().mockResolvedValue(null),
    resolveTyped: (...args: unknown[]) => mockResolveTyped(...args),
  }),
}));

import { verifyServiceAuth } from "../credentials/service-auth.js";
import { db } from "../db/index.js";

const AUDIENCE_DID = "did:web:collective.example.com:collective:test";

async function buildServiceAuthJwt(
  keypair: Secp256k1Keypair | P256Keypair,
  issuerDid: string,
  overrides: Record<string, unknown> = {},
) {
  const alg = keypair.jwtAlg;
  const now = Math.floor(Date.now() / 1000);

  const header = { alg, typ: "JWT" };
  const payload = {
    iss: issuerDid,
    aud: `${AUDIENCE_DID}#tailnet_collective`,
    exp: now + 60,
    iat: now,
    jti: `jti-${Math.random().toString(36).slice(2)}`,
    lxm: "app.tailnet.credential.present",
    ...overrides,
  };

  const headerB64 = jose.base64url.encode(
    new TextEncoder().encode(JSON.stringify(header)),
  );
  const payloadB64 = jose.base64url.encode(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = await keypair.sign(signingInput);
  const sigB64 = jose.base64url.encode(sig);

  return `${headerB64}.${payloadB64}.${sigB64}`;
}

function setupResolver(keypair: Secp256k1Keypair | P256Keypair) {
  const multikey = keypair.did().replace("did:key:", "");
  const { jwtAlg, keyBytes } = parseMultikey(multikey);
  const didKey = formatDidKey(jwtAlg, keyBytes);

  const { createPublicKey } = require("node:crypto");
  const uncompressed = keyBytes;
  const x = uncompressed.slice(1, 33);
  const y = uncompressed.slice(33, 65);

  const crv = jwtAlg === "ES256K" ? "secp256k1" : "P-256";
  const jwk = {
    kty: "EC",
    crv,
    x: jose.base64url.encode(x),
    y: jose.base64url.encode(y),
  };
  const key = createPublicKey({ key: jwk, format: "jwk" });

  mockResolveTyped = vi.fn().mockResolvedValue({
    key,
    algorithm: jwtAlg,
    methodId: "#atproto",
    didKey,
  });
}

describe("verifyServiceAuth", () => {
  beforeEach(() => {
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts a valid secp256k1 service-auth token", async () => {
    const kp = await Secp256k1Keypair.create({ exportable: true });
    setupResolver(kp);

    const token = await buildServiceAuthJwt(kp, "did:plc:test-user");
    const result = await verifyServiceAuth(token, AUDIENCE_DID);

    expect(result.valid).toBe(true);
    expect(result.issuerDid).toBe("did:plc:test-user");
  });

  it("accepts a valid P-256 service-auth token", async () => {
    const kp = await P256Keypair.create({ exportable: true });
    setupResolver(kp);

    const token = await buildServiceAuthJwt(kp, "did:plc:p256-user");
    const result = await verifyServiceAuth(token, AUDIENCE_DID);

    expect(result.valid).toBe(true);
    expect(result.issuerDid).toBe("did:plc:p256-user");
  });

  it("rejects wrong audience", async () => {
    const kp = await Secp256k1Keypair.create({ exportable: true });
    setupResolver(kp);

    const token = await buildServiceAuthJwt(kp, "did:plc:test-user", {
      aud: "did:web:evil.com#tailnet_collective",
    });
    const result = await verifyServiceAuth(token, AUDIENCE_DID);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("Audience mismatch");
  });

  it("rejects expired token", async () => {
    const kp = await Secp256k1Keypair.create({ exportable: true });
    setupResolver(kp);

    const token = await buildServiceAuthJwt(kp, "did:plc:test-user", {
      exp: Math.floor(Date.now() / 1000) - 10,
    });
    const result = await verifyServiceAuth(token, AUDIENCE_DID);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("expired");
  });

  it("rejects token with exp too far in future", async () => {
    const kp = await Secp256k1Keypair.create({ exportable: true });
    setupResolver(kp);

    const token = await buildServiceAuthJwt(kp, "did:plc:test-user", {
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    const result = await verifyServiceAuth(token, AUDIENCE_DID);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("too far in the future");
  });

  it("rejects wrong lxm", async () => {
    const kp = await Secp256k1Keypair.create({ exportable: true });
    setupResolver(kp);

    const token = await buildServiceAuthJwt(kp, "did:plc:test-user", {
      lxm: "com.atproto.repo.createRecord",
    });
    const result = await verifyServiceAuth(token, AUDIENCE_DID);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid lxm");
  });

  it("rejects missing jti", async () => {
    const kp = await Secp256k1Keypair.create({ exportable: true });
    setupResolver(kp);

    const token = await buildServiceAuthJwt(kp, "did:plc:test-user", {
      jti: undefined,
    });
    const result = await verifyServiceAuth(token, AUDIENCE_DID);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("Missing jti");
  });

  it("rejects replayed jti (duplicate insert)", async () => {
    const kp = await Secp256k1Keypair.create({ exportable: true });
    setupResolver(kp);

    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockRejectedValue({ code: "23505" }),
    } as any);

    const token = await buildServiceAuthJwt(kp, "did:plc:test-user");
    const result = await verifyServiceAuth(token, AUDIENCE_DID);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("replay");
  });

  it("rejects unsupported algorithm", async () => {
    const result = await verifyServiceAuth(
      "eyJhbGciOiJFZERTQSJ9.eyJpc3MiOiJkaWQ6cGxjOnRlc3QifQ.AAAA",
      AUDIENCE_DID,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unsupported algorithm");
  });

  it("rejects unresolvable issuer", async () => {
    const kp = await Secp256k1Keypair.create({ exportable: true });
    mockResolveTyped = vi.fn().mockResolvedValue(null);

    const token = await buildServiceAuthJwt(kp, "did:plc:unknown");
    const result = await verifyServiceAuth(token, AUDIENCE_DID);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("Cannot resolve");
  });
});
