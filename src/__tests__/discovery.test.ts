import { describe, it, expect, vi, afterEach } from "vitest";

// Broker hosts are resolved via DNS; give the test names fixed answers.
const DNS: Record<string, string> = {
  "remote.example.com": "93.184.216.34",
  "unreachable.example.com": "93.184.216.35",
  "partial.example.com": "93.184.216.36",
  "rebind.example.com": "10.0.0.5",
  "cgnat.example.com": "100.64.3.4",
  "mapped.example.com": "::ffff:127.0.0.1",
  "ula.example.com": "fd12::1",
};
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (host: string) => {
    const address = DNS[host];
    if (!address) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return [{ address, family: address.includes(":") ? 6 : 4 }];
  }),
}));

// Peer URLs go through the connect-time guarded request; route it to the
// stubbed global fetch so these tests can fake the peer.
const { guardedRequest } = vi.hoisted(() => ({
  guardedRequest: vi.fn(async (url: string, opts: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const r = (await fetch(url, { method: opts.method ?? "GET", headers: opts.headers, body: opts.body })) as unknown as {
      ok: boolean; status?: number; json?: () => Promise<unknown>; text?: () => Promise<string>;
    };
    if (!r.ok) return { ok: false, status: r.status ?? 500, text: "" };
    return { ok: true, status: r.status ?? 200, text: r.json ? JSON.stringify(await r.json()) : await r.text!() };
  }),
}));
vi.mock("../identity/resolver.js", async (orig) => ({
  ...(await orig<typeof import("../identity/resolver.js")>()),
  guardedRequest,
}));

import * as crypto from "node:crypto";
import { discoverPeer, isAllowedBrokerUrl } from "../federation/discovery.js";
import { signedPayload } from "../federation/auth.js";
import { signDetached } from "../identity/keys.js";
import type { PublicKeyResolver } from "../credentials/verifier.js";

describe("discoverPeer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects address without @ separator", async () => {
    const result = await discoverPeer("just-a-slug");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("slug@host");
  });

  it("rejects empty slug or host", async () => {
    const r1 = await discoverPeer("@host.example.com");
    expect(r1.ok).toBe(false);

    const r2 = await discoverPeer("slug@");
    expect(r2.ok).toBe(false);
  });

  it("rejects private/loopback hosts", async () => {
    const result = await discoverPeer("test@192.168.1.1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not allowed");
  });

  it("fetches discovery document and extracts peer info", async () => {
    const did = "did:web:remote.example.com:collective:test";
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const unsigned = {
      collectiveDid: did,
      brokerUrl: "https://remote.example.com",
      cfpVersions: ["1.0.0"],
      federationPolicy: "selective",
      capabilities: ["route-exchange"],
      derpEndpoints: [],
    };
    const descriptor = { ...unsigned, signature: signDetached(privateKey, signedPayload(unsigned)) };
    const resolver: PublicKeyResolver = { resolve: async (d) => (d === did ? publicKey : null) };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => descriptor }),
    );

    const result = await discoverPeer("test@remote.example.com", resolver);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.peer.did).toBe(did);
      expect(result.peer.brokerUrl).toBe("https://remote.example.com");
      expect(result.peer.name).toBe("test");
    }

    // A descriptor whose broker URL was swapped after signing is refused,
    // as is an unsigned one.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...descriptor, brokerUrl: "https://evil.example.com" }) }),
    );
    const tampered = await discoverPeer("test@remote.example.com", resolver);
    expect(tampered.ok).toBe(false);
    if (!tampered.ok) expect(tampered.error).toContain("signature");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...descriptor, signature: "" }) }),
    );
    expect((await discoverPeer("test@remote.example.com", resolver)).ok).toBe(false);
  });

  it("rejects peer with closed federation policy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          collectiveDid: "did:web:closed.example.com",
          brokerUrl: "https://closed.example.com",
          federationPolicy: "closed",
          capabilities: [],
          derpEndpoints: [],
          signature: "",
        }),
      }),
    );

    const result = await discoverPeer("closed@closed.example.com");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("closed");
  });

  it("returns error when fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    );

    const result = await discoverPeer("unreachable@unreachable.example.com");
    expect(result.ok).toBe(false);
    // A short, sanitized reason, never the raw error
    if (!result.ok) expect(result.error).toBe("Discovery failed: unreachable");
  });

  it("returns error when HTTP status is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }),
    );

    const result = await discoverPeer("missing@remote.example.com");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("404");
  });

  it("rejects incomplete discovery document", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ collectiveDid: "did:web:partial.example.com" }),
      }),
    );

    const result = await discoverPeer("partial@partial.example.com");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Incomplete");
  });

  it("fetches the descriptor through the connect-time guarded request", async () => {
    guardedRequest.mockClear();
    guardedRequest.mockRejectedValueOnce(Object.assign(new Error("Host resolves to a non-public address"), { code: "EPRIVATE" }));
    const result = await discoverPeer("test@remote.example.com");
    expect(guardedRequest).toHaveBeenCalledWith(
      "https://remote.example.com/.well-known/collective-federation?collective=test",
      expect.objectContaining({ maxBytes: expect.any(Number) }),
    );
    expect(result).toEqual({ ok: false, error: "Discovery failed: address not allowed" });
  });
});

describe("isAllowedBrokerUrl", () => {
  it("allows HTTPS URLs with public hosts", async () => {
    expect(await isAllowedBrokerUrl("https://remote.example.com")).toBe(true);
  });

  it("rejects HTTP URLs to external hosts", async () => {
    expect(await isAllowedBrokerUrl("http://remote.example.com")).toBe(false);
  });

  it("rejects URLs to private IPs", async () => {
    expect(await isAllowedBrokerUrl("https://10.0.0.1")).toBe(false);
    expect(await isAllowedBrokerUrl("https://172.16.0.1")).toBe(false);
    expect(await isAllowedBrokerUrl("https://192.168.1.1")).toBe(false);
  });

  it("rejects CGNAT, unspecified, ULA and IPv4-mapped literals", async () => {
    expect(await isAllowedBrokerUrl("https://100.64.0.1")).toBe(false);
    expect(await isAllowedBrokerUrl("https://0.0.0.0")).toBe(false);
    expect(await isAllowedBrokerUrl("https://[fd00::1]")).toBe(false);
    expect(await isAllowedBrokerUrl("https://[::ffff:127.0.0.1]")).toBe(false);
    expect(await isAllowedBrokerUrl("https://[::ffff:a00:1]")).toBe(false);
  });

  it("rejects names that resolve to non-public addresses, or do not resolve", async () => {
    expect(await isAllowedBrokerUrl("https://rebind.example.com")).toBe(false);
    expect(await isAllowedBrokerUrl("https://cgnat.example.com")).toBe(false);
    expect(await isAllowedBrokerUrl("https://mapped.example.com")).toBe(false);
    expect(await isAllowedBrokerUrl("https://ula.example.com")).toBe(false);
    expect(await isAllowedBrokerUrl("https://nxdomain.example.com")).toBe(false);
  });

  it("rejects non-URL strings and URLs with credentials", async () => {
    expect(await isAllowedBrokerUrl("not a url")).toBe(false);
    expect(await isAllowedBrokerUrl("https://user:pw@remote.example.com")).toBe(false);
  });
});
