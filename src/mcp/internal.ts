/**
 * @module mcp/internal
 * Marks in-process REST calls made by MCP tools so the API rate limiter can
 * skip them. The /mcp endpoint has its own per-user limit, and each tool makes
 * at most a few API calls, so the loopback calls are already bounded — without
 * this, every MCP user would share the single 127.0.0.1 bucket of the API limiter.
 *
 * The marker is a random per-process secret: it never leaves the process, so
 * external callers cannot forge it (even when a proxy makes them look loopback).
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
