/**
 * @module orchestrator/caddy
 * Tenant subdomain routing via the Caddy admin API.
 *
 * The service owns exactly one route in Caddy's config, tagged
 * `@id: tailnet_tenants` and kept first in the HTTP server named
 * `tailnet_proxy` (the Caddyfile names that server). It matches
 * `*.{baseDomain}` and contains one reverse-proxy route per tenant.
 *
 * The route is always written whole from the database
 * ({@link syncTenantRoutes}) rather than edited entry by entry, so it is
 * idempotent and self-healing: Caddy forgets admin-API changes when it
 * restarts from its Caddyfile, and the next sync puts them back.
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

/** Name of the Caddy HTTP server tenant routes live in — set in the Caddyfile. */
export const CADDY_SERVER = "tailnet_proxy";
/** `@id` of the route this service manages. */
export const TENANT_ROUTER_ID = "tailnet_tenants";

const SERVER_PATH = `/config/apps/http/servers/${CADDY_SERVER}`;

interface CaddyHandler {
  handler: string;
  upstreams?: Array<{ dial: string }>;
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
  slug: string;
  port: number;
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
 * One request to the Caddy admin API. Uses `node:http` rather than `fetch`:
 * `fetch` adds a `Sec-Fetch-Mode` header, which makes Caddy (2.11+) treat the
 * caller as a browser and reject it with 403 for having no allowed Origin.
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

/**
 * Where Caddy reaches a tenant's Headscale. With a shared Docker network
 * (`HEADSCALE_NETWORK`) that is the container by name; otherwise the port
 * published on localhost, which only works when Caddy runs on the host.
 */
export function tenantUpstream(
  tenant: RoutableTenant,
  network = config.headscale.network,
): string {
  return network
    ? `${tenantContainerName(tenant.slug)}:${HEADSCALE_CONTAINER_PORT}`
    : `localhost:${tenant.port}`;
}

/**
 * The managed route: `*.{baseDomain}` → one reverse proxy per tenant, and a
 * 404 for any other name under the base domain so it never falls through to
 * the main app.
 */
export function buildTenantRouter(
  routable: RoutableTenant[],
  opts: { baseDomain?: string; network?: string } = {},
): CaddyRoute {
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
            match: [{ host: [`${t.slug}.${baseDomain}`] }],
            handle: [
              {
                handler: "reverse_proxy",
                upstreams: [{ dial: tenantUpstream(t, network) }],
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

/**
 * Make Caddy's managed route equal `desired`. Writes only when it differs —
 * every admin-API write makes Caddy reload its whole config.
 */
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

  // Not there yet (first run, or Caddy restarted from its Caddyfile): insert
  // it ahead of the Caddyfile's own routes so a wildcard site cannot shadow it.
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

/** Tenants that have an instance to route to: everything not deleted with a container. */
async function listRoutableTenants(): Promise<
  Array<RoutableTenant & { containerId: string | null }>
> {
  return db
    .select({
      slug: tenants.slug,
      port: tenants.port,
      containerId: tenants.containerId,
    })
    .from(tenants)
    .where(and(ne(tenants.status, "deleted"), isNotNull(tenants.containerId)))
    .orderBy(tenants.slug);
}

// Syncs are serialized: two overlapping read-compare-write cycles could
// otherwise both insert the managed route.
let syncQueue: Promise<unknown> = Promise.resolve();

/**
 * Bring Caddy's tenant routes in line with the database. Call after anything
 * that adds or removes a tenant instance; the health monitor also calls it
 * every sweep so routes come back after a Caddy restart.
 */
export function syncTenantRoutes(): Promise<void> {
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
 * Startup reconciliation: attach every tenant container to the shared Docker
 * network (containers created before `HEADSCALE_NETWORK` was set are not on
 * it), then sync routes. Failures are logged, never thrown — the service
 * still starts when Caddy is down.
 */
export async function reconcileTenantRouting(): Promise<void> {
  try {
    for (const tenant of await listRoutableTenants()) {
      await ensureOnTenantNetwork(tenant.containerId!).catch((err) =>
        logger.error(
          { tenantSlug: tenant.slug, err },
          "failed to attach tenant container to the tenant network",
        ),
      );
    }
    await syncTenantRoutes();
  } catch (err) {
    logger.error({ err }, "failed to reconcile tenant routing");
  }
}
