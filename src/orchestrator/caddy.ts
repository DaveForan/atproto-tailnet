/**
 * @module orchestrator/caddy
 * Dynamic subdomain routing via the Caddy admin API.
 * Adds and removes reverse-proxy routes that map `{slug}.{baseDomain}`
 * to a tenant's Headscale container port on localhost.
 */

import { config } from "../config.js";

interface CaddyRoute {
  match: Array<{ host: string[] }>;
  handle: Array<{
    handler: string;
    upstreams?: Array<{ dial: string }>;
    routes?: CaddyRoute[];
  }>;
}

async function caddyRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`${config.caddyAdminUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Caddy admin API ${method} ${path} failed (${res.status}): ${text}`,
    );
  }

  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return null;
  }
  return res.json();
}

/** Register a reverse-proxy route from `{slug}.{baseDomain}` to the tenant's local port. */
export async function addTenantRoute(
  slug: string,
  port: number,
): Promise<void> {
  const route: CaddyRoute = {
    match: [{ host: [`${slug}.${config.baseDomain}`] }],
    handle: [
      {
        handler: "reverse_proxy",
        upstreams: [{ dial: `localhost:${port}` }],
      },
    ],
  };

  await caddyRequest(
    "POST",
    "/config/apps/http/servers/tailnet_proxy/routes",
    route,
  );
}

/** Remove the reverse-proxy route for a tenant. No-op if the route does not exist. */
export async function removeTenantRoute(slug: string): Promise<void> {
  const serverConfig = (await caddyRequest(
    "GET",
    "/config/apps/http/servers/tailnet_proxy/routes",
  )) as CaddyRoute[] | null;

  if (!serverConfig) return;

  const idx = serverConfig.findIndex(
    (r) => r.match?.[0]?.host?.[0] === `${slug}.${config.baseDomain}`,
  );

  if (idx >= 0) {
    await caddyRequest(
      "DELETE",
      `/config/apps/http/servers/tailnet_proxy/routes/${idx}`,
    );
  }
}
