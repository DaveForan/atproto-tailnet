/**
 * @module identity/resolver
 * did:web and did:plc resolution for credential verification (ADR-0017).
 */

import * as jose from "jose";
import * as crypto from "node:crypto";
import * as net from "node:net";
import { lookup } from "node:dns/promises";
import dns, { type LookupAddress } from "node:dns";
import https from "node:https";
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
/** Largest DID document accepted from an attacker-chosen did:web host. */
export const MAX_DID_DOC_BYTES = 256 * 1024;

export interface DIDResolverOptions {
  cacheTtlMs?: number;
  /** Key for DIDs this instance hosts. Consulted first and never cached, so rotation applies at once. */
  localLookup?: (did: string) => Promise<jose.JWK | null>;
  /** Whether a did:web host may be fetched. Security: the default refuses non-public addresses (SSRF). */
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

    const doc = await fetchDidDocument(did, { hostCheck: this.hostCheck });
    if (!doc) return null;

    let key: VerifyKey | null = null;
    try {
      key = await extractSigningKey(doc);
    } catch (err) {
      logger.warn({ did, err }, "DID document has no usable signing key");
      return null;
    }

    if (key) {
      this.cacheKey(did, key);
    }

    return key;
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

  /** Resolve one verification method (e.g. `#atproto`) with its algorithm and method ID. */
  async resolveTyped(
    did: string,
    opts?: { methodId?: string; algorithms?: string[] },
  ): Promise<ResolvedKey | null> {
    if (typeof did !== "string" || did.length > MAX_DID_LENGTH) return null;

    const cacheKey = `${did}|${opts?.methodId ?? "*"}|${(opts?.algorithms ?? []).join(",")}`;
    const cached = this.typedCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.resolved;

    // Local collectives always sign with an EdDSA `#signing-key`.
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

    const doc = await fetchDidDocument(did, { hostCheck: this.hostCheck });
    if (!doc) return null;

    const resolved = await extractTypedKey(doc, opts);
    if (resolved) {
      this.cacheTypedKey(cacheKey, resolved);
    }
    return resolved;
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

export interface DIDDocument {
  id: string;
  alsoKnownAs?: unknown;
  verificationMethod?: VerificationMethod[];
  authentication?: (string | VerificationMethod)[];
  assertionMethod?: (string | VerificationMethod)[];
}

const DID_DOC_ACCEPT = "application/did+json,application/json";

/**
 * The DID document for a did:web or did:plc DID, or null. Never throws.
 * Security: did:web hosts must pass `hostCheck` (default: public addresses only).
 */
export async function fetchDidDocument(
  did: string,
  opts?: { hostCheck?: (host: string) => Promise<boolean> },
): Promise<DIDDocument | null> {
  const hostCheck = opts?.hostCheck ?? isPublicHost;
  let doc: unknown;
  if (did.startsWith("did:web:")) {
    doc = await fetchDidWebJson(did, hostCheck);
    if (isDocObject(doc) && doc.id !== did) {
      logger.warn({ did, docId: doc.id }, "did:web document id mismatch");
      return null;
    }
  } else if (did.startsWith("did:plc:")) {
    doc = await fetchDidPlcJson(did);
  } else {
    logger.warn({ did }, "unsupported DID method");
    return null;
  }
  return isDocObject(doc) ? doc : null;
}

function isDocObject(doc: unknown): doc is DIDDocument {
  return typeof doc === "object" && doc !== null && !Array.isArray(doc);
}

// The default policy fetches through guardedGetJson: connect-time address check and size cap.
// A custom `hostCheck` (tests only) uses plain `fetch`.
async function fetchDidWebJson(
  did: string,
  hostCheck: (host: string) => Promise<boolean>,
): Promise<unknown> {
  try {
    const url = didWebToUrl(did);
    if (!(await hostCheck(new URL(url).host))) {
      logger.warn({ did }, "did:web host refused (not a public address)");
      return null;
    }
    if (hostCheck === isPublicHost) {
      const out = await guardedGetJson(url, {
        timeoutMs: RESOLUTION_TIMEOUT_MS,
        maxBytes: MAX_DID_DOC_BYTES,
      });
      if (!out.ok) {
        logger.warn({ did, status: out.status }, "did:web resolution failed");
        return null;
      }
      return out.json;
    }
    const res = await fetch(url, {
      signal: AbortSignal.timeout(RESOLUTION_TIMEOUT_MS),
      headers: { Accept: DID_DOC_ACCEPT },
      redirect: "error",
    });
    if (!res.ok) {
      logger.warn({ did, status: res.status }, "did:web resolution failed");
      return null;
    }
    return await res.json();
  } catch (err) {
    logger.warn({ did, err }, "did:web resolution error");
    return null;
  }
}

async function fetchDidPlcJson(did: string): Promise<unknown> {
  try {
    const res = await fetch(`${PLC_DIRECTORY}/${encodeURIComponent(did)}`, {
      signal: AbortSignal.timeout(RESOLUTION_TIMEOUT_MS),
      headers: { Accept: DID_DOC_ACCEPT },
      redirect: "error",
    });
    if (!res.ok) {
      logger.warn({ did, status: res.status }, "did:plc resolution failed");
      return null;
    }
    return await res.json();
  } catch (err) {
    logger.warn({ did, err }, "did:plc resolution error");
    return null;
  }
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

/** The document's Ed25519 key: assertion/authentication methods first, then any method. JWK only. */
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
  const mapped = /^(?:0{1,4}:){0,4}:?:?ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]);
  // Same, in the hex form WHATWG URL serialises it to (`[::ffff:7f00:1]`).
  const mappedHex = /^(?:0{1,4}:){0,4}:?:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isPublicAddress(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }

