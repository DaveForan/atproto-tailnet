import { describe, it, expect, vi, afterEach } from "vitest";
import { discoverPeer, isAllowedBrokerUrl } from "../federation/discovery.js";

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
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          collectiveDid: "did:web:remote.example.com:collective:test",
          brokerUrl: "https://remote.example.com",
          cfpVersions: ["1.0.0"],
          federationPolicy: "selective",
          capabilities: ["route-exchange"],
          derpEndpoints: [],
          signature: "",
        }),
      }),
    );

    const result = await discoverPeer("test@remote.example.com");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.peer.did).toBe("did:web:remote.example.com:collective:test");
      expect(result.peer.brokerUrl).toBe("https://remote.example.com");
      expect(result.peer.name).toBe("test");
    }
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
    if (!result.ok) expect(result.error).toContain("ECONNREFUSED");
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
});

describe("isAllowedBrokerUrl", () => {
  it("allows HTTPS URLs with public hosts", () => {
    expect(isAllowedBrokerUrl("https://remote.example.com")).toBe(true);
  });

  it("rejects HTTP URLs to external hosts", () => {
    expect(isAllowedBrokerUrl("http://remote.example.com")).toBe(false);
  });

  it("rejects URLs to private IPs", () => {
    expect(isAllowedBrokerUrl("https://10.0.0.1")).toBe(false);
    expect(isAllowedBrokerUrl("https://172.16.0.1")).toBe(false);
    expect(isAllowedBrokerUrl("https://192.168.1.1")).toBe(false);
  });

  it("rejects non-URL strings", () => {
    expect(isAllowedBrokerUrl("not a url")).toBe(false);
  });
});
