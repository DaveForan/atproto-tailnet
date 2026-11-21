/**
 * @module operator/policy
 * Instance policy: tailnet creation rights, the instance settings singleton and designated creators.
 * Every tailnet-creation path goes through {@link canCreateTailnet}.
 */

import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { instanceSettings, memberships, tailnetCreators, tenants } from "../db/schema.js";
import { config } from "../config.js";
import { withAdvisoryLock, LOCK_TAILNET_CREATION } from "../db/locks.js";
import { normalizeAccountDid } from "../identity/handles.js";

/** Operator-managed instance settings. */
export interface InstanceSettings {
  singleTailnet: boolean;
  defaultTailnetId: string | null;
}

/** True when `did` is listed in OPERATOR_DIDS. */
export function isOperatorDid(did: string | null | undefined): boolean {
  return Boolean(did) && config.operatorDids.includes(did!);
}

/** Reads the settings singleton (row id = 1, created by migration 0026). */
export async function getInstanceSettings(): Promise<InstanceSettings> {
  const [row] = await db
    .select({
      singleTailnet: instanceSettings.singleTailnet,
      defaultTailnetId: instanceSettings.defaultTailnetId,
    })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 1));
  return row ?? { singleTailnet: false, defaultTailnetId: null };
}

/** Upserts the settings singleton with the given changes; returns the result. */
export async function updateInstanceSettings(
  patch: Partial<InstanceSettings>,
): Promise<InstanceSettings> {
  const current = await getInstanceSettings();
  const next = { ...current, ...patch };
  await db
    .insert(instanceSettings)
    .values({ id: 1, ...next, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: instanceSettings.id,
      set: { ...next, updatedAt: new Date() },
    });
  return next;
}

/** Top-level (parentless), non-deleted tenants — what single-tailnet mode counts. */
export async function listTopLevelTenants(): Promise<Array<{ id: string; slug: string; name: string }>> {
  return db
    .select({ id: tenants.id, slug: tenants.slug, name: tenants.name })
    .from(tenants)
    .where(and(isNull(tenants.parentId), ne(tenants.status, "deleted")))
    .orderBy(tenants.createdAt)
    .limit(200);
}

async function countTopLevelTenants(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tenants)
    .where(and(isNull(tenants.parentId), ne(tenants.status, "deleted")));
  return row?.count ?? 0;
}

/** True when an operator designated `did` as a tailnet creator. */
export async function isTailnetCreator(did: string): Promise<boolean> {
  // did:web host case must not matter (creators are stored normalized).
  const normalized = normalizeAccountDid(did);
  const rows = await db
    .select({ id: tailnetCreators.id })
    .from(tailnetCreators)
    .where(inArray(tailnetCreators.did, [...new Set([normalized, did])]))
    .limit(1);
  return rows.length > 0;
}

/**
 * The creation rule, pure: operator OR designated creator, AND (not
 * single-tailnet mode OR no top-level tenant exists yet).
 */
export function decideCanCreateTailnet(input: {
  isOperator: boolean;
  isCreator: boolean;
  singleTailnet: boolean;
  topLevelTenants: number;
}): boolean {
  if (!input.isOperator && !input.isCreator) return false;
  return !input.singleTailnet || input.topLevelTenants === 0;
}

/** Whether `user` may create a (top-level) tailnet right now. */
let creationQueue: Promise<unknown> = Promise.resolve();

/**
 * Serializes check-then-create so concurrent sign-ins cannot race single-tailnet mode.
 * An in-process queue keeps one lock connection per process; a PostgreSQL advisory lock covers replicas (ADR-0034).
 * The tenant row is inserted before fn resolves.
 */
export function withTailnetCreationLock<T>(fn: () => Promise<T>): Promise<T> {
  const locked = () => withAdvisoryLock(pool, LOCK_TAILNET_CREATION, fn);
  const run = creationQueue.then(locked, locked);
  creationQueue = run.catch(() => undefined);
  return run;
}

export async function canCreateTailnet(user: { did: string }): Promise<boolean> {
  const isOperator = isOperatorDid(user.did);
  const isCreator = isOperator ? false : await isTailnetCreator(user.did);
  if (!isOperator && !isCreator) return false;
  const settings = await getInstanceSettings();
  const topLevelTenants = settings.singleTailnet ? await countTopLevelTenants() : 0;
  return decideCanCreateTailnet({ isOperator, isCreator, singleTailnet: settings.singleTailnet, topLevelTenants });
}

/**
 * Makes a new top-level tenant the default tailnet when its owner is an operator and no default exists.
 * The default accepts join requests, so no-access users can ask to join.
 * The conditional update makes the claim race-free.
 */
export async function claimDefaultTailnet(tenantId: string, ownerDid: string): Promise<boolean> {
  if (!isOperatorDid(ownerDid)) return false;
  await db
    .insert(instanceSettings)
    .values({ id: 1 })
    .onConflictDoNothing();
  const claimed = await db
    .update(instanceSettings)
    .set({ defaultTailnetId: tenantId, updatedAt: new Date() })
    .where(and(eq(instanceSettings.id, 1), isNull(instanceSettings.defaultTailnetId)))
    .returning({ id: instanceSettings.id });
  if (claimed.length === 0) return false;
  await db
    .update(tenants)
    .set({ allowJoinRequests: true, updatedAt: new Date() })
    .where(eq(tenants.id, tenantId));
  return true;
}

/** Unsets the default tailnet if it is `tenantId` (tenant deleted). */
export async function clearDefaultTailnetIf(tenantId: string): Promise<void> {
  await db
    .update(instanceSettings)
    .set({ defaultTailnetId: null, updatedAt: new Date() })
    .where(and(eq(instanceSettings.id, 1), eq(instanceSettings.defaultTailnetId, tenantId)));
}

/**
 * `/api/me` `access`: "member" only when the user belongs to a live, unsuspended tailnet.
 * Memberships only in suspended tailnets count as "no_access"; `isOperator` is independent.
 */
export async function memberAccess(userId: string): Promise<"member" | "no_access"> {
  const [row] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .innerJoin(tenants, eq(memberships.tenantId, tenants.id))
    .where(
      and(
        eq(memberships.userId, userId),
        ne(tenants.status, "deleted"),
        eq(tenants.suspended, false),
      ),
    )
    .limit(1);
  return row ? "member" : "no_access";
}
