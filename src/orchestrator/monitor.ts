/**
 * @module orchestrator/monitor
 * Background health-check and hibernation loop.
 * Headscale mode: probes each running tenant container via REST and attempts
 * a Docker start on failure (marking the tenant "error" if that fails).
 * Coordinator mode: probes the shared coordinator once per sweep (outages are
 * logged, never written to tenant status) and resyncs in-memory coordinator
 * state when it becomes healthy.
 * Also stops idle tenants whose lastActivityAt exceeds hibernateAfterDays.
 */

import { eq, and, isNotNull, gt, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants, memberships, usageSnapshots, type DerpRegion } from "../db/schema.js";
import { config } from "../config.js";
import { getControlClient, useCoordinator } from "./control-client.js";
import { CoordinatorApiClient } from "./coordinator-api.js";
import { startInstance, stopInstance } from "./headscale.js";
import { syncTenantRoutes } from "./caddy.js";
import { pushTenantIdentity, syncAllTenantIdentities } from "./coordinator-identity.js";
import { sweepExpiredJtis } from "../credentials/service-auth.js";
import { sweepExpiredOAuthStates } from "../auth/atproto.js";
import { logAudit } from "../routes/audit.js";
import { endExpiredShares, syncTenantAccess } from "../access/sync.js";
import { logger } from "../logger.js";
import { isLeader } from "./leader.js";
import { notifyRefusedMachines } from "./machine-refusals.js";

/** Boot id of the coordinator process whose in-memory state is in sync (null = not synced). */
let syncedBootId: string | null = null;
/** Consecutive failed probes of the shared coordinator. */
let coordinatorFailCount = 0;

/**
 * Run a single health-check sweep across all running tenants.
 * Exported for the per-tenant endpoint to reuse (and for testability).
 */
export async function checkAllTenants(): Promise<void> {
  if (useCoordinator) {
    await checkCoordinator();
    return;
  }

  const running = await db
    .select({
      id: tenants.id,
      slug: tenants.slug,
      port: tenants.port,
      apiKey: tenants.apiKey,
      containerId: tenants.containerId,
      coordinatorTenantId: tenants.coordinatorTenantId,
    })
    .from(tenants)
    .where(and(eq(tenants.status, "running"), isNotNull(tenants.containerId)));

  for (const tenant of running) {
    const client = getControlClient(tenant);
    const healthy = await client.healthcheck();

    if (healthy) {
      logger.debug({ tenantSlug: tenant.slug }, "health check passed");
      continue;
    }

    logger.warn({ tenantSlug: tenant.slug }, "health check failed, attempting restart");

    try {
      // startInstance treats Docker's 304 "already started" as success, so a
      // running-but-unresponsive container is not flipped to error here.
      await startInstance(tenant.containerId!);
      logger.info({ tenantSlug: tenant.slug }, "start issued (or container already running)");
    } catch (err) {
      logger.error({ tenantSlug: tenant.slug, err }, "restart failed, marking tenant error");
      await db
        .update(tenants)
        .set({ status: "error", updatedAt: new Date() })
        .where(eq(tenants.id, tenant.id));
    }
  }
}

/**
 * Coordinator mode: probe the single shared coordinator. Its health is not a
 * per-tenant property, so an outage is only logged — tenant status is never
 * flipped to "error" by it. When health transitions to healthy (including
 * the first successful probe after this service starts), per-tenant state
 * the coordinator keeps only in memory is pushed back and tenants left in
 * "error" by older monitor versions are recovered.
 */
async function checkCoordinator(): Promise<void> {
  if (!config.coordinatorUrl) return;
  const probe = new CoordinatorApiClient(config.coordinatorUrl, "", config.coordinatorApiKey);
  const bootId = await probe.probeBootId();

  if (bootId === null) {
    coordinatorFailCount++;
    const log = coordinatorFailCount >= 3 ? logger.error.bind(logger) : logger.warn.bind(logger);
    log({ consecutiveFailures: coordinatorFailCount }, "coordinator health check failed");
    syncedBootId = null;
    return;
  }

  coordinatorFailCount = 0;
  // A changed boot id means the coordinator restarted (even between sweeps) and lost its in-memory state.
  if (bootId === syncedBootId) return;

  logger.info({ bootId }, "coordinator (re)started or recovered — resyncing tenant state");
  const ok = await resyncCoordinatorState();
  // Leave unsynced on partial failure so the next sweep retries
  syncedBootId = ok ? bootId : null;
}

