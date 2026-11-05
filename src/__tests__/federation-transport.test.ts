import { describe, it, expect, vi, afterEach } from "vitest";
import { sendMessage, sendKeepalive, sendRevoke } from "../federation/transport.js";
import type { KeepaliveMessage, RevokeMessage, HelloMessage } from "../federation/protocol.js";

describe("federation transport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a message and returns the response", async () => {
    const responseBody = { type: "CHALLENGE", collectiveDid: "did:web:b.example.com" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => responseBody,
      }),
    );

    const hello: HelloMessage = {
      type: "HELLO",
      collectiveDid: "did:web:a.example.com",
      federationType: "peer",
      offeredCidrs: ["10.0.0.0/24"],
      capabilities: ["route-exchange"],
      protocolVersion: "1.0.0",
      signature: "sig",
      timestamp: new Date().toISOString(),
    };

    const result = await sendMessage("https://remote.example.com", hello, "did:web:b.example.com");
    expect(result.ok).toBe(true);
    expect(result.response).toEqual(responseBody);
    expect(fetch).toHaveBeenCalledWith(
      "https://remote.example.com/api/federation/messages/hello",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CFP-Recipient": "did:web:b.example.com",
        },
      }),
    );
  });

  it("returns error on HTTP failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => "Forbidden",
      }),
    );

    const result = await sendMessage("https://remote.example.com", {
      type: "HELLO",
      collectiveDid: "did:web:a.example.com",
      federationType: "peer",
      offeredCidrs: [],
      capabilities: [],
      protocolVersion: "1.0.0",
      signature: "sig",
      timestamp: new Date().toISOString(),
    } as HelloMessage, "did:web:b.example.com");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("403");
  });

  it("returns error on network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Connection refused")),
    );

    const result = await sendMessage("https://unreachable.example.com", {
      type: "HELLO",
      collectiveDid: "did:web:a.example.com",
      federationType: "peer",
      offeredCidrs: [],
      capabilities: [],
      protocolVersion: "1.0.0",
      signature: "sig",
      timestamp: new Date().toISOString(),
    } as HelloMessage, "did:web:b.example.com");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Connection refused");
  });

  it("sendKeepalive returns true on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ type: "KEEPALIVE", sessionId: "s1" }),
      }),
    );

    const keepalive: KeepaliveMessage = {
      type: "KEEPALIVE",
      sessionId: "s1",
      sequenceNumber: 1,
      timestamp: new Date().toISOString(),
    };

    const ok = await sendKeepalive("https://remote.example.com", keepalive, "did:web:b.example.com");
    expect(ok).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "https://remote.example.com/api/federation/messages/keepalive",
      expect.any(Object),
    );
  });

  it("sendKeepalive returns false on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => "Not found",
      }),
    );

    const ok = await sendKeepalive("https://remote.example.com", {
      type: "KEEPALIVE",
      sessionId: "nonexistent",
      sequenceNumber: 1,
      timestamp: new Date().toISOString(),
    }, "did:web:b.example.com");
    expect(ok).toBe(false);
  });

  it("sendRevoke returns true on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: "revoked" }),
      }),
    );

    const revoke: RevokeMessage = {
      type: "REVOKE",
      sessionId: "s1",
      reason: "admin teardown",
      permanent: true,
      signature: "sig",
      timestamp: new Date().toISOString(),
    };

    const ok = await sendRevoke("https://remote.example.com", revoke, "did:web:b.example.com");
    expect(ok).toBe(true);
  });

  it("sendRevoke returns false on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("timeout")),
    );

    const ok = await sendRevoke("https://remote.example.com", {
      type: "REVOKE",
      sessionId: "s1",
      reason: "test",
      permanent: false,
      signature: "sig",
      timestamp: new Date().toISOString(),
    }, "did:web:b.example.com");
    expect(ok).toBe(false);
  });
});
