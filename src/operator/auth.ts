/**
 * @module operator/auth
 * Operator guard: a session or MCP OAuth user whose DID is in OPERATOR_DIDS.
 * Agent tokens are tenant-scoped and never carry instance powers.
 * An MCP token carries operator powers only when its grant includes the operator scope.
 */

import type { Request, Response, NextFunction } from "express";
import { authUserId, authUserDid } from "../auth/request-user.js";
import { isOperatorDid } from "./policy.js";

/** The authenticated user's id, or null for anonymous requests. */
export function currentUserId(req: Request): string | null {
  try {
    return authUserId(req) || null;
  } catch {
    return null;
  }
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
  if (req.mcpAuth && !req.mcpAuth.operator) {
    res.status(403).json({
      error: "This MCP connection was not granted instance operator access",
      code: "operator_scope_required",
    });
    return;
  }
  if (!isOperatorDid(await authUserDid(req))) {
    res.status(403).json({ error: "Operator access required" });
    return;
  }
  next();
}
