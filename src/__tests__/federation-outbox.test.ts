import { describe, it, expect } from "vitest";
import {
  OUTBOX_MAX_ATTEMPTS,
  afterAttempt,
  classifyDelivery,
  isDue,
  newOutboxEntry,
  outboxRetryDelayMs,
  outboxStatus,
  parseOutboxEntry,
  type UnsignedLinkMessage,
} from "../federation/outbox.js";
import { messageEndpoint } from "../federation/transport.js";

const revoke: UnsignedLinkMessage = {
  type: "LINK_REVOKE",
  messageId: "m-1",
  collectiveDid: "did:web:a.example:collective:a",
  reason: "revoked by operator",
  permanent: true,
};

describe("link message outbox", () => {
  const t0 = Date.parse("2026-11-19T12:00:00.000Z");

  it("routes LINK_* messages to their kebab-case endpoints", () => {
    expect(messageEndpoint("LINK_REQUEST")).toBe("link-request");
    expect(messageEndpoint("LINK_REVOKE")).toBe("link-revoke");
    expect(messageEndpoint("HELLO")).toBe("hello");
  });

  it("classifies send results", () => {
    expect(classifyDelivery("LINK_REQUEST", { ok: true, status: 201 })).toBe("delivered");
    // Already processed (replay guard) or link already exists: it arrived earlier.
    expect(classifyDelivery("LINK_ACCEPT", { ok: false, status: 409 })).toBe("delivered");
    // Nothing left to revoke on the peer.
    expect(classifyDelivery("LINK_REVOKE", { ok: false, status: 404 })).toBe("delivered");
    expect(classifyDelivery("LINK_ACCEPT", { ok: false, status: 404 })).toBe("failed");
    expect(classifyDelivery("LINK_REQUEST", { ok: false })).toBe("retry");
    expect(classifyDelivery("LINK_REQUEST", { ok: false, status: 503 })).toBe("retry");
    expect(classifyDelivery("LINK_REQUEST", { ok: false, status: 429 })).toBe("retry");
    expect(classifyDelivery("LINK_REQUEST", { ok: false, status: 403 })).toBe("retry");
    expect(classifyDelivery("LINK_REQUEST", { ok: false, status: 400 })).toBe("failed");
  });

  it("is due immediately, then backs off, then gives up", () => {
    const entry = newOutboxEntry(revoke, "did:web:b.example:collective:b", "https://b.example", "user-1", t0);
    expect(isDue(entry, t0)).toBe(true);

    const retried = afterAttempt(entry, "retry", "HTTP 503", t0, () => 0.5)!;
    expect(retried.attempts).toBe(1);
    expect(retried.lastError).toBe("HTTP 503");
    expect(Date.parse(retried.nextAttemptAt)).toBe(t0 + 30_000);
    expect(isDue(retried, t0 + 29_999)).toBe(false);
    expect(isDue(retried, t0 + 30_000)).toBe(true);

    let e = retried;
    while (e.attempts < OUTBOX_MAX_ATTEMPTS - 1) e = afterAttempt(e, "retry", "timeout", t0)!;
    const exhausted = afterAttempt(e, "retry", "timeout", t0)!;
    expect(exhausted.failedAt).not.toBeNull();
    expect(isDue(exhausted, t0 + 1e12)).toBe(false);

    expect(afterAttempt(entry, "delivered", null, t0)).toBeNull();
    expect(afterAttempt(entry, "failed", "HTTP 400", t0)!.failedAt).not.toBeNull();
  });

  it("caps the backoff at 30 minutes", () => {
    expect(outboxRetryDelayMs(1, () => 0.5)).toBe(30_000);
    expect(outboxRetryDelayMs(3, () => 0.5)).toBe(120_000);
    expect(outboxRetryDelayMs(40, () => 0.5)).toBe(30 * 60_000);
  });

  it("round-trips through the jsonb column and rejects junk", () => {
    const entry = newOutboxEntry(revoke, "did:web:b.example:collective:b", "https://b.example", null, t0);
    expect(parseOutboxEntry(JSON.parse(JSON.stringify(entry)))).toEqual(entry);
    expect(parseOutboxEntry(null)).toBeNull();
    expect(parseOutboxEntry({ message: { type: "HELLO", messageId: "x" } })).toBeNull();
    expect(outboxStatus(entry)).toEqual({
      messageType: "LINK_REVOKE",
      state: "pending",
      attempts: 0,
      nextAttemptAt: entry.nextAttemptAt,
      lastError: null,
    });
  });
});
