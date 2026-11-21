/**
 * @module identity/handles
 * AT Proto handle <-> DID resolution and account-DID normalisation from public sources only.
 */

import { resolveTxt } from "node:dns/promises";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { fetchDidDocument, guardedRequest, resolvesToPublicAddresses } from "./resolver.js";

/** Syntactic AT Proto handle check, applied before any DNS/HTTP lookup. */
export const HANDLE_RE =
  /^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

/** AT Proto account DIDs we accept for invitations / tailnet creators. */
export const ACCOUNT_DID_RE = /^did:(plc:[a-z2-7]{24}|web:[a-zA-Z0-9._%:-]{1,253})$/;

/**
 * Canonical account DID, so an invitation matches the DID the invitee signs in with.
 * Only the did:web host changes: it is case-insensitive. did:plc is lowercase by construction.
 */
export function normalizeAccountDid(did: string): string {
  if (!did.startsWith("did:web:")) return did;
  const [host, ...path] = did.slice("did:web:".length).split(":");
  const normHost = host.toLowerCase().replace(/%[0-9a-f]{2}/g, (m) => m.toUpperCase());
  return ["did:web:" + normHost, ...path].join(":");
}

const RESOLVE_TIMEOUT_MS = 5000;

/** Best-effort DID -> verified handle for display (known user row first), or null. */
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

/**
 * The account's handle from its DID document, else the Bluesky public API.
 * Security: the handle is accepted only if it resolves back to the same DID.
 */
export async function lookupVerifiedHandle(did: string): Promise<string | null> {
  // The account's own DID document is the authority for its handle, on any PDS.
  let candidate = handleFromDidDocument(await fetchDidDocument(did));
  if (!candidate) {
    // Bluesky's index covers only accounts it has seen.
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

/** Resolve an AT Proto handle to its DID: DNS TXT, then HTTPS .well-known, then the Bluesky public API. */
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
    // fall through to HTTPS
  }

  // The handle is user input: fetch only public addresses (SSRF).
  // guardedRequest repeats the check at connect time against DNS rebinding.
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
