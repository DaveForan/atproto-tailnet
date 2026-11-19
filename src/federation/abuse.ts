/**
 * @module federation/abuse
 * Rate limiting, replay detection, and pending-request caps for federation
 * endpoints exposed to the internet (ADR-0019 §4).
 */

/** Sliding-window rate limiter keyed by arbitrary string (DID, IP, etc.). */
export class RateLimiter {
  private readonly windowMs: number;
  private readonly maxHits: number;
  private readonly hits = new Map<string, number[]>();

  constructor(windowMs: number, maxHits: number) {
    this.windowMs = windowMs;
    this.maxHits = maxHits;
  }

  check(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    let timestamps = this.hits.get(key);
    if (timestamps) {
      timestamps = timestamps.filter((t) => t > cutoff);
      this.hits.set(key, timestamps);
    } else {
      timestamps = [];
      this.hits.set(key, timestamps);
    }
    if (timestamps.length >= this.maxHits) return false;
    timestamps.push(now);
    return true;
  }

  /** Remove stale entries. Call periodically to prevent unbounded growth. */
  sweep(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, timestamps] of this.hits) {
      const live = timestamps.filter((t) => t > cutoff);
      if (live.length === 0) this.hits.delete(key);
      else this.hits.set(key, live);
    }
  }

  get size(): number {
    return this.hits.size;
  }
}

/**
 * Message-ID replay cache. Remembers IDs for the freshness window so a
 * captured request cannot be replayed within its validity period.
 */
export class ReplayGuard {
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly seen = new Map<string, number>();

  constructor(windowMs: number, maxEntries = 100_000) {
    this.windowMs = windowMs;
    this.maxEntries = maxEntries;
  }

  /**
   * Returns true if this is the first time we've seen `id` in the window.
   * Entries expire via {@link sweep} (run periodically); when the cache is
   * full, the oldest entries are dropped first (Map keeps insertion order).
   */
  check(id: string): boolean {
    const seenAt = this.seen.get(id);
    if (seenAt !== undefined && seenAt >= Date.now() - this.windowMs) return false;
    this.seen.delete(id);
    while (this.seen.size >= this.maxEntries) {
      this.seen.delete(this.seen.keys().next().value!);
    }
    this.seen.set(id, Date.now());
    return true;
  }

  sweep(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [id, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(id);
    }
  }

  get size(): number {
    return this.seen.size;
  }
}

/** Max pending inbound link requests per collective before oldest are expired. */
export const MAX_PENDING_PER_COLLECTIVE = 50;

/** Rate limits for LINK_REQUEST: 10 per minute per sender DID, 30 per minute per IP. */
export const linkRequestByDid = new RateLimiter(60_000, 10);
export const linkRequestByIp = new RateLimiter(60_000, 30);

/** Rate limits for HELLO: 20 per minute per sender DID, 60 per minute per IP. */
export const helloByDid = new RateLimiter(60_000, 20);
export const helloByIp = new RateLimiter(60_000, 60);

/**
 * Replay guard shared by all link negotiation messages, keyed on sender DID +
 * message id. A message is fresh for ±MAX_MESSAGE_SKEW_MS (5 min) around its
 * timestamp — a 10-minute span — so ids are kept for 2× the skew; a shorter
 * window would let a captured message become replayable while still fresh.
 */
export const linkMessageReplay = new ReplayGuard(2 * 5 * 60 * 1000);

/** Max body size for federation messages (64 KiB). */
export const MAX_FEDERATION_BODY_BYTES = 64 * 1024;

let sweepInterval: ReturnType<typeof setInterval> | null = null;

export function startAbuseSweep(): void {
  if (sweepInterval) return;
  sweepInterval = setInterval(() => {
    linkRequestByDid.sweep();
    linkRequestByIp.sweep();
    helloByDid.sweep();
    helloByIp.sweep();
    linkMessageReplay.sweep();
  }, 60_000);
  sweepInterval.unref();
}

export function stopAbuseSweep(): void {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
}
