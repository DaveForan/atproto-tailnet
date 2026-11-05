import { describe, it, expect } from "vitest";
import {
  applyTenantRouter,
  buildTenantRouter,
  tenantUpstream,
  CADDY_SERVER,
  TENANT_ROUTER_ID,
  type CaddyRequest,
  type CaddyRoute,
} from "../orchestrator/caddy.js";
import { tenantPublicUrl } from "../config.js";

const opts = { baseDomain: "ts.example.com", network: "tenants-net" };
const ROUTES = `/config/apps/http/servers/${CADDY_SERVER}/routes`;

/** A fake Caddy admin API holding one server's route list. */
function fakeCaddy(initial: CaddyRoute[] | null | "no-server") {
  let routes = initial;
  const calls: string[] = [];
  const request: CaddyRequest = async (method, path, body) => {
    calls.push(`${method} ${path}`);
    const list = Array.isArray(routes) ? routes : [];
    const idx = list.findIndex((r) => r["@id"] === TENANT_ROUTER_ID);

    if (path === `/id/${TENANT_ROUTER_ID}`) {
      if (idx < 0) return { status: 404, body: '{"error":"unknown object ID"}' };
      if (method === "GET") {
        // Caddy returns keys in its own order — reverse them to prove order is ignored.
        const reordered = Object.fromEntries(Object.entries(list[idx]).reverse());
        return { status: 200, body: JSON.stringify(reordered) };
      }
      if (method === "PATCH") {
        list[idx] = body as CaddyRoute;
        return { status: 200, body: "" };
      }
    }
    if (path === ROUTES && method === "GET") {
      return routes === "no-server"
        ? { status: 400, body: '{"error":"invalid traversal path"}' }
        : { status: 200, body: JSON.stringify(routes) };
    }
    if (path === `${ROUTES}/0` && method === "PUT" && Array.isArray(routes)) {
      routes.unshift(body as CaddyRoute);
      return { status: 200, body: "" };
    }
    if (path === ROUTES && method === "PUT" && routes === null) {
      routes = body as CaddyRoute[];
      return { status: 200, body: "" };
    }
    return { status: 500, body: `unexpected ${method} ${path}` };
  };
  return { request, calls, routes: () => routes as CaddyRoute[] };
}

describe("tenantUpstream", () => {
  it("dials the container by name on a shared network", () => {
    expect(tenantUpstream({ slug: "acme", port: 10007 }, "tenants-net")).toBe(
      "headscale-acme:8080",
    );
  });

  it("dials the published localhost port without one", () => {
    expect(tenantUpstream({ slug: "acme", port: 10007 }, undefined)).toBe("localhost:10007");
  });
});

describe("buildTenantRouter", () => {
  const router = buildTenantRouter(
    [
      { slug: "zeta", port: 10002 },
      { slug: "acme", port: 10001 },
    ],
    opts,
  );
  const inner = router.handle[0].routes!;

  it("is one tagged, terminal route for the whole base domain", () => {
    expect(router["@id"]).toBe(TENANT_ROUTER_ID);
    expect(router.match).toEqual([{ host: ["*.ts.example.com"] }]);
    expect(router.terminal).toBe(true);
    expect(router.handle).toHaveLength(1);
  });

  it("has one reverse proxy per tenant, in a stable order", () => {
    expect(inner.slice(0, 2)).toEqual([
      {
        match: [{ host: ["acme.ts.example.com"] }],
        handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "headscale-acme:8080" }] }],
      },
      {
        match: [{ host: ["zeta.ts.example.com"] }],
        handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "headscale-zeta:8080" }] }],
      },
    ]);
  });

  it("ends with a 404 so unknown names never reach the main app", () => {
    const last = inner[inner.length - 1];
    expect(last.match).toBeUndefined();
    expect(last.handle[0]).toMatchObject({ handler: "static_response", status_code: 404 });
  });

  it("still answers 404 when there are no tenants", () => {
    expect(buildTenantRouter([], opts).handle[0].routes).toHaveLength(1);
  });
});

describe("applyTenantRouter", () => {
  const caddyfileRoute: CaddyRoute = { handle: [{ handler: "reverse_proxy" }] };
  const one = buildTenantRouter([{ slug: "acme", port: 10001 }], opts);
  const two = buildTenantRouter(
    [
      { slug: "acme", port: 10001 },
      { slug: "zeta", port: 10002 },
    ],
    opts,
  );

  it("inserts the route ahead of the Caddyfile's routes on first run", async () => {
    const caddy = fakeCaddy([caddyfileRoute]);
    expect(await applyTenantRouter(one, caddy.request)).toBe("created");
    expect(caddy.routes()).toEqual([one, caddyfileRoute]);
  });

  it("does not write when Caddy already has the same route", async () => {
    const caddy = fakeCaddy([structuredClone(one), caddyfileRoute]);
    expect(await applyTenantRouter(one, caddy.request)).toBe("unchanged");
    expect(caddy.calls).toEqual([`GET /id/${TENANT_ROUTER_ID}`]);
  });

  it("replaces the route in place when tenants change, never duplicating it", async () => {
    const caddy = fakeCaddy([structuredClone(one), caddyfileRoute]);
    expect(await applyTenantRouter(two, caddy.request)).toBe("updated");
    expect(caddy.routes()).toEqual([two, caddyfileRoute]);
  });

  it("creates the route list when the server has none", async () => {
    const caddy = fakeCaddy(null);
    expect(await applyTenantRouter(one, caddy.request)).toBe("created");
    expect(caddy.routes()).toEqual([one]);
  });

  it("explains the Caddyfile requirement when the named server is missing", async () => {
    const caddy = fakeCaddy("no-server");
    await expect(applyTenantRouter(one, caddy.request)).rejects.toThrow(
      /no HTTP server named "tailnet_proxy".*servers \{ name tailnet_proxy \}/s,
    );
  });

  it("surfaces a failed write", async () => {
    const request: CaddyRequest = async (method) =>
      method === "GET"
        ? { status: 200, body: JSON.stringify(one) }
        : { status: 500, body: "boom" };
    await expect(applyTenantRouter(two, request)).rejects.toThrow(/PATCH .* failed \(500\): boom/);
  });
});

describe("tenantPublicUrl", () => {
  it("uses the base domain with no port by default", () => {
    // Test env sets neither PUBLIC_URL nor TENANT_PUBLIC_PORT.
    expect(tenantPublicUrl("acme")).toBe("http://acme.ts.localhost");
  });
});
