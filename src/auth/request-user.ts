/**
 * @module auth/request-user
 * Who a request is acting as: agent token, MCP OAuth token or dashboard
 * session (a Bearer credential wins over a cookie). Shared by route handlers
 * (via routes/helpers.ts) and the operator guard.
 */

import type { Request } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";

/**
 * Returns the authenticated user's ID from the agent token, the MCP OAuth
 * token or the session (a Bearer credential wins over a cookie).
 * Must be called after `requireAuth` (routes/helpers.ts).
 */
export function authUserId(req: Request): string {
  return req.agentToken?.userId ?? req.mcpAuth?.userId ?? req.session.userId!;
}

/**
 * Returns the authenticated user's DID. For session-based auth, reads from
 * the session. For agent/MCP tokens, looks up the DID from the users table.
 */
export async function authUserDid(req: Request): Promise<string | null> {
  if (req.session.did && !req.agentToken && !req.mcpAuth) return req.session.did;
  const userId = authUserId(req);
  const [user] = await db
    .select({ did: users.did })
    .from(users)
    .where(eq(users.id, userId));
  return user?.did ?? null;
}
