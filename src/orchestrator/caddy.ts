import { config } from "../config.js";

const CADDY_ADMIN_URL =
  process.env.CADDY_ADMIN_URL ?? "http://localhost:2019";

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
  const res = await fetch(`${CADDY_ADMIN_URL}${path}`, {
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

export async function ensureCaddyBaseConfig(): Promise<void> {
  const baseConfig = {
    apps: {
      http: {
        servers: {
          tailnet_proxy: {
            listen: [":80"],
            routes: [
              {
                match: [{ host: [`api.${config.baseDomain}`] }],
                handle: [
                  {
                    handler: "reverse_proxy",
                    upstreams: [{ dial: `localhost:${config.port}` }],
                  },
                ],
              },
            ],
          },
        },
      },
    },
  };

  await caddyRequest("POST", "/load", baseConfig);
}

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

  try {
    await caddyRequest(
      "POST",
      "/config/apps/http/servers/tailnet_proxy/routes",
      route,
    );
  } catch (err) {
    console.error(`Failed to add Caddy route for ${slug}:`, err);
  }
}

export async function removeTenantRoute(slug: string): Promise<void> {
  try {
    const serverConfig = (await caddyRequest(
      "GET",
      "/config/apps/http/servers/tailnet_proxy/routes",
    )) as CaddyRoute[] | null;

    if (!serverConfig) return;

    const idx = serverConfig.findIndex(
      (r) =>
        r.match?.[0]?.host?.[0] === `${slug}.${config.baseDomain}`,
    );

    if (idx >= 0) {
      await caddyRequest(
        "DELETE",
        `/config/apps/http/servers/tailnet_proxy/routes/${idx}`,
      );
    }
  } catch (err) {
    console.error(`Failed to remove Caddy route for ${slug}:`, err);
  }
}
