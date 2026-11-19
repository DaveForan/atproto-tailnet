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
import { isWithinAgreed, parseCidr } from "./cidr.js";
import { canonicalize } from "./jcs.js";

/** Reject signed messages whose timestamp is further than this from now. */
export const MAX_MESSAGE_SKEW_MS = 5 * 60 * 1000;

/**
 * The exact bytes a CFP message's signature covers: the RFC 8785 (JCS)
 * canonical form of the message without its `signature` member. Key order
 * on the wire is irrelevant; every other transmitted member (including ones
 * this service does not know) is covered. The Rust coordinator computes the
 * same bytes (`coord_federation::auth::message_signing_payload`); both are
 * pinned by `coordinator/crates/coord-federation/tests/fixtures/cfp_vectors.json`.
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
 * True when `message.signature` is `did`'s signature over the rest of the
 * message (see {@link signedPayload}). Pass the message as received (e.g.
 * `req.body`), never a schema-parsed copy that may have dropped members.
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
 * Prefixes we accept from a peer's announcements: only prefixes contained in a
 * CIDR the link's operators agreed to share (equal or more specific), and only
 * when the peer claims to originate them. Anything else (a wider prefix, a
 * default route, someone else's network) is dropped — a peer must not be able
 * to attract traffic it wasn't granted. An empty agreed list imports nothing.
 * Returned prefixes are normalised.
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
