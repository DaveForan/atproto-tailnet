/**
 * @module operator/access
 * Enforces user disablement (403 `account_disabled`) and tenant suspension (403 `tenant_suspended`).
 * Mounted before every authenticated API router, after credential resolution.
 * Non-members fall through so routes still answer 404 (no existence leak).
 */

import type { Request, Response, NextFunction } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { memberships, tenants, users } from "../db/schema.js";
import { currentUserId } from "./auth.js";
import { isOperatorDid } from "./policy.js";

/** First segment after /api/tenants/ (raw, still percent-encoded). Case-insensitive like Express routing. */
const TENANT_SEGMENT_RE = /^\/api\/tenants\/([^/]+)/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The tenant id a `/api/tenants/<id>/...` request addresses, decoded exactly
 * as Express decodes `:tenantId` (so `%30000…` cannot slip past the check).
 * Returns `null` for paths that address no tenant UUID, and `"invalid"` for
 * malformed percent-encoding or encoded slashes/backslashes in the segment.
 */
export function tenantIdFromPath(path: string): string | null | "invalid" {
  const m = TENANT_SEGMENT_RE.exec(path);
  if (!m) return null;
  const raw = m[1];
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return "invalid";
  }
  if (/[/\\]/.test(decoded)) return "invalid";
  return UUID_RE.test(decoded) ? decoded.toLowerCase() : null;
}

/** Body of the 403 a member gets for a suspended tenant. */
export const TENANT_SUSPENDED = {
  error: "This tailnet has been suspended by the instance operator",
  code: "tenant_suspended",
} as const;

/** Body of the 403 a disabled user gets. */
export const ACCOUNT_DISABLED = {
  error: "This account has been disabled by the instance operator",
  code: "account_disabled",
} as const;

/** Middleware enforcing user disablement and tenant suspension (see module doc). */
export async function enforceOperatorState(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = currentUserId(req);
  if (!userId) {
    next();
    return;
  }

  const [user] = await db
    .select({ did: users.did, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, userId));

  if (user?.disabledAt) {
    if (req.session?.userId) {
      req.session.destroy(() => {
        res.status(403).json(ACCOUNT_DISABLED);
      });
      return;
    }
    res.status(403).json(ACCOUNT_DISABLED);
    return;
  }

  const tenantId = tenantIdFromPath(req.path);
  if (tenantId === "invalid") {
    res.status(400).json({ error: "Malformed tenant id in path" });
    return;
  }
  if (tenantId) {
    const [row] = await db
      .select({ suspended: tenants.suspended, membershipId: memberships.id })
      .from(tenants)
      .leftJoin(
        memberships,
        and(eq(memberships.tenantId, tenants.id), eq(memberships.userId, userId)),
      )
      .where(eq(tenants.id, tenantId));
    // Operators acting as themselves bypass; agent tokens and MCP tokens
    // without the operator scope never do.
    const operatorBypass =
      !req.agentToken && (!req.mcpAuth || req.mcpAuth.operator) && isOperatorDid(user?.did);
    if (row?.suspended && row.membershipId && !operatorBypass) {
      res.status(403).json(TENANT_SUSPENDED);
      return;
    }
  }

  next();
}
