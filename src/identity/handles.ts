/**
 * @module identity/handles
 * AT Proto handle <-> DID resolution and account-DID normalisation, shared by
 * invitations, operator tailnet creators and public profile lookup. Needs no
 * access to the account: DNS TXT, HTTPS .well-known, DID documents and the
 * Bluesky public API only.
 */

import { resolveTxt } from "node:dns/promises";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import {
  didWebToUrl,
  guardedGetJson,
  guardedRequest,
  MAX_DID_DOC_BYTES,
  resolvesToPublicAddresses,
} from "./resolver.js";

/** Syntactic AT Proto handle check — rejects non-handle input before any DNS/HTTP lookup. */
export const HANDLE_RE =
  /^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

/** AT Proto account DIDs we accept for invitations / tailnet creators. */
export const ACCOUNT_DID_RE = /^did:(plc:[a-z2-7]{24}|web:[a-zA-Z0-9._%:-]{1,253})$/;

/**
 * Canonical form of an account DID so an invitation matches the DID the
 * invitee signs in with: the did:web host part is case-insensitive (lowercased,
 * percent-escapes uppercased); path segments and did:plc ids are left as-is
 * (did:plc is lowercase by construction).
 */
export function normalizeAccountDid(did: string): string {
  if (!did.startsWith("did:web:")) return did;
  const [host, ...path] = did.slice("did:web:".length).split(":");
  const normHost = host.toLowerCase().replace(/%[0-9a-f]{2}/g, (m) => m.toUpperCase());
  return ["did:web:" + normHost, ...path].join(":");
}

/** Timeout for every outbound identity lookup. */
const RESOLVE_TIMEOUT_MS = 5000;


/**
 * Best-effort DID → handle for display. Uses a known user row, else the
 * did:plc document's `alsoKnownAs`, else the Bluesky public profile; the
 * candidate handle is only trusted if it resolves back to the same DID.
 * Returns null when no verified handle is found.
 */
export async function resolveDidToHandle(did: string): Promise<string | null> {
  const [known] = await db.select({ handle: users.handle }).from(users).where(eq(users.did, did));
  if (known) return known.handle;
  return lookupVerifiedHandle(did);
}

/** First `at://` handle in a DID document's `alsoKnownAs`, lowercased. */
export function handleFromDidDocument(doc: unknown): string | null {
  const aka = (doc as { alsoKnownAs?: unknown } | null)?.alsoKnownAs;
  if (!Array.isArray(aka)) return null;
  const entry = aka.find((a): a is string => typeof a === "string" && a.startsWith("at://"));
  const handle = entry?.slice(5).split("/")[0].toLowerCase();
  return handle && HANDLE_RE.test(handle) ? handle : null;
}

/** The DID document for a did:plc or did:web account, or null. Never throws. */
async function fetchDidDocument(did: string): Promise<unknown | null> {
  try {
    if (did.startsWith("did:plc:")) {
      const res = await fetch(`https://plc.directory/${encodeURIComponent(did)}`, {
        signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
        redirect: "error",
      });
      return res.ok ? await res.json() : null;
    }
    if (did.startsWith("did:web:")) {
      // The host is chosen by the account: public addresses only (checked at
      // connect time), no redirects, size-capped.
      const out = await guardedGetJson(didWebToUrl(did), {
        timeoutMs: RESOLVE_TIMEOUT_MS,
        maxBytes: MAX_DID_DOC_BYTES,
      });
      return out.ok ? out.json : null;
    }
  } catch {
    // unreachable or malformed
  }
  return null;
}

/**
 * The account's current handle from public sources (its DID document, then
 * the Bluesky public API as a fallback), accepted only if the handle resolves back to the same
 * DID. Needs no access to the account.
 */
export async function lookupVerifiedHandle(did: string): Promise<string | null> {
  // The account's own DID document is the authority for its handle
  // (`alsoKnownAs: ["at://<handle>"]`): the PLC directory for did:plc, the
  // account's own host for did:web. Works for accounts on any PDS.
  let candidate = handleFromDidDocument(await fetchDidDocument(did));
  if (!candidate) {
    // Fallback only: Bluesky's index (covers accounts it has seen)
    try {
      const res = await fetch(
        `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`,
        { signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS), redirect: "error" },
      );
      if (res.ok) {
        const data = (await res.json()) as { handle?: string };
        if (data.handle && data.handle !== "handle.invalid") candidate = data.handle;
      }
    } catch {
      // fall through
    }
  }
  if (!candidate || !HANDLE_RE.test(candidate)) return null;
  const back = await resolveHandleToDid(candidate);
  return back && normalizeAccountDid(back) === normalizeAccountDid(did) ? candidate : null;
}

/**
 * Resolves an AT Proto handle to its DID (DNS TXT → HTTPS .well-known →
 * Bluesky public API). Shared by invitations and operator tailnet creators.
 */
export async function resolveHandleToDid(handle: string): Promise<string | null> {
  const cleanHandle = handle.replace(/^@/, "");

  if (!HANDLE_RE.test(cleanHandle)) {
    return null;
  }

  try {
    const records = await resolveTxt(`_atproto.${cleanHandle}`);
    const didRecord = records.flat().find((r) => r.startsWith("did="));
    if (didRecord) {
      const did = didRecord.slice(4).trim();
      if (did.startsWith("did:")) return did;
    }
  } catch {
    // DNS resolution failed, try HTTP
  }

  // The handle is user input: only fetch its .well-known when every address
  // it resolves to is public (no probing of internal services), with a
  // timeout and no redirects. The check is repeated at connect time
  // (`guardedRequest`), so a DNS answer that changes after it cannot reach
  // an internal address.
  try {
    if (await resolvesToPublicAddresses(cleanHandle)) {
      const res = await guardedRequest(`https://${cleanHandle}/.well-known/atproto-did`, {
        timeoutMs: RESOLVE_TIMEOUT_MS,
        maxBytes: 2048,
      });
      if (res.ok) {
        const did = res.text.slice(0, 2048).trim();
        if (did.startsWith("did:")) return did;
      }
    }
  } catch {
    // fall through
  }

  try {
    const res = await fetch(
      `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(cleanHandle)}`,
      { signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS), redirect: "error" },
    );
    if (res.ok) {
      const data = (await res.json()) as { did?: unknown };
      if (typeof data.did === "string" && data.did.startsWith("did:")) return data.did;
    }
  } catch {
    // fall through
  }

  return null;
}

/** Converts an AT Proto handle to a Headscale-safe username (lowercase alphanumeric + hyphens). */
export function toHsUsername(handle: string): string {
  return handle
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}
