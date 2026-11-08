/**
 * @module identity/resolver
 * DID resolution for did:web and did:plc methods (ADR-0017).
 * Implements PublicKeyResolver interface for credential verification.
 */

import * as jose from "jose";
import * as crypto from "node:crypto";
import * as net from "node:net";
import { lookup } from "node:dns/promises";
import {
  parseMultikey,
  formatDidKey,
  p256Plugin,
  secp256k1Plugin,
} from "@atproto/crypto";
import { logger } from "../logger.js";
import type { PublicKeyResolver, ResolvedKey } from "../credentials/verifier.js";

type VerifyKey = jose.CryptoKey | jose.KeyObject;

interface CacheEntry {
  key: VerifyKey;
  expiresAt: number;
}

interface TypedCacheEntry {
  resolved: ResolvedKey;
  expiresAt: number;
}

const PLC_DIRECTORY = "https://plc.directory";
const RESOLUTION_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_SIZE = 500;
const MAX_DID_LENGTH = 512;

export interface DIDResolverOptions {
  cacheTtlMs?: number;
  /**
   * Public key for DIDs this instance hosts itself. Consulted first and never
   * cached, so key rotation takes effect immediately and no HTTP round-trip
   * to ourselves is needed.
   */
  localLookup?: (did: string) => Promise<jose.JWK | null>;
  /**
   * Whether a did:web host may be fetched. DIDs arrive from unauthenticated
   * callers, so the default refuses anything that resolves to a non-public
   * address (SSRF guard).
   */
  hostCheck?: (host: string) => Promise<boolean>;
}

export class DIDResolver implements PublicKeyResolver {
  private cache = new Map<string, CacheEntry>();
  private typedCache = new Map<string, TypedCacheEntry>();
  private cacheTtlMs: number;
  private localLookup?: (did: string) => Promise<jose.JWK | null>;
  private hostCheck: (host: string) => Promise<boolean>;

  constructor(options?: DIDResolverOptions) {
    this.cacheTtlMs = options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.localLookup = options?.localLookup;
    this.hostCheck = options?.hostCheck ?? isPublicHost;
  }

  async resolve(did: string): Promise<VerifyKey | null> {
    if (typeof did !== "string" || did.length > MAX_DID_LENGTH) return null;

    if (this.localLookup) {
      const jwk = await this.localLookup(did);
      if (jwk) return importEd25519Jwk(jwk);
    }

    const cached = this.cache.get(did);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.key;
    }

    let key: VerifyKey | null = null;

    if (did.startsWith("did:web:")) {
      key = await this.resolveDidWeb(did);
    } else if (did.startsWith("did:plc:")) {
      key = await this.resolveDidPlc(did);
    } else {
      logger.warn({ did }, "unsupported DID method");
      return null;
    }

    if (key) {
      this.cacheKey(did, key);
    }

