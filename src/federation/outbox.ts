/**
 * @module federation/outbox
 * Retry bookkeeping for cross-instance link messages (ADR-0019 §2). Pure: orchestrator/federation-broker.ts does the I/O.
 * Entries are stored unsigned. Each attempt re-signs with a fresh timestamp under the same `messageId`.
 */

import type {
  LinkAcceptMessage,
  LinkRejectMessage,
  LinkRequestMessage,
  LinkRevokeMessage,
} from "./protocol.js";

export type LinkMessage = LinkRequestMessage | LinkAcceptMessage | LinkRejectMessage | LinkRevokeMessage;
export type LinkMessageType = LinkMessage["type"];

type Unsigned<T> = T extends unknown ? Omit<T, "signature" | "timestamp"> : never;
/** A link message as queued: everything but `signature` and `timestamp`. */
export type UnsignedLinkMessage = Unsigned<LinkMessage>;

export interface OutboxEntry {
  message: UnsignedLinkMessage;
  /** Collective DID the message is addressed to (CFP-Recipient). */
  recipientDid: string;
  /** Peer broker base URL; re-checked with isAllowedBrokerUrl before every send. */
  brokerUrl: string;
  /** Operator whose action queued the message (audit actor), if any. */
  actorUserId: string | null;
  attempts: number;
  queuedAt: string;
  nextAttemptAt: string;
  lastError: string | null;
  /** Set when delivery was abandoned; the entry stays visible until replaced. */
  failedAt: string | null;
}

/** Give up after this many attempts (~13h with the 30-minute backoff cap). */
export const OUTBOX_MAX_ATTEMPTS = 30;

const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 30 * 60_000;

/** Delay before attempt `attempts + 1`: 30s, 60s, … capped at 30 min, ±20% jitter. */
export function outboxRetryDelayMs(attempts: number, random: () => number = Math.random): number {
  const exp = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
  return Math.round(exp * (0.8 + 0.4 * random()));
}

export function newOutboxEntry(
  message: UnsignedLinkMessage,
  recipientDid: string,
  brokerUrl: string,
  actorUserId: string | null,
  now: number = Date.now(),
): OutboxEntry {
  const ts = new Date(now).toISOString();
  return {
    message,
    recipientDid,
    brokerUrl,
    actorUserId,
    attempts: 0,
    queuedAt: ts,
    nextAttemptAt: ts,
    lastError: null,
    failedAt: null,
  };
}

const LINK_TYPES = new Set<string>(["LINK_REQUEST", "LINK_ACCEPT", "LINK_REJECT", "LINK_REVOKE"]);

/** Validate a stored `outbox` value; null when absent or malformed. */
export function parseOutboxEntry(raw: unknown): OutboxEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Partial<OutboxEntry>;
  const m = e.message as { type?: unknown; messageId?: unknown } | undefined;
  if (
    !m ||
    typeof m.type !== "string" ||
    !LINK_TYPES.has(m.type) ||
    typeof m.messageId !== "string" ||
    typeof e.recipientDid !== "string" ||
    typeof e.brokerUrl !== "string" ||
    typeof e.attempts !== "number" ||
    typeof e.nextAttemptAt !== "string"
  ) {
    return null;
  }
  return {
    message: e.message as UnsignedLinkMessage,
    recipientDid: e.recipientDid,
    brokerUrl: e.brokerUrl,
    actorUserId: typeof e.actorUserId === "string" ? e.actorUserId : null,
    attempts: e.attempts,
    queuedAt: typeof e.queuedAt === "string" ? e.queuedAt : e.nextAttemptAt,
    nextAttemptAt: e.nextAttemptAt,
    lastError: typeof e.lastError === "string" ? e.lastError : null,
    failedAt: typeof e.failedAt === "string" ? e.failedAt : null,
  };
}

export function isDue(entry: OutboxEntry, now: number = Date.now()): boolean {
  return entry.failedAt === null && Date.parse(entry.nextAttemptAt) <= now;
}

export type DeliveryOutcome = "delivered" | "retry" | "failed";

/**
 * Maps a send result to an outcome.
 * Delivered: 2xx, 409 (peer already has it), 404 on LINK_REVOKE (no live link left).
 * Retry: no status, 403 (peer may not resolve our DID yet), 408, 425, 429, 5xx.
 * Failed: any other 4xx.
 */
export function classifyDelivery(
  type: LinkMessageType,
  result: { ok: boolean; status?: number },
): DeliveryOutcome {
  if (result.ok) return "delivered";
  const status = result.status;
  if (status === undefined) return "retry";
  if (status === 409) return "delivered";
  if (status === 404 && type === "LINK_REVOKE") return "delivered";
  if (status === 408 || status === 425 || status === 429 || status === 403 || status >= 500) return "retry";
  return "failed";
}

/**
 * The entry after an attempt: null once delivered, otherwise the updated
 * entry (rescheduled, or marked failed when refused or out of attempts).
 */
export function afterAttempt(
  entry: OutboxEntry,
  outcome: DeliveryOutcome,
  error: string | null,
  now: number = Date.now(),
  random: () => number = Math.random,
): OutboxEntry | null {
  if (outcome === "delivered") return null;
  const attempts = entry.attempts + 1;
  const failed = outcome === "failed" || attempts >= OUTBOX_MAX_ATTEMPTS;
  return {
    ...entry,
    attempts,
    lastError: error,
    nextAttemptAt: new Date(now + (failed ? 0 : outboxRetryDelayMs(attempts, random))).toISOString(),
    failedAt: failed ? new Date(now).toISOString() : null,
  };
}

/** Dashboard view of an outbox entry. */
export function outboxStatus(raw: unknown): {
  messageType: LinkMessageType;
  state: "pending" | "failed";
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
} | null {
  const entry = parseOutboxEntry(raw);
  if (!entry) return null;
  return {
    messageType: entry.message.type,
    state: entry.failedAt ? "failed" : "pending",
    attempts: entry.attempts,
    nextAttemptAt: entry.failedAt ? null : entry.nextAttemptAt,
    lastError: entry.lastError,
  };
}
