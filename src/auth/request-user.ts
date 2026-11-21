/**
 * @module auth/request-user
 * Who a request acts as: agent token, MCP OAuth token or dashboard session.
 * A Bearer credential wins over a cookie.
 */

import type { Request } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";

/** Authenticated user's ID. Call it only after `requireAuth`. */
export function authUserId(req: Request): string {
  return req.agentToken?.userId ?? req.mcpAuth?.userId ?? req.session.userId!;
}

/** Authenticated user's DID: from the session, or from the users table for agent and MCP tokens. */
export async function authUserDid(req: Request): Promise<string | null> {
  if (req.session.did && !req.agentToken && !req.mcpAuth) return req.session.did;
  const userId = authUserId(req);
  const [user] = await db
    .select({ did: users.did })
    .from(users)
    .where(eq(users.id, userId));
  return user?.did ?? null;
}
