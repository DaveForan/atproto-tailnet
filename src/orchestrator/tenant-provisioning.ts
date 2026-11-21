/**
 * @module orchestrator/tenant-provisioning
 * Creates a tailnet: the database records ({@link createTenantRecord}), then
 * its control plane ({@link provisionTenantInstance}), after the commit.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, tenants, memberships, roles } from "../db/schema.js";
import { allocateTenantPort } from "./ports.js";
import { allocateTenantPrefixes } from "./prefix-allocator.js";
import { adoptInstance, createInstance } from "./headscale.js";
import { syncTenantRoutes } from "./caddy.js";
import { getControlClient, getCoordinatorClient, useCoordinator } from "./control-client.js";
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
 * Opaque internal id for a new tailnet. Never derived from the handle: the id
 * is the coordinator's tenant slug and is part of the collective DID, so a
 * handle-based id would reveal who runs which tailnet.
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

/** Attempts per tenant insert; the port, slug or hostname can race with another insert. */
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
    // Coordinator tenants have no Headscale container, so they get a
    // placeholder port instead of one from the range.
    const port = await allocateTenantPort(!useCoordinator);
    try {
      return await db.transaction(async (tx) => {
        const [tenant] = await tx
          .insert(tenants)
          .values({
            slug,
            name: rec.name,
            ownerUserId: rec.ownerUserId,
            port,
            apiKey: "",
            status: "provisioning",
            accessMode: useCoordinator ? "member" : "open",
            ipv4Prefix: prefixes.ipv4Prefix,
            ipv6Prefix: prefixes.ipv6Prefix,
            ...(parent && {
              parentId: parent.id,
              path: parent.path ? `${parent.path}.${slug}` : slug,
              depth: parent.depth + 1,
              maxSubCollectives: 10,
              ipAllocation: parent.ipAllocation,
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
 * Creates a top-level tenant owned by `user` and provisions its control plane
 * after the commit. Callers must have checked {@link canCreateTailnet}. The
 * first operator tailnet becomes the instance default when none is set.
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
    void provisionTenantInstance(tenant.id, tenant.slug, tenant.port);
  });
  return tenant;
}

/**
 * Brings up the tenant's control plane (coordinator tenant or Headscale
 * container), marks it running and syncs Caddy. On failure the tenant is
 * marked "error". Sub-collectives pass the parent's coordinator tenant id.
 */
export async function provisionTenantInstance(
  tenantId: string,
  slug: string,
  port: number,
  opts: { parentCoordinatorTenantId?: string | null } = {},
): Promise<boolean> {
  try {
    if (useCoordinator) {
      await provisionViaCoordinator(tenantId, slug, port, opts.parentCoordinatorTenantId ?? null);
    } else {
      await provisionViaHeadscale(tenantId, slug, port);
    }

    await syncTenantRoutes().catch((err) =>
      logger.error({ tenantSlug: slug, err }, "failed to sync Caddy routes"),
    );

    logger.info({ tenantSlug: slug, port, mode: useCoordinator ? "coordinator" : "headscale" }, "tenant provisioned");
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

/** Sentinel value stored in apiKey for coordinator-mode tenants. */
const COORDINATOR_API_KEY_SENTINEL = "__coordinator__";

async function provisionViaCoordinator(
  tenantId: string,
  slug: string,
  _port: number,
  parentCoordinatorTenantId: string | null,
): Promise<void> {
  const coordTenant = await getCoordinatorClient().createTenant(slug, parentCoordinatorTenantId);

  try {
    await db
      .update(tenants)
      .set({
        coordinatorTenantId: coordTenant.id,
        apiKey: COORDINATOR_API_KEY_SENTINEL,
        status: "running",
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, tenantId));

    // Own devices only by default (ADR-0036); the coordinator stores the mode
    await syncTenantAccess(tenantId);

    // Default allow-all, translated to the coordinator's {default_deny, rules} model
    await getCoordinatorClient({ coordinatorTenantId: coordTenant.id }).setHeadscalePolicy({
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

async function provisionViaHeadscale(
  tenantId: string,
  slug: string,
  port: number,
): Promise<void> {
  const instance =
    (await adoptInstance(slug, port)) ?? (await createInstance(slug, port));

  await db
    .update(tenants)
    .set({
      apiKey: instance.apiKey,
      containerId: instance.containerId,
      status: "running",
      updatedAt: new Date(),
    })
    .where(eq(tenants.id, tenantId));

  const client = getControlClient({
    port,
    apiKey: instance.apiKey,
  });

  await client.setPolicy({
    acls: [{ action: "accept", src: ["*"], dst: ["*:*"] }],
  });
}