    return key;
  }

  private async resolveDidWeb(did: string): Promise<VerifyKey | null> {
    try {
      const url = didWebToUrl(did);
      if (!(await this.hostCheck(new URL(url).host))) {
        logger.warn({ did }, "did:web host refused (not a public address)");
        return null;
      }

      const res = await fetch(url, {
        signal: AbortSignal.timeout(RESOLUTION_TIMEOUT_MS),
        headers: { Accept: "application/did+json,application/json" },
        redirect: "error",
      });

      if (!res.ok) {
        logger.warn({ did, status: res.status }, "did:web resolution failed");
        return null;
      }

      const doc = (await res.json()) as DIDDocument;
      if (doc.id !== did) {
        logger.warn({ did, docId: doc.id }, "did:web document id mismatch");
        return null;
      }
      return extractSigningKey(doc);
    } catch (err) {
      logger.warn({ did, err }, "did:web resolution error");
      return null;
    }
  }

  private async resolveDidPlc(did: string): Promise<VerifyKey | null> {
    try {
      const url = `${PLC_DIRECTORY}/${encodeURIComponent(did)}`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(RESOLUTION_TIMEOUT_MS),
        headers: { Accept: "application/did+json,application/json" },
        redirect: "error",
      });

      if (!res.ok) {
        logger.warn({ did, status: res.status }, "did:plc resolution failed");
        return null;
      }

      const doc = (await res.json()) as DIDDocument;
      return extractSigningKey(doc);
    } catch (err) {
      logger.warn({ did, err }, "did:plc resolution error");
      return null;
    }
  }

  private cacheKey(did: string, key: VerifyKey): void {
    if (this.cache.size >= MAX_CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(did, {
      key,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
  }

  /**
   * Resolve a specific verification method from a DID document, returning the
   * key with its algorithm and method ID. Used for method-specific resolution
   * (e.g. `#atproto` for ES256K/ES256 account keys).
   */
  async resolveTyped(
    did: string,
    opts?: { methodId?: string; algorithms?: string[] },
  ): Promise<ResolvedKey | null> {
    if (typeof did !== "string" || did.length > MAX_DID_LENGTH) return null;

    const cacheKey = `${did}|${opts?.methodId ?? "*"}|${(opts?.algorithms ?? []).join(",")}`;
    const cached = this.typedCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.resolved;

    // For local collectives, resolve as EdDSA (they always use #signing-key)
    if (this.localLookup && (!opts?.methodId || opts.methodId === "#signing-key")) {
      const jwk = await this.localLookup(did);
      if (jwk) {
        const key = await importEd25519Jwk(jwk);
        if (key) {
          const resolved: ResolvedKey = { key, algorithm: "EdDSA", methodId: "#signing-key" };
          this.cacheTypedKey(cacheKey, resolved);
          return resolved;
        }
      }
    }

    const doc = await this.fetchDidDocument(did);
    if (!doc) return null;

    const resolved = await extractTypedKey(doc, opts);
    if (resolved) {
      this.cacheTypedKey(cacheKey, resolved);
    }
    return resolved;
  }

  private async fetchDidDocument(did: string): Promise<DIDDocument | null> {
    if (did.startsWith("did:web:")) return this.fetchDidWebDoc(did);
    if (did.startsWith("did:plc:")) return this.fetchDidPlcDoc(did);
    logger.warn({ did }, "unsupported DID method");
    return null;
  }

  private async fetchDidWebDoc(did: string): Promise<DIDDocument | null> {
    try {
      const url = didWebToUrl(did);
      if (!(await this.hostCheck(new URL(url).host))) {
        logger.warn({ did }, "did:web host refused (not a public address)");
        return null;
      }
      const res = await fetch(url, {
        signal: AbortSignal.timeout(RESOLUTION_TIMEOUT_MS),
        headers: { Accept: "application/did+json,application/json" },
        redirect: "error",
      });
      if (!res.ok) {
        logger.warn({ did, status: res.status }, "did:web resolution failed");
        return null;
      }
      const doc = (await res.json()) as DIDDocument;
      if (doc.id !== did) {
        logger.warn({ did, docId: doc.id }, "did:web document id mismatch");
        return null;
      }
      return doc;
    } catch (err) {
      logger.warn({ did, err }, "did:web resolution error");
      return null;
    }
  }

  private async fetchDidPlcDoc(did: string): Promise<DIDDocument | null> {
    try {
      const url = `${PLC_DIRECTORY}/${encodeURIComponent(did)}`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(RESOLUTION_TIMEOUT_MS),
        headers: { Accept: "application/did+json,application/json" },
        redirect: "error",
      });
      if (!res.ok) {
        logger.warn({ did, status: res.status }, "did:plc resolution failed");
        return null;
      }
      return (await res.json()) as DIDDocument;
    } catch (err) {
      logger.warn({ did, err }, "did:plc resolution error");
      return null;
    }
  }

  private cacheTypedKey(cacheKey: string, resolved: ResolvedKey): void {
    if (this.typedCache.size >= MAX_CACHE_SIZE) {
      const oldest = this.typedCache.keys().next().value;
      if (oldest) this.typedCache.delete(oldest);
    }
    this.typedCache.set(cacheKey, {
      resolved,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
  }

  clearCache(): void {
    this.cache.clear();
    this.typedCache.clear();
  }

  invalidate(did: string): void {
    this.cache.delete(did);
    for (const key of this.typedCache.keys()) {
      if (key.startsWith(did + "|")) this.typedCache.delete(key);
    }
  }
}

interface VerificationMethod {
  id: string;
  type: string;
  controller?: string;
  publicKeyJwk?: jose.JWK;
  publicKeyMultibase?: string;
}

interface DIDDocument {
  id: string;
  verificationMethod?: VerificationMethod[];
  authentication?: (string | VerificationMethod)[];
  assertionMethod?: (string | VerificationMethod)[];
}

export function didWebToUrl(did: string): string {
  const parts = did.replace("did:web:", "").split(":");
  const host = decodeURIComponent(parts[0]);
  if (parts.length === 1) {
    return `https://${host}/.well-known/did.json`;
  }
  const path = parts.slice(1).map(decodeURIComponent).join("/");
  return `https://${host}/${path}/did.json`;
}

async function importEd25519Jwk(jwk: jose.JWK): Promise<VerifyKey | null> {
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") return null;
  try {
    // Public members only — never import a `d` someone published by mistake.
    const imported = await jose.importJWK({ kty: jwk.kty, crv: jwk.crv, x: jwk.x }, "EdDSA");
    return imported instanceof Uint8Array ? null : imported;
  } catch {
    return null;
  }
}

/**
 * Pick the document's Ed25519 key: assertion/authentication methods first,
 * then any verification method. Keys in other formats (e.g. the secp256k1
 * `publicKeyMultibase` keys of did:plc accounts) are not supported.
 */
async function extractSigningKey(doc: DIDDocument): Promise<VerifyKey | null> {
  const methods = doc.verificationMethod ?? [];
  const preferred = (doc.assertionMethod ?? doc.authentication ?? []).map((ref) =>
    typeof ref === "string" ? methods.find((m) => m.id === ref) : ref,
  );

  for (const method of [...preferred, ...methods]) {
    if (!method?.publicKeyJwk) continue;
    const key = await importEd25519Jwk(method.publicKeyJwk);
    if (key) return key;
  }

  return null;
}

const ALG_TO_CRV: Record<string, string> = {
  ES256K: "secp256k1",
  ES256: "P-256",
};

async function importMultikey(
  multibase: string,
): Promise<{ key: VerifyKey; jwtAlg: string; didKey: string } | null> {
  try {
    const { jwtAlg, keyBytes } = parseMultikey(multibase);
    const didKey = formatDidKey(jwtAlg, keyBytes);

    const crv = ALG_TO_CRV[jwtAlg];
    if (!crv) return null;

    let x: Uint8Array;
    let y: Uint8Array;
    if (keyBytes.length === 65 && keyBytes[0] === 0x04) {
      x = keyBytes.slice(1, 33);
      y = keyBytes.slice(33, 65);
    } else if (keyBytes.length === 33) {
      const plugin = jwtAlg === "ES256K" ? secp256k1Plugin : p256Plugin;
      const uncompressed = plugin.decompressPubkey(keyBytes);
      x = uncompressed.slice(1, 33);
      y = uncompressed.slice(33, 65);
    } else {
      return null;
    }

    const jwk = {
      kty: "EC" as const,
      crv,
      x: jose.base64url.encode(x),
      y: jose.base64url.encode(y),
    };
    const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
    return { key, jwtAlg, didKey };
  } catch (err) {
    logger.debug({ err, multibase: multibase.slice(0, 12) }, "multikey import failed");
    return null;
  }
}

async function extractTypedKey(
  doc: DIDDocument,
  opts?: { methodId?: string; algorithms?: string[] },
): Promise<ResolvedKey | null> {
  const methods = doc.verificationMethod ?? [];
  const candidates = opts?.methodId
    ? methods.filter((m) => m.id === `${doc.id}${opts.methodId}` || m.id === opts.methodId)
    : methods;

  for (const method of candidates) {
    if (method.publicKeyMultibase) {
      const result = await importMultikey(method.publicKeyMultibase);
      if (!result) continue;
      if (opts?.algorithms && !opts.algorithms.includes(result.jwtAlg)) continue;
      const methodId = method.id.startsWith(doc.id)
        ? method.id.slice(doc.id.length)
        : method.id;
      return {
        key: result.key,
        algorithm: result.jwtAlg,
        methodId,
        didKey: result.didKey,
      };
    }

    if (method.publicKeyJwk) {
      const jwk = method.publicKeyJwk;
      if (jwk.kty === "OKP" && jwk.crv === "Ed25519") {
        if (opts?.algorithms && !opts.algorithms.includes("EdDSA")) continue;
        const key = await importEd25519Jwk(jwk);
        if (!key) continue;
        const methodId = method.id.startsWith(doc.id)
          ? method.id.slice(doc.id.length)
          : method.id;
        return { key, algorithm: "EdDSA", methodId };
      }
      if (jwk.kty === "EC") {
        const alg = jwk.crv === "secp256k1" ? "ES256K" : jwk.crv === "P-256" ? "ES256" : null;
        if (!alg) continue;
        if (opts?.algorithms && !opts.algorithms.includes(alg)) continue;
        try {
          const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
          const methodId = method.id.startsWith(doc.id)
            ? method.id.slice(doc.id.length)
            : method.id;
          return { key, algorithm: alg, methodId };
        } catch {
          continue;
        }
      }
    }
  }

  return null;
}

const NON_PUBLIC = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) {
  NON_PUBLIC.addSubnet(addr, prefix, "ipv4");
}
for (const [addr, prefix] of [
  ["::", 127], ["64:ff9b::", 96], ["fc00::", 7],
  ["fe80::", 10], ["ff00::", 8],
] as const) {
  NON_PUBLIC.addSubnet(addr, prefix, "ipv6");
}

export function isPublicAddress(address: string): boolean {
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is judged as the IPv4 address it reaches.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]);

  const family = net.isIP(address);
  if (family === 0) return false;
  return !NON_PUBLIC.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * Default did:web host policy: HTTPS default port only, and every address the
 * name resolves to must be public. (A name that re-resolves differently
 * between this check and the fetch can still slip through; the fetch also
 * refuses redirects and the response is only ever parsed as a DID document.)
 */
