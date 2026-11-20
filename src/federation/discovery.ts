/**
 * @module federation/discovery
 * Peer discovery for cross-instance federation (ADR-0019 §3).
 * Fetches and validates a remote collective's federation descriptor.
 */

import { logger } from "../logger.js";
import { getResolver, guardedRequest, outboundErrorText, resolvesToPublicAddresses } from "../identity/resolver.js";
import type { FederationDescriptor } from "./protocol.js";
import type { PublicKeyResolver } from "../credentials/verifier.js";
import { verifyMessage } from "./auth.js";
import { config } from "../config.js";

const DISCOVERY_TIMEOUT_MS = 10_000;
const MAX_DESCRIPTOR_BYTES = 64 * 1024;

export interface PeerInfo {
  did: string;
  brokerUrl: string;
  name: string;
  capabilities: string[];
  federationPolicy: string;
}

/**
 * Fetch `slug@host`'s federation descriptor and check it: signed by the DID it
 * names (detached JWS over the JCS form without `signature`), not closed, and
 * pointing at an allowed broker URL.
 */
export async function discoverPeer(
  peerAddress: string,
  resolver: PublicKeyResolver = getResolver(),
): Promise<{ ok: true; peer: PeerInfo } | { ok: false; error: string }> {
  let host: string;
  let slug: string;

  if (peerAddress.startsWith("did:")) {
    return { ok: false, error: "Direct DID lookup not yet supported; use slug@host format" };
  }

  const atIdx = peerAddress.indexOf("@");
  if (atIdx === -1) {
    return { ok: false, error: "Peer address must be slug@host or a DID" };
  }

  slug = peerAddress.slice(0, atIdx);
  host = peerAddress.slice(atIdx + 1);

  if (!slug || !host) {
    return { ok: false, error: "Invalid peer address format" };
  }

  let hostname: string;
  try {
    hostname = new URL(`https://${host}`).hostname;
  } catch {
    return { ok: false, error: "Invalid peer address format" };
  }
  if (!(await isAllowedBrokerHost(hostname))) {
    return { ok: false, error: `Host ${host} is not allowed (private/loopback)` };
  }

  const url = `https://${host}/.well-known/collective-federation?collective=${encodeURIComponent(slug)}`;

  let descriptor: FederationDescriptor;
  try {
    let status: number;
    let text: string;
    if (hostname === ownHostname()) {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        headers: { Accept: "application/json" },
        redirect: "error",
      });
      status = res.status;
      text = res.ok ? await res.text() : "";
    } else {
      // The public-address check above is repeated at connect time, so a
      // name that re-resolves to a private address (DNS rebinding) fails here
      const res = await guardedRequest(url, {
        headers: { Accept: "application/json" },
        timeoutMs: DISCOVERY_TIMEOUT_MS,
        maxBytes: MAX_DESCRIPTOR_BYTES,
      });
      status = res.status;
      text = res.text;
    }

    if (status < 200 || status >= 300) {
      return { ok: false, error: `Discovery failed: HTTP ${status} from ${host}` };
    }

    descriptor = JSON.parse(text) as FederationDescriptor;
    if (!descriptor || typeof descriptor !== "object") throw new Error("not an object");
  } catch (err) {
    logger.warn({ host, slug, err }, "peer discovery fetch failed");
    const reason = err instanceof SyntaxError || (err as Error)?.message === "not an object" ? "invalid document" : outboundErrorText(err);
    return { ok: false, error: `Discovery failed: ${reason}` };
  }

  if (!descriptor.collectiveDid || !descriptor.brokerUrl) {
    return { ok: false, error: "Incomplete discovery document (missing DID or broker URL)" };
  }

  if (descriptor.federationPolicy === "closed") {
    return { ok: false, error: `Collective ${slug}@${host} has a closed federation policy` };
  }

  // The DID is the identity; the descriptor is only trusted because its key signed it.
  if (typeof descriptor.collectiveDid !== "string" || !descriptor.collectiveDid.startsWith("did:")) {
    return { ok: false, error: "Discovery document names no valid collective DID" };
  }
  if (!(await verifyMessage(resolver, descriptor.collectiveDid, descriptor))) {
    return {
      ok: false,
      error: `Descriptor signature does not verify against ${descriptor.collectiveDid}`,
    };
  }

  if (!(await isAllowedBrokerUrl(descriptor.brokerUrl))) {
    return { ok: false, error: `Peer broker URL ${descriptor.brokerUrl} is not allowed` };
  }

  return {
    ok: true,
    peer: {
      did: descriptor.collectiveDid,
      brokerUrl: descriptor.brokerUrl,
      name: slug,
      capabilities: descriptor.capabilities ?? [],
      federationPolicy: descriptor.federationPolicy ?? "selective",
    },
  };
}

/** Hostname of this instance's own public URL, or null if it does not parse. */
function ownHostname(): string | null {
  try {
    return new URL(config.publicUrl).hostname;
  } catch {
    return null;
  }
}

/**
 * Whether we may send requests to `host`. This instance's own host is always
 * allowed (same-instance federation, including loopback dev deployments).
 * Anything else must be — or resolve only to — public addresses: never
 * private, loopback, link-local, CGNAT (100.64.0.0/10), unspecified, ULA
 * (fc00::/7) or IPv4-mapped forms of those.
 */
async function isAllowedBrokerHost(host: string): Promise<boolean> {
  if (!host) return false;
  if (host === ownHostname()) return true;
  return resolvesToPublicAddresses(host);
}

/**
 * Whether a peer-supplied broker URL may be stored and dialled. HTTPS is
 * required, except for this instance's own URL (the dev allowance: a local
 * deployment served over plain http talks to itself). The host must pass
 * {@link isAllowedBrokerHost}, which resolves it via DNS.
 *
 * The check runs at the time a URL is accepted; a name that re-resolves to a
 * private address later is not caught here.
 */
export async function isAllowedBrokerUrl(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  const own = ownHostname();
  if (parsed.protocol !== "https:") {
    if (parsed.protocol !== "http:" || parsed.hostname !== own) return false;
  }
  return isAllowedBrokerHost(parsed.hostname);
}
