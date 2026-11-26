/**
 * @module orchestrator/monitor
 * Background loop: probes the coordinator once per sweep and runs the periodic jobs.
 * A coordinator outage never changes tenant status.
 */

import { eq, and, isNotNull, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants, memberships, usageSnapshots, type DerpRegion } from "../db/schema.js";
import { getCoordinatorClient } from "./control-client.js";
import type { CoordinatorApiClient } from "./coordinator-api.js";
import { syncTenantRoutes } from "./caddy.js";
import { pushTenantIdentity, syncAllTenantIdentities } from "./coordinator-identity.js";
import { sweepExpiredJtis } from "../credentials/service-auth.js";
import { sweepExpiredOAuthStates } from "../auth/atproto.js";
import { endExpiredShares, syncTenantAccess } from "../access/sync.js";
import { logger } from "../logger.js";
import { sweepWaitingDevices } from "./waiting-devices.js";
import { isLeader } from "./leader.js";
import { notifyRefusedMachines } from "./machine-refusals.js";

/** Boot id of the coordinator whose in-memory state is in sync; null when not synced. */
let syncedBootId: string | null = null;
let coordinatorFailCount = 0;

/**
 * Coordinator health is not per tenant, so an outage is only logged.
 * On a new boot id it pushes back the state the coordinator keeps only in memory.
 */
export async function checkCoordinator(): Promise<void> {
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
        await client.setAclPolicyFile(t.coordinatorAclPolicy as Parameters<CoordinatorApiClient["setAclPolicyFile"]>[0]);
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

export async function checkTenantHealth(tenant: { coordinatorTenantId?: string | null }): Promise<{ healthy: boolean }> {
  return { healthy: await getCoordinatorClient(tenant).healthcheck() };
}

export async function recordUsageSnapshots(): Promise<void> {
  const running = await db
    .select({ id: tenants.id, coordinatorTenantId: tenants.coordinatorTenantId })
    .from(tenants)
    .where(and(eq(tenants.status, "running"), isNotNull(tenants.coordinatorTenantId)));

  for (const tenant of running) {
    try {
      const client = getCoordinatorClient(tenant);
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
      await checkCoordinator();
      // Caddy drops admin-API routes when it restarts from its Caddyfile
      await syncTenantRoutes().catch((err) =>
        logger.warn({ err }, "failed to sync Caddy routes"),
      );
      await notifyRefusedMachines().catch((err) =>
        logger.warn({ err }, "failed to notify about refused machines"),
      );
      await sweepWaitingDevices().catch((err) =>
        logger.warn({ err }, "failed to check waiting devices"),
      );
      // An expired share must stop working within a minute
      await endExpiredShares().catch((err) =>
        logger.warn({ err }, "failed to end expired device shares"),
      );
      if (tick % 5 === 0) {
        // Picks up new members and renamed handles
        await syncAllTenantIdentities().catch((err) =>
          logger.warn({ err }, "failed to sync tenant identities"),
        );
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