/**
 * Pushes the DB-held per-tenant config the coordinator keeps only in memory
 * (ACL policy, route auto-approvers, custom DERP regions + public-relay toggle) and recovers tenants
 * that the coordinator still knows about but that are marked "error".
 *
 * @returns true when every tenant was resynced successfully.
 */
export async function resyncCoordinatorState(): Promise<boolean> {
  if (!config.coordinatorUrl) return true;
  const rows = await db
    .select({
      id: tenants.id,
      slug: tenants.slug,
      status: tenants.status,
      coordinatorTenantId: tenants.coordinatorTenantId,
      customDerpRegions: tenants.customDerpRegions,
      usePublicDerp: tenants.usePublicDerp,
      coordinatorAclPolicy: tenants.coordinatorAclPolicy,
      coordinatorAutoApprovers: tenants.coordinatorAutoApprovers,
    })
    .from(tenants)
    .where(
      and(
        isNotNull(tenants.coordinatorTenantId),
        inArray(tenants.status, ["running", "error"]),
      ),
    );

  let allOk = true;
  for (const t of rows) {
    const client = new CoordinatorApiClient(
      config.coordinatorUrl,
      t.coordinatorTenantId!,
      config.coordinatorApiKey,
    );
    try {
      if (t.status === "error") {
        // Only recover tenants the coordinator actually has; a provisioning
        // failure can leave a coordinatorTenantId whose tenant was rolled back.
        if (!(await client.tenantExists())) continue;
        await db
          .update(tenants)
          .set({ status: "running", updatedAt: new Date() })
          .where(and(eq(tenants.id, t.id), eq(tenants.status, "error")));
        logger.info({ tenantSlug: t.slug }, "tenant recovered after coordinator became healthy");
      }

      if (t.coordinatorAclPolicy) {
        await client.setHeadscalePolicy(t.coordinatorAclPolicy as Parameters<CoordinatorApiClient["setHeadscalePolicy"]>[0]);
      }

      if (t.coordinatorAutoApprovers) {
        await client.pushAutoApprovers(t.coordinatorAutoApprovers);
      }

      await pushTenantIdentity(t.id, t.coordinatorTenantId!);
      // Access rules and names are stored by the coordinator; this covers a
      // first start after an upgrade and a change that failed to push
      if (!(await syncTenantAccess(t.id))) allOk = false;

      const regions = (t.customDerpRegions ?? []) as DerpRegion[];
      const isDefault = regions.length === 0 && t.usePublicDerp;
      if (!isDefault) {
        if (regions.length === 0 && !t.usePublicDerp) {
          logger.warn({ tenantSlug: t.slug }, "skipping DERP resync: no regions and public relays disabled");
        } else {
          await client.setDerp(regions, t.usePublicDerp);
        }
      }
    } catch (err) {
      allOk = false;
      logger.error({ tenantSlug: t.slug, err }, "failed to resync tenant state to coordinator");
    }
  }
  return allOk;
}

/**
 * Hibernate tenants whose lastActivityAt exceeds their hibernateAfterDays threshold.
 * Only considers running tenants with hibernateAfterDays > 0.
 */
export async function hibernateIdleTenants(): Promise<void> {
  const filters = [
    eq(tenants.status, "running"),
    gt(tenants.hibernateAfterDays, 0),
  ];
  if (!useCoordinator) {
    filters.push(isNotNull(tenants.containerId));
  }

  const candidates = await db
    .select({
      id: tenants.id,
      slug: tenants.slug,
      containerId: tenants.containerId,
      ownerUserId: tenants.ownerUserId,
      hibernateAfterDays: tenants.hibernateAfterDays,
      lastActivityAt: tenants.lastActivityAt,
    })
    .from(tenants)
    .where(and(...filters));

  const now = Date.now();

  for (const tenant of candidates) {
    const idleMs = now - tenant.lastActivityAt.getTime();
    const thresholdMs = tenant.hibernateAfterDays * 24 * 60 * 60 * 1000;

    if (idleMs < thresholdMs) continue;

    logger.info(
      { tenantSlug: tenant.slug, idleDays: Math.floor(idleMs / 86_400_000) },
      "hibernating idle tenant",
    );

    try {
      if (tenant.containerId) {
        await stopInstance(tenant.containerId);
      }
      await db
        .update(tenants)
        .set({ status: "stopped", updatedAt: new Date() })
        .where(eq(tenants.id, tenant.id));

      logAudit({
        tenantId: tenant.id,
        actorUserId: tenant.ownerUserId,
        action: "tenant_hibernated",
        targetType: "tenant",
        targetId: tenant.id,
        metadata: { idleDays: Math.floor(idleMs / 86_400_000), threshold: tenant.hibernateAfterDays },
      });
    } catch (err) {
      logger.error({ tenantSlug: tenant.slug, err }, "failed to hibernate tenant");
    }
  }
}