export async function isPublicHost(host: string): Promise<boolean> {
  let hostname: string;
  try {
    const url = new URL(`https://${host}`);
    if (url.port !== "") return false;
    hostname = url.hostname.replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }

  if (net.isIP(hostname)) return isPublicAddress(hostname);

  try {
    const addresses = await lookup(hostname, { all: true });
    return addresses.length > 0 && addresses.every((a) => isPublicAddress(a.address));
  } catch {
    return false;
  }
}

let defaultResolver: DIDResolver | null = null;

/** Look up a collective DID hosted by this instance in `collective_dids`. */
async function lookupLocalCollectiveKey(did: string): Promise<jose.JWK | null> {
  const [{ db }, { collectiveDids }, { eq }] = await Promise.all([
    import("../db/index.js"),
    import("../db/schema.js"),
    import("drizzle-orm"),
  ]);
  const [row] = await db
    .select({ publicKeyJwk: collectiveDids.publicKeyJwk })
    .from(collectiveDids)
    .where(eq(collectiveDids.did, did))
    .limit(1);
  return (row?.publicKeyJwk as jose.JWK | undefined) ?? null;
}

/** Process-wide resolver: local collectives from the DB, everything else over HTTPS. */
export function getResolver(): DIDResolver {
  if (!defaultResolver) {
    defaultResolver = new DIDResolver({ localLookup: lookupLocalCollectiveKey });
  }
  return defaultResolver;
}
