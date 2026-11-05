/**
 * @module federation/auth
 * Message authentication for CFP over HTTP (ADR-0016): what gets signed, how a
 * peer's signature is checked, and which announced routes may be imported.
 * Pure — the DB-backed pieces (keys, link lookup) are injected by the broker.
 */

import type { PublicKeyResolver } from "../credentials/verifier.js";
import { verifyDetached } from "../identity/keys.js";
import type { HandshakeCallbacks } from "./handshake.js";
import type { FederationType, RouteAnnouncement } from "./protocol.js";

/** Reject signed messages whose timestamp is further than this from now. */
export const MAX_MESSAGE_SKEW_MS = 5 * 60 * 1000;

/**
 * Canonical signing payload of a CFP message: the message minus its
 * `signature` field, in transmitted key order. Matches what
 * `federation/handshake.ts` signs for HELLO / CHALLENGE / ESTABLISHED.
 */
export function signedPayload(message: object): string {
  return JSON.stringify({ ...message, signature: undefined });
}

/** Sign a message that has no `signature` yet and return it with one appended. */
export async function signMessage<T extends object>(
  message: T,
  sign: (payload: string) => Promise<string>,
): Promise<T & { signature: string }> {
  const signature = await sign(JSON.stringify(message));
  return { ...message, signature };
}

/** True when `message.signature` is `did`'s signature over the rest of the message. */
export async function verifyMessage(
  resolver: PublicKeyResolver,
  did: string,
  message: object,
): Promise<boolean> {
  const { signature } = message as { signature?: unknown };
  if (typeof signature !== "string" || !signature) return false;
  const publicKey = await resolver.resolve(did);
  if (!publicKey) return false;
  return verifyDetached(publicKey, signedPayload(message), signature);
}

export function isFresh(timestamp: string, now = Date.now()): boolean {
  const t = Date.parse(timestamp);
  return Number.isFinite(t) && Math.abs(now - t) <= MAX_MESSAGE_SKEW_MS;
}

/**
 * Prefixes we accept from a peer's announcements: only CIDRs the link's
 * operators agreed to share, and only when the peer claims to originate them.
 * Anything else (a wider prefix, a default route, someone else's network) is
 * dropped — a peer must not be able to attract traffic it wasn't granted.
 */
export function filterImportedPrefixes(
  announcements: RouteAnnouncement[] | undefined,
  agreedCidrs: string[],
  peerDid: string,
): string[] {
  const agreed = new Set(agreedCidrs);
  const accepted = new Set<string>();
  for (const a of announcements ?? []) {
    if (a.originDid === peerDid && agreed.has(a.prefix)) accepted.add(a.prefix);
  }
  return [...accepted];
}

/** Announcements for the CIDRs this side shares on a link. */
export async function buildAnnouncements(
  localDid: string,
  cidrs: string[],
  sign: (payload: string) => Promise<string>,
): Promise<RouteAnnouncement[]> {
  return Promise.all(
    cidrs.map(async (prefix) => ({
      prefix,
      originDid: localDid,
      pathVector: [localDid],
      preference: 100,
      originSignature: await sign(JSON.stringify({ prefix, originDid: localDid })),
    })),
  );
}

export function makeHandshakeCallbacks(opts: {
  sign: (payload: string) => Promise<string>;
  resolver: PublicKeyResolver;
  /** Decide whether `remoteDid` may federate with us (e.g. an active link exists). */
  evaluatePolicy: (remoteDid: string, type: FederationType) => Promise<boolean>;
  routes: RouteAnnouncement[];
}): HandshakeCallbacks {
  return {
    sign: opts.sign,
    async verifySignature(did, payload, signature) {
      const publicKey = await opts.resolver.resolve(did);
      if (!publicKey) return false;
      return verifyDetached(publicKey, payload, signature);
    },
    evaluatePolicy: opts.evaluatePolicy,
    getLocalRoutes: () => opts.routes,
  };
}
