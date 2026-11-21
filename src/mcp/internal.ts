/**
 * @module mcp/internal
 * Marks loopback REST calls from MCP tools so the API limiter skips them; /mcp has its own per-user limit.
 * Security: the marker is a per-process secret, so external callers cannot forge it, even through a proxy.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Request } from "express";

export const INTERNAL_MCP_HEADER = "x-atn-internal-mcp";
export const INTERNAL_MCP_SECRET = randomBytes(32).toString("hex");

const secretBuf = Buffer.from(INTERNAL_MCP_SECRET);

/** True for loopback API calls issued by our MCP tools (secret header + MCP bearer). */
export function isInternalMcpCall(req: Request): boolean {
  const v = req.headers[INTERNAL_MCP_HEADER];
  if (typeof v !== "string") return false;
  const b = Buffer.from(v);
  if (b.length !== secretBuf.length || !timingSafeEqual(b, secretBuf)) return false;
  return Boolean(req.headers.authorization?.startsWith("Bearer mcp_"));
}
