/**
 * @module operator/policy
 * Instance-level policy: who may create a tailnet, the instance settings
 * singleton (single-tailnet mode, default tailnet) and designated tailnet
 * creators. Every tailnet-creation path goes through {@link canCreateTailnet}.
 */

import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { instanceSettings, tailnetCreators, tenants } from "../db/schema.js";
import { config } from "../config.js";

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
  const rows = await db
    .select({ id: tailnetCreators.id })
    .from(tailnetCreators)
    .where(eq(tailnetCreators.did, did))
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
 * Serializes check-then-create for tailnets so single-tailnet mode can't be
 * raced by concurrent sign-ins. Sufficient for the single app process this
 * service runs as; the tenant row is inserted before fn resolves.
 */
export function withTailnetCreationLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = creationQueue.then(fn, fn);
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
 * Called when a new top-level tenant is provisioned. If its owner is an
 * operator and no default tailnet is set yet, it becomes the default and
 * starts accepting join requests (so no-access users can ask to join).
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
