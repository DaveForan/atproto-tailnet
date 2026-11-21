/**
 * @module orchestrator/caddy
 * Tenant subdomain routing via the Caddy admin API. We own one route, kept first in `tailnet_proxy`.
 * Caddy forgets admin-API changes on restart, so each sync writes the whole route from the database.
 */

import http from "node:http";
import https from "node:https";
import { isDeepStrictEqual } from "node:util";
import { and, isNotNull, ne } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { tenants } from "../db/schema.js";
import { logger } from "../logger.js";
import {
  HEADSCALE_CONTAINER_PORT,
  ensureOnTenantNetwork,
  tenantContainerName,
} from "./headscale.js";
import { useCoordinator } from "./control-client.js";
import { liveHostnamesByTenant } from "./hostnames.js";

/** The Caddyfile sets this server name. */
export const CADDY_SERVER = "tailnet_proxy";
export const TENANT_ROUTER_ID = "tailnet_tenants";

const SERVER_PATH = `/config/apps/http/servers/${CADDY_SERVER}`;

interface CaddyHandler {
  handler: string;
  upstreams?: Array<{ dial: string }>;
  headers?: {
    request?: {
      set?: Record<string, string[]>;
    };
  };
  routes?: CaddyRoute[];
  status_code?: number;
  body?: string;
}

export interface CaddyRoute {
  "@id"?: string;
  match?: Array<{ host: string[] }>;
  handle: CaddyHandler[];
  terminal?: boolean;
}

export interface RoutableTenant {
  /** Internal id: the coordinator's tenant slug and the Headscale container name. */
  slug: string;
  port: number;
  /** Live public names (primary first). Defaults to `[slug]`. */
  hostnames?: string[];
}

export interface CaddyResponse {
  status: number;
  body: string;
}

export type CaddyRequest = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<CaddyResponse>;

/**
 * Uses `node:http`, because `fetch` adds a `Sec-Fetch-Mode` header.
 * Caddy 2.11+ then treats the caller as a browser and returns 403 for no allowed Origin.
 */
const caddyRequest: CaddyRequest = (method, path, body) => {
  const url = new URL(path, config.caddyAdminUrl);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method,
        timeout: 10_000,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("Caddy admin API timed out")));
    req.on("error", reject);
    req.end(payload);
  });
};

function ok(res: CaddyResponse): boolean {
  return res.status >= 200 && res.status < 300;
}

function fail(method: string, path: string, res: CaddyResponse): Error {
  return new Error(
    `Caddy admin API ${method} ${path} failed (${res.status}): ${res.body.trim()}`,
  );
}

