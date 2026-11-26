/**
 * @module orchestrator/tenant-provisioning
 * Creates a tailnet: the database records ({@link createTenantRecord}), then
 * its tenant in the coordinator ({@link provisionTenantInstance}), after the commit.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, tenants, memberships, roles } from "../db/schema.js";
import { allocateTenantPrefixes } from "./prefix-allocator.js";
import { syncTenantRoutes } from "./caddy.js";
import { getCoordinatorClient } from "./control-client.js";
import {
  generateAvailableFriendlyName,
  generateInternalSlug,
  hostnameAvailableFor,
  registerInitialHostname,
} from "./hostnames.js";
import { ORIGINATOR_PERMISSIONS, DEFAULT_CITIZEN_PERMISSIONS } from "../members/permissions.js";
import { syncTenantAccess } from "../access/sync.js";
import { claimDefaultTailnet } from "../operator/policy.js";
import { logger } from "../logger.js";

/**
 * Security: the slug is part of the collective DID, so it is never derived from the handle.
 * A handle-based slug would reveal who runs which tailnet.
 */
async function generateUniqueSlug(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const candidate = generateInternalSlug();
    if (await hostnameAvailableFor(candidate, "")) return candidate;
  }
  throw new Error("Could not generate unique slug");
}

type Tenant = typeof tenants.$inferSelect;

export interface NewTenantRecord {
  ownerUserId: string;
  name: string;
  /** Sub-collectives inherit hierarchy, IP allocation and caps from the parent. */
  parent?: Tenant;
  /** Fixed internal slug; omitted means a fresh opaque slug per attempt. */
  slug?: string;
  /** First public address; omitted means a random friendly name. */
  hostname?: string;
}

/** Attempts per tenant insert; the slug or hostname can race with another insert. */
const INSERT_ATTEMPTS = 3;

/**
 * Inserts the tenant row, its public address, the system roles, the default
 * role and the originator membership in one transaction.
 * Errors: a unique violation (23505) after the last attempt, or any other database error.
 */
export async function createTenantRecord(rec: NewTenantRecord): Promise<Tenant> {
  const { parent } = rec;
  const prefixes = await allocateTenantPrefixes();
  for (let attempt = 0; ; attempt++) {
    const slug = rec.slug ?? (await generateUniqueSlug());
    const hostname = rec.hostname ?? (await generateAvailableFriendlyName());
    try {
      return await db.transaction(async (tx) => {
        const [tenant] = await tx
          .insert(tenants)
          .values({
            slug,
            name: rec.name,
            ownerUserId: rec.ownerUserId,
            status: "provisioning",
            accessMode: "member",
            ipv4Prefix: prefixes.ipv4Prefix,
            ipv6Prefix: prefixes.ipv6Prefix,
            ...(parent && {
              parentId: parent.id,
              path: parent.path ? `${parent.path}.${slug}` : slug,
              depth: parent.depth + 1,
              maxSubCollectives: 10,
              // An unlimited (0) child under a capped parent would bypass the parent's caps
              maxDevices: parent.maxDevices,
              maxMembers: parent.maxMembers,
            }),
          })
          .returning();
        await registerInitialHostname(tenant.id, hostname, tx);

        const [originatorRole] = await tx
          .insert(roles)
          .values({
            tenantId: tenant.id,
            name: "originator",
            description: "Full control over the tailnet",
            permissions: [...ORIGINATOR_PERMISSIONS],
            isSystem: true,
          })
          .returning();
        const [citizenRole] = await tx
          .insert(roles)
          .values({
            tenantId: tenant.id,
            name: "citizen",
            description: "Default role for new members",
            permissions: [...DEFAULT_CITIZEN_PERMISSIONS],
            isSystem: true,
          })
          .returning();
        await tx
          .update(tenants)
          .set({ defaultRoleId: citizenRole.id, updatedAt: new Date() })
          .where(eq(tenants.id, tenant.id));

        await tx.insert(memberships).values({
          userId: rec.ownerUserId,
          tenantId: tenant.id,
          roleId: originatorRole.id,
          isOriginator: true,
        });
        return { ...tenant, defaultRoleId: citizenRole.id };
      });
    } catch (err: unknown) {
      if ((err as { code?: string }).code !== "23505" || attempt === INSERT_ATTEMPTS - 1) throw err;
    }
  }
}

/**
 * Creates a top-level tenant and registers it with the coordinator after the commit.
 * Callers must check `canCreateTailnet` first.
 */
export async function provisionTenant(
  user: typeof users.$inferSelect,
  displayName: string,
  opts: { name?: string } = {},
): Promise<Tenant> {
  const tenant = await createTenantRecord({
    ownerUserId: user.id,
    name: opts.name ?? `${displayName}'s tailnet`,
  });

  try {
    await claimDefaultTailnet(tenant.id, user.did);
  } catch (err) {
    logger.error({ tenantId: tenant.id, err }, "failed to claim default tailnet");
  }

  setImmediate(() => {
    void provisionTenantInstance(tenant.id, tenant.slug);
  });
  return tenant;
}

/** Registers the tenant with the coordinator. On failure it marks the tenant "error" and returns false. */
export async function provisionTenantInstance(
  tenantId: string,
  slug: string,
  opts: { parentCoordinatorTenantId?: string | null } = {},
): Promise<boolean> {
  try {
    await provisionViaCoordinator(tenantId, slug, opts.parentCoordinatorTenantId ?? null);

    await syncTenantRoutes().catch((err) =>
      logger.error({ tenantSlug: slug, err }, "failed to sync Caddy routes"),
    );

    logger.info({ tenantSlug: slug }, "tenant provisioned");
    return true;
  } catch (err) {
    logger.error({ tenantSlug: slug, err }, "failed to provision tenant");
    await db
      .update(tenants)
      .set({ status: "error", updatedAt: new Date() })
      .where(eq(tenants.id, tenantId));
    return false;
  }
}

async function provisionViaCoordinator(
  tenantId: string,
  slug: string,
  parentCoordinatorTenantId: string | null,
): Promise<void> {
  const coordTenant = await getCoordinatorClient().createTenant(slug, parentCoordinatorTenantId);

  try {
    await db
      .update(tenants)
      .set({ coordinatorTenantId: coordTenant.id, status: "running", updatedAt: new Date() })
      .where(eq(tenants.id, tenantId));

    // Own devices only by default (ADR-0036); the coordinator stores the mode
    await syncTenantAccess(tenantId);

    // Default allow-all, translated to the coordinator's {default_deny, rules} model
    await getCoordinatorClient({ coordinatorTenantId: coordTenant.id }).setAclPolicyFile({
      acls: [{ action: "accept", src: ["*"], dst: ["*:*"] }],
    });
  } catch (err) {
    // Best-effort compensating delete; the original error is the one to report
    try {
      await getCoordinatorClient({ coordinatorTenantId: coordTenant.id }).deleteTenant();
    } catch {
      // ignored
    }
    throw err;
  }
}
