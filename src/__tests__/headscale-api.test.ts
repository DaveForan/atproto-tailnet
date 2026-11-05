import { describe, it, expect, vi, afterEach } from "vitest";
import {
  HeadscaleApiClient,
  routeId,
  parseRouteId,
  routesOfNode,
  withRouteApproval,
} from "../orchestrator/headscale-api.js";

type Call = { method: string; path: string; body?: unknown };

/** Stub fetch with a handler keyed on "METHOD path"; records every call. */
function stubHeadscale(handler: (call: Call) => unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method: string; body?: string }) => {
      const call: Call = {
        method: init.method,
        path: url.replace("http://localhost:10001", ""),
        body: init.body ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      return { ok: true, status: 200, json: async () => handler(call) };
    }),
  );
  return calls;
}

const client = () => new HeadscaleApiClient(10001, "key");

describe("HeadscaleApiClient users and pre-auth keys (0.29 API)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates a pre-auth key with the user's numeric id, not the name", async () => {
    const calls = stubHeadscale((c) =>
      c.method === "GET"
        ? { users: [{ id: "7", name: "owner" }] }
        : { preAuthKey: { id: "3", key: "hskey-auth-abc", user: { id: "7", name: "owner" } } },
    );

    const key = await client().createPreAuthKey("owner");

    expect(key.key).toBe("hskey-auth-abc");
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/v1/user?name=owner" });
    expect(calls[1]).toMatchObject({ method: "POST", path: "/api/v1/preauthkey" });
    expect((calls[1].body as { user: string }).user).toBe("7");
  });

  it("only accepts an exact name match", async () => {
    stubHeadscale(() => ({ users: [{ id: "7", name: "owner-2" }] }));
    await expect(client().createPreAuthKey("owner")).rejects.toThrow(/not found/);
  });

  it("deletes a user by id and is a no-op when the user is absent", async () => {
    const calls = stubHeadscale((c) =>
      c.path.endsWith("name=alice") ? { users: [{ id: "4", name: "alice" }] } : { users: [] },
    );

    await client().deleteUser("alice");
    await client().deleteUser("ghost");

    expect(calls.filter((c) => c.method === "DELETE")).toEqual([
      { method: "DELETE", path: "/api/v1/user/4", body: undefined },
    ]);
  });
});

describe("routes derived from nodes", () => {
  afterEach(() => vi.unstubAllGlobals());

  const node = {
    id: "5",
    name: "router",
    givenName: "router",
    online: true,
    availableRoutes: ["10.0.0.0/24", "0.0.0.0/0", "::/0"],
    approvedRoutes: ["10.0.0.0/24", "192.168.9.0/24"],
    subnetRoutes: ["10.0.0.0/24"],
  };

  it("round-trips route ids, including IPv6 prefixes", () => {
    for (const prefix of ["10.0.0.0/24", "::/0", "fd7a:115c:a1e0::/48"]) {
      const id = routeId("12", prefix);
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(parseRouteId(id)).toEqual({ nodeId: "12", prefix });
    }
    expect(parseRouteId("12")).toBeNull();
    expect(parseRouteId("x-MTAuMC4wLjAvMjQ")).toBeNull();
    expect(parseRouteId("12-!!")).toBeNull();
  });

  it("lists advertised and still-approved routes with their state", () => {
    const routes = routesOfNode(node);
    const byPrefix = Object.fromEntries(routes.map((r) => [r.prefix, r]));
    expect(routes).toHaveLength(4);
    expect(byPrefix["10.0.0.0/24"]).toMatchObject({ advertised: true, enabled: true, isPrimary: true });
    expect(byPrefix["0.0.0.0/0"]).toMatchObject({ advertised: true, enabled: false });
    expect(byPrefix["192.168.9.0/24"]).toMatchObject({ advertised: false, enabled: true });
    expect(byPrefix["10.0.0.0/24"].node).toMatchObject({ id: "5", online: true });
  });

  it("parses nodes with null expiry and lastSeen, as Headscale sends them", async () => {
    stubHeadscale(() => ({
      nodes: [{ id: "1", name: "laptop", expiry: null, lastSeen: null, user: { id: "1", name: "owner" } }],
    }));
    const nodes = await client().listNodes();
    expect(nodes).toHaveLength(1);
    expect(nodes[0].expiry).toBeNull();
  });

  it("returns no routes for a node without route fields", () => {
    expect(routesOfNode({ id: "1", name: "laptop" })).toEqual([]);
  });

  it("moves the two exit routes together", () => {
    expect(withRouteApproval(["10.0.0.0/24"], "::/0", true)).toEqual([
      "10.0.0.0/24",
      "0.0.0.0/0",
      "::/0",
    ]);
    expect(withRouteApproval(["0.0.0.0/0", "::/0", "10.0.0.0/24"], "0.0.0.0/0", false)).toEqual([
      "10.0.0.0/24",
    ]);
    expect(withRouteApproval(["10.0.0.0/24"], "10.0.0.0/24", true)).toEqual(["10.0.0.0/24"]);
  });

  it("enables a route by sending the node's full approved list", async () => {
    const calls = stubHeadscale(() => ({ node }));
    await client().enableRoute(routeId("5", "0.0.0.0/0"));
    expect(calls[1]).toEqual({
      method: "POST",
      path: "/api/v1/node/5/approve_routes",
      body: { routes: ["10.0.0.0/24", "192.168.9.0/24", "0.0.0.0/0", "::/0"] },
    });
  });

  it("disable and delete both withdraw approval", async () => {
    for (const op of ["disableRoute", "deleteRoute"] as const) {
      const calls = stubHeadscale(() => ({ node }));
      await client()[op](routeId("5", "10.0.0.0/24"));
      expect(calls[1].body).toEqual({ routes: ["192.168.9.0/24"] });
    }
  });

  it("rejects a malformed route id without calling Headscale", async () => {
    const calls = stubHeadscale(() => ({}));
    await expect(client().enableRoute("../user/1")).rejects.toThrow(/Invalid route id/);
    expect(calls).toHaveLength(0);
  });
});
