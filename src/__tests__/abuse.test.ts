import { describe, it, expect, beforeEach } from "vitest";
import { RateLimiter, ReplayGuard } from "../federation/abuse.js";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(1000, 3);
  });

  it("allows requests up to the limit", () => {
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("a")).toBe(true);
  });

  it("rejects requests beyond the limit", () => {
    limiter.check("a");
    limiter.check("a");
    limiter.check("a");
    expect(limiter.check("a")).toBe(false);
  });

  it("tracks keys independently", () => {
    limiter.check("a");
    limiter.check("a");
    limiter.check("a");
    expect(limiter.check("a")).toBe(false);
    expect(limiter.check("b")).toBe(true);
  });

  it("sweep removes stale entries", () => {
    const old = new RateLimiter(0, 3);
    old.check("a");
    old.sweep();
    expect(old.size).toBe(0);
  });
});

describe("ReplayGuard", () => {
  let guard: ReplayGuard;

  beforeEach(() => {
    guard = new ReplayGuard(1000);
  });

  it("allows first occurrence of an ID", () => {
    expect(guard.check("msg-1")).toBe(true);
  });

  it("rejects duplicate ID within window", () => {
    guard.check("msg-1");
    expect(guard.check("msg-1")).toBe(false);
  });

  it("tracks different IDs independently", () => {
    guard.check("msg-1");
    expect(guard.check("msg-2")).toBe(true);
  });

  it("sweep removes stale entries", () => {
    const old = new ReplayGuard(1);
    old.check("msg-1");
    // Manually poke the internal map to backdate the timestamp
    (old as any).seen.set("msg-1", Date.now() - 100);
    old.sweep();
    expect(old.size).toBe(0);
  });
});
