/**
 * @module routes/guard
 * {@link tenantGuard} applies the tenant guard clauses in CLAUDE.md order; handlers read the result with {@link tenantCtx}.
 * Mount it after auth, step-up and rate limiters. Non-members get 404 "Tenant not found", never 403.
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { Permission } from "../members/permissions.js";
// Import authUserId from its home module: some route tests mock ./helpers.js without it.
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
