/**
 * @module routes/guard
 *
 * One tenant guard for every `/api/tenants/:tenantId/...` handler.
 *
 * {@link tenantGuard} runs the guard clauses in the order CLAUDE.md fixes —
 * param extraction → getTenantForUser → (originator / agent-token refusals) →
 * hasPermission → lockdown — and stores the result on `res.locals.tenantCtx`.
 * Handlers read it with {@link tenantCtx}. Body validation and business logic
 * stay in the handler, after the guard.
 *
 * Mount it after `requireAuth` / `requireSession` and after `stepUpForSession`
 * or rate limiters that already ran before the inline lookup, so the effective
 * order of a route does not change.
 *
 * Responses are the ones the inline guards returned:
 * - non-member / deleted tenant: 404 `{ error: "Tenant not found" }` (never 403)
 * - `originatorOnly`: 403 `{ error: <message> }`
 * - `noAgentToken`: 403 `{ error: <message> }`
 * - `permission`: 403 `{ error: "Insufficient permissions" }` (or `permissionError`)
 * - `notLockedDown`: 403 `{ error: "Tenant is in lockdown mode" }` (or the given message)
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { Permission } from "../members/permissions.js";
// authUserId comes straight from its home module: some route tests mock
// ./helpers.js with only the members a route used before the guard existed.
import { authUserId } from "../auth/request-user.js";
import { param, getTenantForUser, hasPermission, isLockedDown, type TenantForUser } from "./helpers.js";

/** Default lockdown refusal body. */
export const LOCKDOWN_ERROR = "Tenant is in lockdown mode";

export interface TenantGuardOptions {
  /** Route param holding the tenant id (default `"tenantId"`). */
  param?: string;
  /** Refuse non-originators with 403 and this message. Checked first after the lookup. */
  originatorOnly?: string;
  /** Refuse agent-token requests with 403 and this message. Checked after `originatorOnly`. */
  noAgentToken?: string;
  /**
   * Required permission; an array means any one of them. Always checked with
   * `req`, so agent-token scope applies. 403 "Insufficient permissions".
   */
  permission?: Permission | readonly Permission[];
  /** Error message for a failed `permission` check (default "Insufficient permissions"). */
  permissionError?: string;
  /** Refuse while the tenant is in lockdown; `true` = the default message. Checked last. */
  notLockedDown?: true | string;
}

/** What {@link tenantGuard} stores for the handler. */
export type TenantCtx = TenantForUser & { userId: string };

/** The context {@link tenantGuard} resolved for this request. */
export function tenantCtx(res: Response): TenantCtx {
  const ctx = res.locals.tenantCtx as TenantCtx | undefined;
  if (!ctx) throw new Error("tenantCtx(res) used on a route without tenantGuard");
  return ctx;
}

/** Middleware factory: resolve the caller's tenant + membership and apply the guard clauses. */
export function tenantGuard(options: TenantGuardOptions = {}): RequestHandler {
  const name = options.param ?? "tenantId";
  const perms =
    options.permission === undefined
      ? null
      : typeof options.permission === "string"
        ? [options.permission]
        : options.permission;
  const lockdownError =
    options.notLockedDown === undefined
      ? null
      : options.notLockedDown === true
        ? LOCKDOWN_ERROR
        : options.notLockedDown;

  return async function tenantGuardMiddleware(req: Request, res: Response, next: NextFunction) {
    const userId = authUserId(req);
    const result = await getTenantForUser(param(req, name), userId);
    if (!result) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }
    if (options.originatorOnly !== undefined && !result.membership.isOriginator) {
      res.status(403).json({ error: options.originatorOnly });
      return;
    }
    if (options.noAgentToken !== undefined && req.agentToken) {
      res.status(403).json({ error: options.noAgentToken });
      return;
    }
    if (perms && !perms.some((p) => hasPermission(result.membership, result.role, p, req))) {
      res.status(403).json({ error: options.permissionError ?? "Insufficient permissions" });
      return;
    }
    if (lockdownError !== null && isLockedDown(result.tenant)) {
      res.status(403).json({ error: lockdownError });
      return;
    }
    res.locals.tenantCtx = { ...result, userId } satisfies TenantCtx;
    next();
  };
}
