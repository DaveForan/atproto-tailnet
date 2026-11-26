import { describe, it, expect, vi, afterEach } from "vitest";
import { CoordinatorApiClient, toControlNode } from "../orchestrator/coordinator-api.js";
import { routeId } from "../orchestrator/control-types.js";

function mockFetch(responses: Array<{ status?: number; body?: unknown }>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined });
    const r = responses.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const node = {
  id: 7,
  tenant_id: "T",
  ipv4: "100.64.1.2",
  stable_id: "abc",
  hostname: "laptop",
  online: true,
  owner: "user-1",
  tags: [],
  ephemeral: false,
  advertised_routes: ["10.0.0.0/24", "0.0.0.0/0", "::/0"],
  approved_routes: [],
};

describe("CoordinatorApiClient", () => {
  it("maps owner to the node user", () => {
    expect(toControlNode(node).user).toEqual({ id: "user-1", name: "user-1" });
    expect(toControlNode({ ...node, owner: null }).user).toBeNull();
  });

  it("creates keys with owner and an expiry, returning the key id", async () => {
    const calls = mockFetch([{ status: 201, body: { key: "k".repeat(40), id: "uuid-1", tenant_id: "T", expires_at: null } }]);
    const c = new CoordinatorApiClient("http://coord", "T", "adm");
    const k = await c.createPreAuthKey({ owner: "user-1", expirationSeconds: 3600, reusable: true });
    expect(k.id).toBe("uuid-1");
    expect(calls[0].body).toMatchObject({ tenant_id: "T", owner: "user-1", expiration_seconds: 3600, reusable: true });
  });

  it("tagged keys pass tags and ephemeral", async () => {
    const calls = mockFetch([{ status: 201, body: { key: "k", id: "u", tenant_id: "T" } }]);
    await new CoordinatorApiClient("http://coord", "T").createTaggedPreAuthKey(["tag:federation-relay"], {
      expirationSeconds: 300,
      ephemeral: true,
    });
    expect(calls[0].body).toMatchObject({ tags: ["tag:federation-relay"], ephemeral: true, expiration_seconds: 300 });
  });

  it("lists routes per node and approves exit routes together", async () => {
    const calls = mockFetch([
      { body: { nodes: [node] } },
      { body: node },
      { body: node },
    ]);
    const c = new CoordinatorApiClient("http://coord", "T");
    const routes = await c.listRoutes();
    expect(routes.map((r) => r.prefix).sort()).toEqual(["0.0.0.0/0", "10.0.0.0/24", "::/0"]);
    await c.enableRoute(routeId("7", "0.0.0.0/0"));
    expect(calls[2].url).toBe("http://coord/api/tenants/T/nodes/7/routes");
    expect((calls[2].body as { approved: string[] }).approved.sort()).toEqual(["0.0.0.0/0", "::/0"]);
  });

  it("accepts the readable nodeId:cidr route id", async () => {
    const calls = mockFetch([{ body: { ...node, approved_routes: ["10.0.0.0/24"] } }, { body: node }]);
    await new CoordinatorApiClient("http://coord", "T").disableRoute("7:10.0.0.0/24");
    expect(calls[1].body).toEqual({ approved: [] });
  });

  it("revokes and deletes by owner", async () => {
    const calls = mockFetch([{ body: { revoked: 2 } }, { body: { deleted: 1 } }]);
    const c = new CoordinatorApiClient("http://coord", "T");
    expect(await c.revokePreAuthKeysByOwner("user 1")).toBe(2);
    expect(await c.deleteNodesByOwner("user 1")).toBe(1);
    expect(calls[0]).toMatchObject({ method: "DELETE", url: "http://coord/api/tenants/T/preauth-keys?owner=user%201" });
    expect(calls[1]).toMatchObject({ method: "DELETE", url: "http://coord/api/tenants/T/nodes?owner=user%201" });
  });
});
