/** One DID document fetch path for the resolver and handle lookup. */
import { describe, it, expect, vi, afterEach } from "vitest";
import https from "node:https";

const dnsMock = vi.hoisted(() => ({
  lookup: vi.fn(),
  resolveTxt: vi.fn(),
}));
vi.mock("node:dns/promises", () => ({ ...dnsMock, default: dnsMock }));
vi.mock("../db/index.js", () => ({ db: {}, pool: {} }));

import { DIDResolver, fetchDidDocument } from "../identity/resolver.js";
import { lookupVerifiedHandle } from "../identity/handles.js";

const PLC_DID = "did:plc:abcdefghijklmnopqrstuvwx";
const jwk = { kty: "OKP", crv: "Ed25519", x: "O2onvM62pC1io6jQKm8Nc2UyFXcd4kOmOsBIoYtZ2ik" };
const plcDoc = {
  id: PLC_DID,
  alsoKnownAs: ["at://alice.example.com"],
  verificationMethod: [{ id: `${PLC_DID}#k`, type: "JsonWebKey2020", publicKeyJwk: jwk }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  dnsMock.lookup.mockReset();
  dnsMock.resolveTxt.mockReset();
});

describe("fetchDidDocument", () => {
  it("fetches did:plc from the PLC directory with no redirects", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => plcDoc });
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchDidDocument(PLC_DID)).toEqual(plcDoc);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://plc.directory/${encodeURIComponent(PLC_DID)}`);
    expect(init.redirect).toBe("error");
    expect(init.headers.Accept).toContain("application/did+json");
  });

  it("returns null and never throws on failure or a non-object body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }));
    expect(await fetchDidDocument(PLC_DID)).toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await fetchDidDocument(PLC_DID)).toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => null }));
    expect(await fetchDidDocument(PLC_DID)).toBeNull();
  });

  it("refuses unsupported DID methods without network access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchDidDocument("did:key:z6MkpTHR8VNs64")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is the path DIDResolver.resolve uses for did:plc", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => plcDoc });
    vi.stubGlobal("fetch", fetchMock);

    expect(await new DIDResolver().resolve(PLC_DID)).not.toBeNull();
    expect(fetchMock.mock.calls[0][0]).toBe(`https://plc.directory/${encodeURIComponent(PLC_DID)}`);
  });
});

describe("lookupVerifiedHandle uses the shared fetch", () => {
  it("reads a did:plc handle from the PLC directory", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => plcDoc });
    vi.stubGlobal("fetch", fetchMock);
    dnsMock.resolveTxt.mockResolvedValue([[`did=${PLC_DID}`]]);

    expect(await lookupVerifiedHandle(PLC_DID)).toBe("alice.example.com");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://plc.directory/${encodeURIComponent(PLC_DID)}`);
    expect(init.headers.Accept).toContain("application/did+json");
  });

  it("refuses a did:web host that resolves to a private address (SSRF)", async () => {
    dnsMock.lookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    const requestSpy = vi.spyOn(https, "request");
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    expect(await lookupVerifiedHandle("did:web:internal.example.com")).toBeNull();
    expect(dnsMock.lookup).toHaveBeenCalledWith("internal.example.com", { all: true });
    expect(requestSpy).not.toHaveBeenCalled();
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain("internal.example.com/");
      expect(String(url)).toMatch(/^https:\/\/public\.api\.bsky\.app\//);
    }
  });

  it("refuses a did:web host on a non-default port before any lookup", async () => {
    const requestSpy = vi.spyOn(https, "request");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }));

    expect(await lookupVerifiedHandle("did:web:example.com%3A2019")).toBeNull();
    expect(dnsMock.lookup).not.toHaveBeenCalled();
    expect(requestSpy).not.toHaveBeenCalled();
  });
});
