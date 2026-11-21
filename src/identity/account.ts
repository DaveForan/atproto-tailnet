/**
 * @module identity/account
 * Public profile of an AT Proto account from public sources only.
 * Sign-in requests only the `atproto` scope, so the service has no access to the account.
 */

import { lookupVerifiedHandle } from "./handles.js";
import { safeUrl } from "./safe-url.js";

const PROFILE_TIMEOUT_MS = 5_000;
const MAX_DISPLAY_NAME = 256;

export interface AccountProfile {
  /** Verified both ways (DID → handle → DID), or null when it cannot be verified. */
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

/**
 * Handle (verified), display name and avatar for `did`. Display name and
 * avatar are cosmetic and best effort (Bluesky public API); a failure there
 * never fails a sign-in.
 */
export async function fetchAccountProfile(did: string): Promise<AccountProfile> {
  const handle = await lookupVerifiedHandle(did);
  let displayName: string | null = null;
  let avatarUrl: string | null = null;
  try {
    const res = await fetch(
      `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`,
      { signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS), redirect: "error" },
    );
    if (res.ok) {
      const data = (await res.json()) as { displayName?: unknown; avatar?: unknown };
      if (typeof data.displayName === "string" && data.displayName.trim()) {
        displayName = data.displayName.trim().slice(0, MAX_DISPLAY_NAME);
      }
      if (typeof data.avatar === "string") avatarUrl = safeUrl(data.avatar);
    }
  } catch {
    // cosmetic only
  }
  return { handle, displayName, avatarUrl };
}
