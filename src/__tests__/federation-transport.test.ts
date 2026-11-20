import { describe, it, expect, vi, afterEach } from "vitest";
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
    // The peer's body never reaches our error text
    expect(result.error).not.toContain("Forbidden");
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
    // A short, sanitized reason only
    expect(result.error).toBe("unreachable");
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

  it("a peer URL goes through the connect-time guarded request, not a plain fetch", async () => {
    const plain = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", plain);
    guardedRequest.mockClear();
    guardedRequest.mockResolvedValueOnce({ ok: true, status: 200, text: "{}" });
    const ok = await sendKeepalive("https://peer.example.net", { type: "KEEPALIVE", sessionId: "s", sequenceNumber: 1, timestamp: new Date().toISOString() }, "did:web:b");
    expect(ok).toBe(true);
    expect(guardedRequest).toHaveBeenCalledWith(
      "https://peer.example.net/api/federation/messages/keepalive",
      expect.objectContaining({ method: "POST", maxBytes: expect.any(Number) }),
    );
    expect(plain).not.toHaveBeenCalled();
  });

  it("a peer that resolves to a private address at connect time is refused with a short reason", async () => {
    guardedRequest.mockRejectedValueOnce(Object.assign(new Error("Host resolves to a non-public address"), { code: "EPRIVATE" }));
    const r = await sendMessage("https://rebind.example.net", { type: "KEEPALIVE", sessionId: "s", sequenceNumber: 1, timestamp: new Date().toISOString() } as never, "did:web:b");
    expect(r).toEqual({ ok: false, error: "address not allowed" });
  });
});
