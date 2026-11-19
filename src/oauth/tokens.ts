/**
 * @module oauth/tokens
 * Opaque MCP token generation and hashing. Raw tokens are `mcp_` + 32 random
 * bytes (base64url); only their SHA-256 hex digest is ever stored.
 */
import { createHash, randomBytes } from "node:crypto";

export const MCP_TOKEN_PREFIX = "mcp_";

/** Access token lifetime: 1 hour. */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
/** Refresh token lifetime: 30 days (rotated on every use). */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Authorization code lifetime: 60 seconds, single use. */
export const AUTH_CODE_TTL_MS = 60 * 1000;
/** Consent page validity. */
export const CONSENT_TTL_MS = 10 * 60 * 1000;

/** New opaque token with the `mcp_` prefix. */
export function generateMcpToken(): string {
  return MCP_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/** Authorization codes / consent ids: random, not prefixed (never sent as Bearer). */
export function generateOpaqueId(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 hex digest — the at-rest form of every MCP token. */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function isMcpToken(raw: string): boolean {
  return raw.startsWith(MCP_TOKEN_PREFIX);
}