/**
 * Check the health of a single tenant's Headscale instance.
 * Returns a status object suitable for the per-tenant health endpoint.
 */
export async function checkTenantHealth(
  tenant: { port: number; apiKey: string; coordinatorTenantId?: string | null },
): Promise<{ healthy: boolean }> {
  const client = getControlClient(tenant);
  const healthy = await client.healthcheck();
  return { healthy };
}

/**
 * Record a usage snapshot for each running tenant.
 * Counts devices (from Headscale API) and members (from DB).
 */
export async function recordUsageSnapshots(): Promise<void> {
  const usageWhere = useCoordinator
    ? eq(tenants.status, "running")
    : and(eq(tenants.status, "running"), isNotNull(tenants.containerId));
  const running = await db
    .select({
      id: tenants.id,
      port: tenants.port,
      apiKey: tenants.apiKey,
      coordinatorTenantId: tenants.coordinatorTenantId,
    })
    .from(tenants)
    .where(usageWhere);

  for (const tenant of running) {
    try {
      const client = getControlClient(tenant);
      const [nodes, routes, memberRows] = await Promise.all([
        client.listNodes(),
        client.listRoutes().catch(() => []),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(memberships)
          .where(eq(memberships.tenantId, tenant.id)),
      ]);

      await db.insert(usageSnapshots).values({
        tenantId: tenant.id,
        deviceCount: nodes.length,
        onlineDevices: nodes.filter((n) => n.online).length,
        routeCount: routes.length,
        memberCount: memberRows[0]?.count ?? 0,
      });
    } catch (err) {
      logger.error({ tenantId: tenant.id, err }, "failed to record usage snapshot");
    }
  }
}

/** Start the background health-check interval. Call once after server listen. */
export function startHealthMonitor(intervalMs = 60_000): void {
  logger.info({ intervalMs }, "starting health monitor");
  let tick = 0;
  let sweeping = false;
  setInterval(async () => {
    // With several replicas, only the leader does the sweep (ADR-0034)
    if (!isLeader()) return;
    // Never start a sweep while the previous one is still running
    if (sweeping) {
      logger.warn("previous health sweep still running — skipping tick");
      return;
    }
    sweeping = true;
    tick++;
    try {
      await checkAllTenants();
      await hibernateIdleTenants();
      // Caddy drops admin-API routes when it restarts from its Caddyfile.
      await syncTenantRoutes().catch((err) =>
        logger.warn({ err }, "failed to sync Caddy routes"),
      );
      if (useCoordinator) {
        await notifyRefusedMachines().catch((err) =>
          logger.warn({ err }, "failed to notify about refused machines"),
        );
      }
      if (tick % 5 === 0) {
        if (useCoordinator) {
          // New members / renamed handles (coordinator only notifies clients on change)
          await syncAllTenantIdentities().catch((err) =>
            logger.warn({ err }, "failed to sync tenant identities"),
          );
        }
        await recordUsageSnapshots();
        await sweepExpiredJtis().catch((err) =>
          logger.warn({ err }, "failed to sweep expired JTIs"),
        );
        await sweepExpiredOAuthStates().catch((err) =>
          logger.warn({ err }, "failed to sweep expired OAuth states"),
        );
        await endExpiredShares().catch((err) =>
          logger.warn({ err }, "failed to end expired device shares"),
        );
      }
    } catch (err) {
      logger.error({ err }, "health monitor sweep failed");
    } finally {
      sweeping = false;
    }
  }, intervalMs);
}
