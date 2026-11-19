import { describe, it, expect, vi } from "vitest";
import * as jose from "jose";
import { JoseKey } from "@atproto/oauth-client-node";

vi.mock("../db/index.js", () => ({ db: {} }));

describe("atprotoKeyId", () => {
  it("uses the JWK's own kid so the key imports and keeps that kid", async () => {
    const { atprotoKeyId } = await import("../auth/atproto.js");
    const { privateKey } = await jose.generateKeyPair("ES256", { extractable: true });
    const jwk = { ...(await jose.exportJWK(privateKey)), kid: "prod-2026" };
    const keyStr = JSON.stringify(jwk);
    expect(atprotoKeyId(keyStr)).toBe("prod-2026");
    const key = await JoseKey.fromImportable(keyStr, atprotoKeyId(keyStr));
    expect(key.publicJwk?.kid).toBe("prod-2026");
  });

  it("defaults to key1 when the JWK has no kid or is not JSON", async () => {
    const { atprotoKeyId } = await import("../auth/atproto.js");
    expect(atprotoKeyId(JSON.stringify({ kty: "EC" }))).toBe("key1");
    expect(atprotoKeyId("-----BEGIN PRIVATE KEY-----")).toBe("key1");
    expect(atprotoKeyId(undefined)).toBe("key1");
  });
});
