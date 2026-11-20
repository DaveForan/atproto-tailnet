/**
 * @module orchestrator/tenant-provisioning
 * Creating a tailnet: the tenant row, system roles, originator membership and
 * public address ({@link provisionTenant}), then its control plane
 * ({@link provisionTenantInstance}: a coordinator tenant or a Headscale
 * container). Used by first sign-in, `POST /api/tenants/mine` and
 * sub-collective creation.
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

/**
 * Creates a top-level tenant owned by `user` (roles, originator membership)
 * and provisions its control plane asynchronously. Callers must have checked
 * {@link canCreateTailnet}. The first operator tailnet becomes the instance
 * default (with join requests on) when no default is set.
 */
export async function provisionTenant(
  user: typeof users.$inferSelect,
  displayName: string,
  handle: string,
  opts: { name?: string } = {},
): Promise<typeof tenants.$inferSelect> {
  const prefixes = await allocateTenantPrefixes();

  let tenant: typeof tenants.$inferSelect | undefined;
  let slug = "";
  let port = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    // Re-derive both unique values on every attempt (either can race)
    slug = await generateUniqueSlug();
    // Coordinator-mode tenants have no Headscale container, so they get a
    // synthetic placeholder instead of consuming a real port from the range.
    port = await allocateTenantPort(!useCoordinator);
    try {
      const [inserted] = await db
        .insert(tenants)
        .values({
          slug,
          name: opts.name ?? `${displayName}'s tailnet`,
          ownerUserId: user.id,
          port,
          apiKey: "",
          status: "provisioning",
          accessMode: useCoordinator ? "member" : "open",
          ipv4Prefix: prefixes.ipv4Prefix,
          ipv6Prefix: prefixes.ipv6Prefix,
        })
        .returning();
      tenant = inserted;
      break;
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (attempt === 2 || pgErr.code !== "23505") throw err;
    }
  }
  if (!tenant) throw new Error("Failed to create tenant after retries");
  // Public address: a random friendly name the originator is asked to change
  // in the setup wizard. The internal slug is never routed publicly.
  await registerInitialHostname(tenant.id, await generateAvailableFriendlyName());

  // Create system roles
  const [originatorRole] = await db
    .insert(roles)
    .values({
      tenantId: tenant.id,
      name: "originator",
      description: "Full control over the tailnet",
      permissions: [...ORIGINATOR_PERMISSIONS],
      isSystem: true,
    })
    .returning();

  const [citizenRole] = await db
    .insert(roles)
    .values({
      tenantId: tenant.id,
      name: "citizen",
      description: "Default role for new members",
      permissions: [...DEFAULT_CITIZEN_PERMISSIONS],
      isSystem: true,
    })
    .returning();

  // Set citizen as the default role for new members
  await db
    .update(tenants)
    .set({ defaultRoleId: citizenRole.id })
    .where(eq(tenants.id, tenant.id));

  // Create originator membership
  await db.insert(memberships).values({
    userId: user.id,
    tenantId: tenant.id,
    role: "owner",
    roleId: originatorRole.id,
    isOriginator: true,
  });

  try {
    await claimDefaultTailnet(tenant.id, user.did);
  } catch (err) {
    logger.error({ tenantId: tenant.id, err }, "failed to claim default tailnet");
  }

  setImmediate(() => {
    void provisionTenantInstance(tenant!.id, slug, port);
  });
  return tenant;
}

/**
 * Bring a tenant's control-plane instance up and mark the tenant running.
 *
 * In coordinator mode: creates the tenant in the Rust coordinator via REST,
 * stores the coordinator-side tenant UUID, sets default policy.
 *
 * In Headscale mode: starts a Docker container (or adopts a leftover one),
 * stores its API key, installs the default ACL policy.
 *
 * Both modes sync Caddy routes at the end. On failure the tenant is marked "error".
 * Sub-collectives pass the parent's coordinator tenant id so the coordinator
 * knows the hierarchy (route aggregation, federation posture).
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
    // Compensating delete — best effort
    try {
      await getCoordinatorClient({ coordinatorTenantId: coordTenant.id }).deleteTenant();
    } catch {
      // Best-effort cleanup; log the original error
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
