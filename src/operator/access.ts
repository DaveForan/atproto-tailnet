/**
 * @module operator/access
 * Request-time enforcement of operator decisions, mounted once in front of
 * every authenticated API router (after credential resolution):
 *
 * - disabled users: any credential (session, agent token, MCP token) is
 *   refused with 403 `account_disabled`; a session is destroyed.
 * - suspended tenants: a member's request to `/api/tenants/:id/...` is refused
 *   with 403 `tenant_suspended`. Operators acting as themselves bypass it.
 *   Non-members fall through so routes keep answering 404 (no existence leak).
 */

import type { Request, Response, NextFunction } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { memberships, tenants, users } from "../db/schema.js";
import { currentUserId } from "./auth.js";
import { isOperatorDid } from "./policy.js";

const TENANT_PATH_RE =
  /^\/api\/tenants\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

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

  const m = req.path.match(TENANT_PATH_RE);
  if (m) {
    const [row] = await db
      .select({ suspended: tenants.suspended, membershipId: memberships.id })
      .from(tenants)
      .leftJoin(
        memberships,
        and(eq(memberships.tenantId, tenants.id), eq(memberships.userId, userId)),
      )
      .where(eq(tenants.id, m[1]));
    const operatorBypass = !req.agentToken && isOperatorDid(user?.did);
    if (row?.suspended && row.membershipId && !operatorBypass) {
      res.status(403).json(TENANT_SUSPENDED);
      return;
    }
  }

  next();
}
