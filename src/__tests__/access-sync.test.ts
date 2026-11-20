/**
 * Access sync (ADR-0036): a device that registered again under another member
 * keeps its node id; the push closes what was tied to the old owner and
 * persists that, so access does not come back.
 *
 * DB is a chainable mock: each awaited query resolves to the next `results`
 * entry; writes are recorded.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const results: unknown[] = [];
  const writes: Array<{ op: string; table?: string; method: string; arg: unknown }> = [];
  function tableName(t: unknown): string | undefined {
    if (!t || typeof t !== "object") return undefined;
    const sym = Object.getOwnPropertySymbols(t).find((s) => s.description === "drizzle:Name");
    return sym ? (t as Record<symbol, string>)[sym] : undefined;
  }
  function chain(op: string, table?: string): unknown {
    if (op === "delete") writes.push({ op, table, method: "delete", arg: null });
    const proxy: unknown = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === "then") {
          const next = results.length ? results.shift() : [];
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(next).then(res, rej);
        }
        return (...args: unknown[]) => {
          if (prop === "set" || prop === "values") writes.push({ op, table, method: String(prop), arg: args[0] });
          return proxy;
        };
      },
    });
    return proxy;
  }
  const client = {
    listNodes: vi.fn(async () => [] as Array<{ id: string; user?: { id: string } }>),
    setAccess: vi.fn(async () => {}),
    setDns: vi.fn(async () => {}),
  };
  return { results, writes, chain, tableName, client, notifyUser: vi.fn() };
});

vi.mock("../db/index.js", () => ({
  db: {
    select: () => h.chain("select"),
    insert: (t: unknown) => h.chain("insert", h.tableName(t)),
    update: (t: unknown) => h.chain("update", h.tableName(t)),
    delete: (t: unknown) => h.chain("delete", h.tableName(t)),
  },
  pool: {},
}));
vi.mock("../config.js", () => ({
  config: { coordinatorUrl: "http://coord.test", coordinatorApiKey: "k", baseDomain: "ts.example.com", tailnetDnsUpstream: [] },
}));
vi.mock("../logger.js", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("../orchestrator/coordinator-api.js", () => ({ CoordinatorApiClient: vi.fn(function () { return h.client; }) }));
vi.mock("../orchestrator/hostnames.js", () => ({ primaryHostname: async () => "harbor" }));
vi.mock("../notifications/service.js", () => ({ notifyUser: h.notifyUser }));

import { syncTenantAccess, OWNER_CHANGED_REASON } from "../access/sync.js";

const T = "11111111-1111-4111-8111-111111111111";
const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CAROL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const tenant = { id: T, slug: "t-x", coordinatorTenantId: "ct", accessMode: "member" };
const share = {
  id: "s1", tenantId: T, ownerId: ALICE, guestId: BOB, ownerNodeId: "10", status: "active",
  ports: [{ proto: "tcp", first: 22, last: 22 }], guestNodeIds: [], expiresAt: null,
};
const post = {
  id: "p1", tenantId: T, authorId: ALICE, board: "public", status: "approved", title: "App", name: null,
  nodeId: "10", proto: "tcp", port: 3000,
};

beforeEach(() => {
  h.results.length = 0;
  h.writes.length = 0;
  vi.clearAllMocks();
});

describe("syncTenantAccess with a device that changed owner", () => {
  it("ends the share, withdraws the post and pushes no rule for them", async () => {
    h.client.listNodes.mockResolvedValueOnce([
      { id: "10", user: { id: CAROL } },
      { id: "20", user: { id: BOB } },
    ]);
    h.results.push(
      [tenant],
      [post], // closeStaleAccess: posts
      [{ postId: "p1", userId: BOB, nodeId: "20" }], // connections
      [share], // shares
      undefined, // delete connections of p1
      undefined, // withdraw p1
      [{ id: "s1" }], // end s1
      [post], // loadTenantAccess: posts (the mock does not apply the writes; the compiler still drops them)
      [{ postId: "p1", userId: BOB, nodeId: "20" }],
      [share],
      [], // loadTenantDns: posts
    );
    expect(await syncTenantAccess(T)).toBe(true);

    const postUpdate = h.writes.find((w) => w.op === "update" && w.table === "service_posts")?.arg;
    expect(postUpdate).toMatchObject({ status: "rejected", rejectReason: OWNER_CHANGED_REASON });
    expect(h.writes.some((w) => w.op === "delete" && w.table === "service_connections")).toBe(true);
    const shareUpdate = h.writes.find((w) => w.op === "update" && w.table === "device_shares")?.arg;
    expect(shareUpdate).toMatchObject({ status: "ended" });
    expect(h.client.setAccess).toHaveBeenCalledWith({ mode: "member", rules: [] });
    // Both sides of the share and the post's author are told why
    expect(h.notifyUser).toHaveBeenCalledTimes(3);
  });

  it("changes nothing while owners match", async () => {
    h.client.listNodes.mockResolvedValueOnce([
      { id: "10", user: { id: ALICE } },
      { id: "20", user: { id: BOB } },
    ]);
    h.results.push([tenant], [], [share], [], [share], []);
    expect(await syncTenantAccess(T)).toBe(true);
    expect(h.writes.filter((w) => w.op !== "select")).toEqual([]);
    expect(h.client.setAccess).toHaveBeenCalledWith({
      mode: "member",
      rules: [{ src_owner: BOB, dst_node: 10, ports: [{ proto: "tcp", first: 22, last: 22 }] }],
    });
  });

  it("fails the push (the monitor retries) when devices cannot be listed", async () => {
    h.client.listNodes.mockRejectedValueOnce(new Error("down"));
    h.results.push([tenant]);
    expect(await syncTenantAccess(T)).toBe(false);
    expect(h.client.setAccess).not.toHaveBeenCalled();
  });
});
