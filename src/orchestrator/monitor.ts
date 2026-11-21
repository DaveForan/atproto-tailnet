/**
 * @module orchestrator/monitor
 * Background health-check and hibernation loop.
 * Headscale mode restarts failed containers. Coordinator mode probes once per sweep.
 * A coordinator outage never changes tenant status.
 */

import { eq, and, isNotNull, gt, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants, memberships, usageSnapshots, type DerpRegion } from "../db/schema.js";
import { config } from "../config.js";
import { getControlClient, getCoordinatorClient, useCoordinator } from "./control-client.js";
import type { CoordinatorApiClient } from "./coordinator-api.js";
import { startInstance, stopInstance } from "./headscale.js";
import { syncTenantRoutes } from "./caddy.js";
import { pushTenantIdentity, syncAllTenantIdentities } from "./coordinator-identity.js";
import { sweepExpiredJtis } from "../credentials/service-auth.js";
import { sweepExpiredOAuthStates } from "../auth/atproto.js";
import { logAudit } from "../audit/log.js";
import { endExpiredShares, syncTenantAccess } from "../access/sync.js";
import { logger } from "../logger.js";
import { isLeader } from "./leader.js";
import { notifyRefusedMachines } from "./machine-refusals.js";

/** Boot id of the coordinator whose in-memory state is in sync; null when not synced. */
let syncedBootId: string | null = null;
let coordinatorFailCount = 0;

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
      // Docker's 304 "already started" counts as success, so a hung container stays "running"
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
 * Coordinator health is not per tenant, so an outage is only logged.
 * On a new boot id it pushes back the state the coordinator keeps only in memory.
 */
async function checkCoordinator(): Promise<void> {
  if (!config.coordinatorUrl) return;
  const probe = getCoordinatorClient();
  const bootId = await probe.probeBootId();

  if (bootId === null) {
    coordinatorFailCount++;
    const log = coordinatorFailCount >= 3 ? logger.error.bind(logger) : logger.warn.bind(logger);
    log({ consecutiveFailures: coordinatorFailCount }, "coordinator health check failed");
    syncedBootId = null;
    return;
  }

  coordinatorFailCount = 0;
  // A changed boot id means a restart, even between sweeps, so in-memory state is lost
  if (bootId === syncedBootId) return;

  logger.info({ bootId }, "coordinator (re)started or recovered — resyncing tenant state");
  const ok = await resyncCoordinatorState();
  // Leave unsynced on partial failure so the next sweep retries
  syncedBootId = ok ? bootId : null;
}

/**
 * Pushes the per-tenant config that the coordinator keeps only in memory.
 * It also recovers "error" tenants that the coordinator still has. Returns true when all succeed.
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
    const client = getCoordinatorClient(t);
    try {
      if (t.status === "error") {
        // A failed provisioning can leave a coordinatorTenantId whose tenant was rolled back
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
        await client.setAutoApprovers(t.coordinatorAutoApprovers);
      }

      await pushTenantIdentity(t.id, t.coordinatorTenantId!);
      // The coordinator stores access rules, but a past push can have failed
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

/** Stops running tenants idle longer than `hibernateAfterDays`; 0 disables it. */
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

export async function checkTenantHealth(
  tenant: { port: number; apiKey: string; coordinatorTenantId?: string | null },
): Promise<{ healthy: boolean }> {
  const client = getControlClient(tenant);
  const healthy = await client.healthcheck();
  return { healthy };
}

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

let monitorTimer: ReturnType<typeof setInterval> | null = null;

/** Call once after the server listens. */
export function startHealthMonitor(intervalMs = 60_000): void {
  if (monitorTimer) return;
  logger.info({ intervalMs }, "starting health monitor");
  let tick = 0;
  let sweeping = false;
  monitorTimer = setInterval(async () => {
    // With several replicas, only the leader does the sweep (ADR-0034)
    if (!isLeader()) return;
    if (sweeping) {
      logger.warn("previous health sweep still running — skipping tick");
      return;
    }
    sweeping = true;
    tick++;
    try {
      await checkAllTenants();
      await hibernateIdleTenants();
      // Caddy drops admin-API routes when it restarts from its Caddyfile
      await syncTenantRoutes().catch((err) =>
        logger.warn({ err }, "failed to sync Caddy routes"),
      );
      if (useCoordinator) {
        await notifyRefusedMachines().catch((err) =>
          logger.warn({ err }, "failed to notify about refused machines"),
        );
      }
      // An expired share must stop working within a minute
      await endExpiredShares().catch((err) =>
        logger.warn({ err }, "failed to end expired device shares"),
      );
      if (tick % 5 === 0) {
        if (useCoordinator) {
          // Picks up new members and renamed handles
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
      }
    } catch (err) {
      logger.error({ err }, "health monitor sweep failed");
    } finally {
      sweeping = false;
    }
  }, intervalMs);
}

/** A sweep that is already running finishes on its own. */
export function stopHealthMonitor(): void {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = null;
}
