/**
 * @module operator/auth
 * Operator request guard. An operator request is authenticated as a user
 * (dashboard session or MCP OAuth token — whatever `authUserId` resolves),
 * the user's DID is in OPERATOR_DIDS, and it is NOT an agent token (agent
 * tokens are tenant-scoped and never carry instance powers).
 */

import type { Request, Response, NextFunction } from "express";
import { authUserId, authUserDid } from "../routes/helpers.js";
import { isOperatorDid } from "./policy.js";

/** The authenticated user's id, or null for anonymous requests. */
export function currentUserId(req: Request): string | null {
  try {
    return authUserId(req) || null;
  } catch {
    return null;
  }
}

/** True when the request is an operator acting as themselves (not via an agent token). */
export async function isOperatorRequest(req: Request): Promise<boolean> {
  if (req.agentToken) return false;
  if (!currentUserId(req)) return false;
  return isOperatorDid(await authUserDid(req));
}

/** Express guard for /api/operator/*: 401 anonymous, 403 agent tokens and non-operators. */
export async function requireOperator(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!currentUserId(req)) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  if (req.agentToken) {
    res.status(403).json({ error: "Agent tokens cannot use operator endpoints" });
    return;
  }
  if (!isOperatorDid(await authUserDid(req))) {
    res.status(403).json({ error: "Operator access required" });
    return;
  }
  next();
}
