/**
 * @module orchestrator/coordinator-identity
 * Names the Rust coordinator shows to Tailscale clients: the tailnet name
 * (netmap Domain — the profile name in the Tailscale apps) and, per node
 * owner (our user id), the member's Bluesky handle and display name.
 *
 * The coordinator keeps this in memory only, so it is pushed when a key is
 * issued, on every coordinator (re)start (monitor resync), and periodically
 * so new members and renamed handles show up.
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

/** Build the identity document for one tenant from the DB. */
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

/** Push one tenant's identity to the coordinator (no-op outside coordinator mode). */
export async function pushTenantIdentity(tenantId: string, coordinatorTenantId: string): Promise<void> {
  if (!config.coordinatorUrl) return;
  const identity = await buildTenantIdentity(tenantId);
  if (!identity) return;
  const client = getCoordinatorClient({ coordinatorTenantId });
  await client.setIdentity(identity);
}

/** Push identity for every running coordinator tenant. Returns false if any push failed. */
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
