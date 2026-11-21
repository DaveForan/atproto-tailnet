/**
 * @module federation/auth
 * CFP message authentication over HTTP (ADR-0016): signing payload, signature check, route import filter.
 * Pure: the broker injects the DB-backed parts (keys, link lookup).
 */

import type { PublicKeyResolver } from "../credentials/verifier.js";
import { verifyDetached } from "../identity/keys.js";
import type { HandshakeCallbacks } from "./handshake.js";
import type { FederationType, RouteAnnouncement } from "./protocol.js";
import { isWithinAgreed, parseCidr } from "./cidr.js";
import { canonicalize } from "./jcs.js";

/** Reject signed messages whose timestamp is further than this from now. */
export const MAX_MESSAGE_SKEW_MS = 5 * 60 * 1000;

/**
 * Bytes a CFP signature covers: the RFC 8785 (JCS) form of the message without `signature`.
 * It covers every transmitted member, unknown ones too. Wire key order is irrelevant.
 * Rust computes the same bytes; `coordinator/crates/coord-federation/tests/fixtures/cfp_vectors.json` pins both.
 */
export function signedPayload(message: object): string {
  const { signature: _omit, ...rest } = message as Record<string, unknown>;
  return canonicalize(rest);
}

/** Sign a message that has no `signature` yet and return it with one appended. */
export async function signMessage<T extends object>(
  message: T,
  sign: (payload: string) => Promise<string>,
): Promise<T & { signature: string }> {
  const signature = await sign(signedPayload(message));
  return { ...message, signature };
}

/**
 * True when `message.signature` is `did`'s signature over the rest of the message.
 * Pass the message as received (`req.body`), never a schema-parsed copy that may drop members.
 */
export async function verifyMessage(
  resolver: PublicKeyResolver,
  did: string,
  message: object,
): Promise<boolean> {
  const { signature } = message as { signature?: unknown };
  if (typeof signature !== "string" || !signature) return false;
  let payload: string;
  try {
    payload = signedPayload(message);
  } catch {
    return false;
  }
  const publicKey = await resolver.resolve(did);
  if (!publicKey) return false;
  return verifyDetached(publicKey, payload, signature);
}

/** Signing payload of a route announcement's `originSignature`. */
export function routeOriginPayload(prefix: string, originDid: string): string {
  return canonicalize({ prefix, originDid });
}

export function isFresh(timestamp: string, now = Date.now()): boolean {
  const t = Date.parse(timestamp);
  return Number.isFinite(t) && Math.abs(now - t) <= MAX_MESSAGE_SKEW_MS;
}

/**
 * Normalised prefixes we import from a peer: only peer-originated ones inside a CIDR agreed for the link.
 * Security: a peer must not attract traffic it was not granted. An empty agreed list imports nothing.
 */
export function filterImportedPrefixes(
  announcements: RouteAnnouncement[] | undefined,
  agreedCidrs: string[],
  peerDid: string,
): string[] {
  if (agreedCidrs.length === 0) return [];
  const accepted = new Set<string>();
  for (const a of announcements ?? []) {
    if (a.originDid !== peerDid || typeof a.prefix !== "string") continue;
    if (!isWithinAgreed(a.prefix, agreedCidrs)) continue;
    const parsed = parseCidr(a.prefix);
    if (parsed) accepted.add(parsed.normalized);
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
      originSignature: await sign(routeOriginPayload(prefix, localDid)),
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
