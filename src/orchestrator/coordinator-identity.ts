/**
 * @module orchestrator/coordinator-identity
 * Tailnet name (netmap Domain) and member handles that the coordinator shows to Tailscale clients.
 * The coordinator keeps them in memory only, so we push them on key issue, restart, and periodically.
 */

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants, memberships, users } from "../db/schema.js";
import { config } from "../config.js";
import { getCoordinatorClient } from "./control-client.js";
import { logger } from "../logger.js";

/** Matches the coordinator's MAX_IDENTITY_TEXT. */
const MAX_TEXT = 256;
/** Matches the coordinator's MAX_IDENTITY_USERS. */
const MAX_USERS = 10_000;

export interface TenantIdentity {
  tailnet_name: string | null;
  users: Record<string, { login_name: string; display_name: string }>;
}

const clip = (s: string) => s.slice(0, MAX_TEXT);

export async function buildTenantIdentity(tenantId: string): Promise<TenantIdentity | null> {
  const [tenant] = await db
    .select({ name: tenants.name, slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant) return null;

  const members = await db
    .select({ userId: users.id, handle: users.handle, displayName: users.displayName })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.tenantId, tenantId))
    .orderBy(memberships.createdAt)
    .limit(MAX_USERS);

  const out: TenantIdentity = { tailnet_name: clip(tenant.name || tenant.slug), users: {} };
  for (const m of members) {
    out.users[m.userId] = {
      login_name: clip(m.handle),
      display_name: clip(m.displayName?.trim() || m.handle),
    };
  }
  return out;
}

/** Does nothing outside coordinator mode. */
export async function pushTenantIdentity(tenantId: string, coordinatorTenantId: string): Promise<void> {
  if (!config.coordinatorUrl) return;
  const identity = await buildTenantIdentity(tenantId);
  if (!identity) return;
  const client = getCoordinatorClient({ coordinatorTenantId });
  await client.setIdentity(identity);
}

/** Returns false if any push fails. */
export async function syncAllTenantIdentities(): Promise<boolean> {
  if (!config.coordinatorUrl) return true;
  const rows = await db
    .select({ id: tenants.id, slug: tenants.slug, coordinatorTenantId: tenants.coordinatorTenantId })
    .from(tenants)
    .where(and(isNotNull(tenants.coordinatorTenantId), inArray(tenants.status, ["running"])));
  let ok = true;
  for (const t of rows) {
    try {
      await pushTenantIdentity(t.id, t.coordinatorTenantId!);
    } catch (err) {
      ok = false;
      logger.warn({ tenantSlug: t.slug, err }, "failed to push tenant identity to coordinator");
    }
  }
  return ok;
}
