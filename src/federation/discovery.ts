/**
 * @module federation/discovery
 * Peer discovery for cross-instance federation (ADR-0019 §3).
 * Fetches and validates a remote collective's federation descriptor.
 */

import { logger } from "../logger.js";
import { getResolver } from "../identity/resolver.js";
import type { FederationDescriptor } from "./protocol.js";
import { config } from "../config.js";

const DISCOVERY_TIMEOUT_MS = 10_000;

export interface PeerInfo {
  did: string;
  brokerUrl: string;
  name: string;
  capabilities: string[];
  federationPolicy: string;
}

export async function discoverPeer(
  peerAddress: string,
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

  if (!isAllowedBrokerHost(host)) {
    return { ok: false, error: `Host ${host} is not allowed (private/loopback)` };
  }

  const url = `https://${host}/.well-known/collective-federation?collective=${encodeURIComponent(slug)}`;

  let descriptor: FederationDescriptor;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      headers: { Accept: "application/json" },
      redirect: "error",
    });

    if (!res.ok) {
      return { ok: false, error: `Discovery failed: HTTP ${res.status} from ${host}` };
    }

    descriptor = (await res.json()) as FederationDescriptor;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.warn({ host, slug, err }, "peer discovery fetch failed");
    return { ok: false, error: `Discovery failed: ${msg}` };
  }

  if (!descriptor.collectiveDid || !descriptor.brokerUrl) {
    return { ok: false, error: "Incomplete discovery document (missing DID or broker URL)" };
  }

  if (descriptor.federationPolicy === "closed") {
    return { ok: false, error: `Collective ${slug}@${host} has a closed federation policy` };
  }

  if (descriptor.signature) {
    const resolver = getResolver();
    const key = await resolver.resolve(descriptor.collectiveDid);
    if (!key) {
      return {
        ok: false,
        error: `Cannot verify descriptor signature: unable to resolve ${descriptor.collectiveDid}`,
      };
    }
  }

  if (!isAllowedBrokerUrl(descriptor.brokerUrl)) {
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

function isAllowedBrokerHost(host: string): boolean {
  const ownUrl = config.publicUrl;
  try {
    const ownHost = new URL(ownUrl).hostname;
    if (host === ownHost) return true;
  } catch {}

  if (isPrivateOrLoopback(host)) {
    return false;
  }

  return true;
}

export function isAllowedBrokerUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      const ownUrl = new URL(config.publicUrl);
      if (parsed.hostname !== ownUrl.hostname) return false;
    }
    return isAllowedBrokerHost(parsed.hostname);
  } catch {
    return false;
  }
}

function isPrivateOrLoopback(host: string): boolean {
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return true;
  }
  if (host === "[::1]") return true;

  const parts = host.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    const [a, b] = parts.map(Number);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
  }

  return false;
}