  const family = net.isIP(address);
  if (family === 0) return false;
  return !NON_PUBLIC.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** Default did:web host policy: HTTPS default port only, and every resolved address must be public. */
export async function isPublicHost(host: string): Promise<boolean> {
  let hostname: string;
  try {
    const url = new URL(`https://${host}`);
    if (url.port !== "") return false;
    hostname = url.hostname.replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }

  return resolvesToPublicAddresses(hostname);
}

/** True when `hostname` (IP literal or DNS name) is, or resolves only to, public addresses. */
export async function resolvesToPublicAddresses(hostname: string): Promise<boolean> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (!bare) return false;
  if (net.isIP(bare)) return isPublicAddress(bare);

  try {
    const addresses = await lookup(bare, { all: true });
    return addresses.length > 0 && addresses.every((a) => isPublicAddress(a.address));
  } catch {
    return false;
  }
}

let defaultResolver: DIDResolver | null = null;

/** Look up a collective DID hosted by this instance in `collective_dids`. */
async function lookupLocalCollectiveKey(did: string): Promise<jose.JWK | null> {
  const [{ db }, { collectiveDids, tenants }, { and, eq, ne }] = await Promise.all([
    import("../db/index.js"),
    import("../db/schema.js"),
    import("drizzle-orm"),
  ]);
  // Suspended or deleted collectives must not verify as signers.
  const [row] = await db
    .select({ publicKeyJwk: collectiveDids.publicKeyJwk })
    .from(collectiveDids)
    .innerJoin(tenants, eq(tenants.id, collectiveDids.tenantId))
    .where(and(eq(collectiveDids.did, did), ne(tenants.status, "deleted"), eq(tenants.suspended, false)))
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

/** Connect-time DNS lookup that refuses non-public answers, so DNS rebinding cannot pass validation. */
export function guardedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "");
    const list = addresses as LookupAddress[];
    if (list.length === 0 || !list.every((a) => isPublicAddress(a.address))) {
      return callback(
        Object.assign(new Error("Host resolves to a non-public address"), { code: "EPRIVATE" }),
        "",
      );
    }
    if (options.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  });
}

/** Answer of {@link guardedRequest}. The body of a non-2xx answer is discarded. */
export interface GuardedResponse {
  ok: boolean;
  status: number;
  text: string;
}

/**
 * HTTPS request to an untrusted host: public addresses only, no redirects, timeout and size cap.
 * Security: a non-2xx body is never read, so remote error pages cannot leak into our errors.
 */
export function guardedRequest(
  url: string,
  opts: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string; timeoutMs: number; maxBytes: number },
): Promise<GuardedResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== "https:") {
      reject(new Error("Only https is allowed"));
      return;
    }
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host) && !isPublicAddress(host)) {
      reject(new Error("Host is a non-public address"));
      return;
    }
    const req = https.request(
      u,
      {
        method: opts.method ?? "GET",
        headers: {
          ...(opts.headers ?? {}),
          ...(opts.body !== undefined ? { "Content-Length": String(Buffer.byteLength(opts.body)) } : {}),
        },
        lookup: guardedLookup as unknown as typeof dns.lookup,
        signal: AbortSignal.timeout(opts.timeoutMs),
        timeout: opts.timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          res.resume(); // 3xx is never followed
          resolve({ ok: false, status, text: "" });
          return;
        }
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > opts.maxBytes) {
          res.destroy();
          reject(new Error("Response too large"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > opts.maxBytes) {
            res.destroy(new Error("Response too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => resolve({ ok: true, status, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
    req.end(opts.body);
  });
}

/** HTTPS GET of a JSON document from an untrusted host, through {@link guardedRequest}. */
export async function guardedGetJson(
  url: string,
  opts: { timeoutMs: number; maxBytes: number },
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const res = await guardedRequest(url, {
    headers: { Accept: DID_DOC_ACCEPT },
    timeoutMs: opts.timeoutMs,
    maxBytes: opts.maxBytes,
  });
  return { ok: res.ok, status: res.status, json: res.ok ? JSON.parse(res.text) : null };
}

/** Short error text for a failed outbound request. It never contains the remote body. */
export function outboundErrorText(err: unknown): string {
  const e = err as { code?: string; name?: string; message?: string } | null;
  if (e?.code === "EPRIVATE" || /non-public/.test(e?.message ?? "")) return "address not allowed";
  if (e?.name === "TimeoutError" || e?.name === "AbortError" || /timed out/i.test(e?.message ?? "")) return "timed out";
  if (/too large/i.test(e?.message ?? "")) return "response too large";
  if (/https/.test(e?.message ?? "") && /Only/.test(e?.message ?? "")) return "https required";
  return "unreachable";
}