/** Caddy's upstream for a tenant: the shared coordinator, or the tenant's Headscale container. */
export function tenantUpstream(
  tenant: RoutableTenant,
  network = config.headscale.network,
): string {
  if (useCoordinator && config.coordinatorUrl) {
    const url = new URL(config.coordinatorUrl);
    return `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
  }
  return network
    ? `${tenantContainerName(tenant.slug)}:${HEADSCALE_CONTAINER_PORT}`
    : `localhost:${tenant.port}`;
}

// Security: /health stays private because it leaks the coordinator boot_id. Clients do not need it.
export const COORDINATOR_PUBLIC_PATHS = ["/key", "/ts2021"];

function hostsFor(t: RoutableTenant, baseDomain: string): string[] {
  const names = t.hostnames && t.hostnames.length > 0 ? t.hostnames : [t.slug];
  return names.map((n) => `${n}.${baseDomain}`);
}

/** Unknown names under the base domain get a 404, so they never fall through to the main app. */
export function buildTenantRouter(
  routable: RoutableTenant[],
  opts: { baseDomain?: string; network?: string; coordinator?: boolean } = {},
): CaddyRoute {
  const coordinator = opts.coordinator ?? useCoordinator;
  const baseDomain = opts.baseDomain ?? config.baseDomain;
  const network = "network" in opts ? opts.network : config.headscale.network;
  const sorted = [...routable].sort((a, b) => a.slug.localeCompare(b.slug));

  return {
    "@id": TENANT_ROUTER_ID,
    match: [{ host: [`*.${baseDomain}`] }],
    handle: [
      {
        handler: "subroute",
        routes: [
          ...sorted.map((t) => ({
            // Security: the coordinator serves its admin API (/api/*) on this port too.
            // Expose only the paths that Tailscale clients need.
            match: [
              coordinator
                ? { host: hostsFor(t, baseDomain), path: COORDINATOR_PUBLIC_PATHS }
                : { host: hostsFor(t, baseDomain) },
            ],
            handle: [
              {
                handler: "reverse_proxy",
                upstreams: [{ dial: tenantUpstream(t, network) }],
                ...(coordinator
                  ? {
                      headers: {
                        request: {
                          set: { "X-Tenant-Slug": [t.slug] },
                        },
                      },
                    }
                  : {}),
              },
            ],
          })),
          {
            handle: [
              {
                handler: "static_response",
                status_code: 404,
                body: "Unknown tailnet\n",
              },
            ],
          },
        ],
      },
    ],
    terminal: true,
  };
}

/** Writes only when the route differs, because each admin-API write reloads the whole Caddy config. */
export async function applyTenantRouter(
  desired: CaddyRoute,
  request: CaddyRequest = caddyRequest,
): Promise<"unchanged" | "updated" | "created"> {
  const idPath = `/id/${TENANT_ROUTER_ID}`;
  const current = await request("GET", idPath);

  if (ok(current)) {
    if (isDeepStrictEqual(JSON.parse(current.body), desired)) return "unchanged";
    const res = await request("PATCH", idPath, desired);
    if (!ok(res)) throw fail("PATCH", idPath, res);
    return "updated";
  }

  // Insert ahead of the Caddyfile's routes, so that a wildcard site cannot shadow it
  const routesPath = `${SERVER_PATH}/routes`;
  const routes = await request("GET", routesPath);
  if (!ok(routes)) {
    throw new Error(
      `Caddy has no HTTP server named "${CADDY_SERVER}" — the Caddyfile must name ` +
        `it with the global option \`servers { name ${CADDY_SERVER} }\` ` +
        `(GET ${routesPath}: ${routes.status} ${routes.body.trim()})`,
    );
  }

  const hasRoutes = Array.isArray(JSON.parse(routes.body));
  const [path, body] = hasRoutes
    ? [`${routesPath}/0`, desired as unknown]
    : [routesPath, [desired] as unknown];
  const res = await request("PUT", path, body);
  if (!ok(res)) throw fail("PUT", path, res);
  return "created";
}

async function listRoutableTenants(): Promise<
  Array<RoutableTenant & { containerId: string | null }>
> {
  const whereClause = useCoordinator
    ? ne(tenants.status, "deleted")
    : and(ne(tenants.status, "deleted"), isNotNull(tenants.containerId));
  const rows = await db
    .select({
      id: tenants.id,
      slug: tenants.slug,
      port: tenants.port,
      containerId: tenants.containerId,
    })
    .from(tenants)
    .where(whereClause)
    .orderBy(tenants.slug);
  const names = await liveHostnamesByTenant(rows.map((r) => r.id));
  return rows.map((r) => ({
    slug: r.slug,
    port: r.port,
    containerId: r.containerId,
    hostnames: names.get(r.id) ?? [r.slug],
  }));
}

// Syncs run in series, because overlapping read-compare-write cycles can both insert the route
let syncQueue: Promise<unknown> = Promise.resolve();

/** Call after a tenant instance is added or removed. The monitor also calls it each sweep. */
export function syncTenantRoutes(): Promise<void> {
  // CADDY_ADMIN_URL=off: the edge proxy has static routes
  if (!config.caddyEnabled) return Promise.resolve();
  const run = syncQueue.then(async () => {
    const routable = await listRoutableTenants();
    const outcome = await applyTenantRouter(buildTenantRouter(routable));
    if (outcome !== "unchanged") {
      logger.info({ outcome, tenants: routable.length }, "caddy tenant routes synced");
    }
  });
  syncQueue = run.catch(() => undefined);
  return run;
}

/**
 * Attaches older tenant containers to the shared network, then syncs routes.
 * It logs failures and never throws, so the service starts when Caddy is down.
 */
export async function reconcileTenantRouting(): Promise<void> {
  try {
    if (!useCoordinator) {
      for (const tenant of await listRoutableTenants()) {
        if (tenant.containerId) {
          await ensureOnTenantNetwork(tenant.containerId).catch((err) =>
            logger.error(
              { tenantSlug: tenant.slug, err },
              "failed to attach tenant container to the tenant network",
            ),
          );
        }
      }
    }
    await syncTenantRoutes();
  } catch (err) {
    logger.error({ err }, "failed to reconcile tenant routing");
  }
}
