/** Access rule compilation (ADR-0036): posts, connections and shares → coordinator rules. */
import { describe, it, expect } from "vitest";
import {
  connectionsAllowedByRole,
  roleAllows,
  compileAccess,
  compileDns,
  findStaleAccess,
  MAX_RULE_SOURCES,
  type CompileInput,
  type DnsInput,
} from "../access/compiler.js";
import { deviceReach } from "../access/reach.js";

const NOW = new Date("2026-11-20T12:00:00Z");
const base = (over: Partial<CompileInput> = {}): CompileInput => ({
  mode: "member",
  posts: [],
  connections: [],
  shares: [],
  now: NOW,
  ...over,
});
const post = (over: Partial<CompileInput["posts"][number]> = {}) => ({
  id: "p1",
  board: "public",
  status: "approved",
  nodeId: "10",
  proto: "tcp" as const,
  port: 3000,
  ...over,
});
const share = (over: Partial<CompileInput["shares"][number]> = {}) => ({
  status: "active",
  guestId: "u-bob",
  ownerNodeId: "10",
  guestNodeIds: [] as string[],
  ports: [{ proto: "tcp" as const, first: 22, last: 22 }],
  expiresAt: null,
  ...over,
});

describe("compileAccess", () => {
  it("open mode sends no rules", () => {
    expect(compileAccess(base({ mode: "open", posts: [post()], connections: [{ postId: "p1", nodeId: "20" }] }))).toEqual({
      mode: "open",
      rules: [],
    });
  });

  it("an approved public post opens its one port to connected devices only", () => {
    const out = compileAccess(
      base({ posts: [post()], connections: [{ postId: "p1", nodeId: "21" }, { postId: "p1", nodeId: "20" }, { postId: "p1", nodeId: "20" }] }),
    );
    expect(out.rules).toEqual([
      { src_nodes: [20, 21], dst_node: 10, ports: [{ proto: "tcp", first: 3000, last: 3000 }] },
    ]);
  });

  it("a post with no connections opens nothing", () => {
    expect(compileAccess(base({ posts: [post()] })).rules).toEqual([]);
  });

  it.each(["pending", "rejected", "removed"])("a %s post opens nothing, even with connections", (status) => {
    const out = compileAccess(base({ posts: [post({ status })], connections: [{ postId: "p1", nodeId: "20" }] }));
    expect(out.rules).toEqual([]);
  });

  it("private-board posts add no rules", () => {
    const out = compileAccess(base({ posts: [post({ board: "private" })], connections: [{ postId: "p1", nodeId: "20" }] }));
    expect(out.rules).toEqual([]);
  });

  it("an active share opens the owner's ports to all of the guest's devices", () => {
    expect(compileAccess(base({ shares: [share()] })).rules).toEqual([
      { src_owner: "u-bob", dst_node: 10, ports: [{ proto: "tcp", first: 22, last: 22 }] },
    ]);
  });

  it("a share limited to chosen devices names only those", () => {
    expect(compileAccess(base({ shares: [share({ guestNodeIds: ["31", "30"] })] })).rules).toEqual([
      { src_nodes: [30, 31], dst_node: 10, ports: [{ proto: "tcp", first: 22, last: 22 }] },
    ]);
  });

  it("a share whose chosen devices are all invalid never widens to every device", () => {
    expect(compileAccess(base({ shares: [share({ guestNodeIds: ["gone", "-1"] })] })).rules).toEqual([]);
  });

  it.each(["requested", "offered", "ended"])("a %s share opens nothing", (status) => {
    expect(compileAccess(base({ shares: [share({ status })] })).rules).toEqual([]);
  });

  it("an expired share opens nothing; an unexpired one does", () => {
    expect(compileAccess(base({ shares: [share({ expiresAt: new Date(NOW.getTime() - 1) })] })).rules).toEqual([]);
    expect(compileAccess(base({ shares: [share({ expiresAt: new Date(NOW.getTime() + 60_000) })] })).rules).toHaveLength(1);
  });

  it("drops rules whose device id is not a control-plane id", () => {
    const out = compileAccess(
      base({
        posts: [post({ nodeId: "not-a-node" })],
        connections: [{ postId: "p1", nodeId: "20" }],
        shares: [share({ ownerNodeId: "0" })],
      }),
    );
    expect(out.rules).toEqual([]);
  });

  it("splits very large source lists across rules", () => {
    const connections = Array.from({ length: MAX_RULE_SOURCES + 5 }, (_, i) => ({ postId: "p1", nodeId: String(100 + i) }));
    const out = compileAccess(base({ posts: [post()], connections }));
    expect(out.rules.map((r) => r.src_nodes!.length)).toEqual([MAX_RULE_SOURCES, 5]);
  });

  it("a device never needs a rule to reach itself", () => {
    const out = compileAccess(base({ posts: [post()], connections: [{ postId: "p1", nodeId: "10" }] }));
    expect(out.rules).toEqual([]);
  });
});

describe("compileDns", () => {
  const input = (over: Partial<DnsInput> = {}): DnsInput => ({
    baseDomain: "ts.example.com",
    tailnetLabel: "harbor",
    upstream: [],
    posts: [],
    connections: [],
    ...over,
  });
  const named = (over: Record<string, unknown> = {}) => ({
    id: "p1", board: "private", status: "approved", name: "notes", nodeId: "10", authorId: "u-alice", ...over,
  });

  it("carries the base domain, tailnet label and upstream resolvers", () => {
    expect(compileDns(input({ upstream: ["1.1.1.1"] }))).toEqual({
      base_domain: "ts.example.com", tailnet_label: "harbor", upstream: ["1.1.1.1"], records: [],
    });
  });

  it("a private service resolves only on its author's devices", () => {
    expect(compileDns(input({ posts: [named()] })).records).toEqual([{ name: "notes", node: 10, owner: "u-alice" }]);
  });

  it("an approved public service also resolves on connected devices", () => {
    const out = compileDns(
      input({ posts: [named({ board: "public" })], connections: [{ postId: "p1", nodeId: "21" }, { postId: "p1", nodeId: "20" }] }),
    );
    expect(out.records).toEqual([{ name: "notes", node: 10, owner: "u-alice", nodes: [20, 21] }]);
  });

  it("a web service carries its port, so the gateway serves the name over HTTPS", () => {
    const web = { web: true, proto: "tcp", port: 3000 };
    expect(compileDns(input({ posts: [named(web)] })).records).toEqual([{ name: "notes", node: 10, owner: "u-alice", port: 3000 }]);
    const shared = compileDns(input({ posts: [named({ ...web, board: "public" })], connections: [{ postId: "p1", nodeId: "20" }] }));
    expect(shared.records).toEqual([{ name: "notes", node: 10, owner: "u-alice", nodes: [20], port: 3000 }]);
  });

  it("only a TCP post that asked for it is a web service", () => {
    const record = (post: Record<string, unknown>) => compileDns(input({ posts: [named(post)] })).records[0];
    expect(record({ web: false, proto: "tcp", port: 3000 })).not.toHaveProperty("port");
    expect(record({ web: true, proto: "udp", port: 3000 })).not.toHaveProperty("port");
    expect(record({ proto: "tcp", port: 3000 })).not.toHaveProperty("port");
  });

  it.each([
    ["a pending public service", named({ board: "public", status: "pending" })],
    ["a rejected public service", named({ board: "public", status: "rejected" })],
    ["a removed private service", named({ status: "removed" })],
    ["a withdrawn private service", named({ status: "rejected" })],
    ["a service without a name", named({ name: null })],
    ["a name equal to the tailnet label", named({ name: "harbor" })],
    ["a device that is not a control-plane id", named({ nodeId: "x" })],
  ])("%s gets no record", (_label, post) => {
    expect(compileDns(input({ posts: [post as DnsInput["posts"][number]] })).records).toEqual([]);
  });
});

describe("device changed owner", () => {
  // Node 10 was alice's; it registered again under carol and kept its id
  const nodeOwners = new Map([
    ["10", "u-carol"],
    ["20", "u-bob"],
    ["21", "u-carol"],
  ]);
  const ownedPost = post({ authorId: "u-alice" });
  const ownedShare = share({ id: "s1", ownerId: "u-alice" });

  it("a post on the moved device opens nothing", () => {
    const out = compileAccess(base({ nodeOwners, posts: [ownedPost], connections: [{ postId: "p1", nodeId: "20", userId: "u-bob" }] }));
    expect(out.rules).toEqual([]);
  });

  it("a share of the moved device opens nothing", () => {
    expect(compileAccess(base({ nodeOwners, shares: [ownedShare] })).rules).toEqual([]);
  });

  it("a connection or guest device that moved is dropped; the rest stays", () => {
    const owners = new Map([["10", "u-alice"], ["20", "u-bob"], ["21", "u-carol"]]);
    const out = compileAccess(
      base({
        nodeOwners: owners,
        posts: [ownedPost],
        connections: [
          { postId: "p1", nodeId: "20", userId: "u-bob" },
          { postId: "p1", nodeId: "21", userId: "u-bob" },
        ],
        shares: [share({ id: "s1", ownerId: "u-alice", guestId: "u-bob", guestNodeIds: ["20", "21"] })],
      }),
    );
    expect(out.rules).toEqual([
      { src_nodes: [20], dst_node: 10, ports: [{ proto: "tcp", first: 3000, last: 3000 }] },
      { src_nodes: [20], dst_node: 10, ports: [{ proto: "tcp", first: 22, last: 22 }] },
    ]);
  });

  it("a device the control plane does not list is not judged", () => {
    expect(compileAccess(base({ nodeOwners: new Map(), shares: [ownedShare] })).rules).toHaveLength(1);
  });

  it("findStaleAccess names what must be closed", () => {
    const stale = findStaleAccess({
      nodeOwners,
      posts: [ownedPost, post({ id: "p2", nodeId: "20", authorId: "u-bob" }), post({ id: "p3", status: "removed", authorId: "u-alice" })],
      connections: [
        { postId: "p2", nodeId: "21", userId: "u-alice" },
        { postId: "p2", nodeId: "20", userId: "u-bob" },
      ],
      shares: [
        ownedShare,
        share({ id: "s2", status: "ended", ownerId: "u-alice" }),
        share({ id: "s3", ownerNodeId: "20", ownerId: "u-bob", guestId: "u-alice", guestNodeIds: ["21"] }),
        share({ id: "s4", ownerNodeId: "20", ownerId: "u-bob", guestId: "u-carol", guestNodeIds: ["21", "10", "99"] }),
      ],
    });
    expect(stale).toEqual({
      postIds: ["p1"],
      connections: [{ postId: "p2", nodeId: "21" }],
      // s3: its only chosen guest device moved, so it ends rather than widening
      shareIds: ["s1", "s3"],
      guestNodes: [],
    });
    const partial = findStaleAccess({
      nodeOwners,
      posts: [],
      connections: [],
      shares: [share({ id: "s5", ownerNodeId: "20", ownerId: "u-bob", guestId: "u-alice", guestNodeIds: ["21", "30"] })],
    });
    expect(partial.guestNodes).toEqual([{ shareId: "s5", keep: ["30"] }]);
  });

  it("names on the moved device are not published", () => {
    const dns = compileDns({
      baseDomain: "ts.example.com",
      tailnetLabel: "harbor",
      upstream: [],
      nodeOwners,
      posts: [{ id: "p1", board: "private", status: "approved", name: "notes", nodeId: "10", authorId: "u-alice" }],
      connections: [],
    });
    expect(dns.records).toEqual([]);
  });
});

describe("expiry", () => {
  it("a share is closed by the first compile at or after its expiry", () => {
    const expiresAt = new Date(NOW.getTime() + 1000);
    const s = share({ expiresAt });
    expect(compileAccess(base({ shares: [s], now: new Date(NOW.getTime() + 999) })).rules).toHaveLength(1);
    expect(compileAccess(base({ shares: [s], now: expiresAt })).rules).toEqual([]);
  });
});

describe("deviceReach", () => {
  const owners = new Map([
    ["10", "u-alice"],
    ["11", "u-alice"],
    ["20", "u-bob"],
    ["21", "u-bob"],
    ["30", "u-carol"],
    ["31", "u-dan"],
  ]);
  const input = base({
    nodeOwners: owners,
    posts: [
      post({ id: "p1", authorId: "u-alice" }),
      post({ id: "p2", authorId: "u-alice", status: "pending", port: 4000 }),
      post({ id: "p3", authorId: "u-alice", board: "private", port: 5000 }),
      post({ id: "p4", authorId: "u-alice", nodeId: "11", proto: "udp", port: 53 }),
    ],
    connections: [
      { postId: "p1", nodeId: "20", userId: "u-bob" },
      { postId: "p1", nodeId: "21", userId: "u-bob" },
      { postId: "p1", nodeId: "30", userId: "u-carol" },
      // Dan's device 31 was connected by Carol: the device changed owner, so it opens nothing
      { postId: "p1", nodeId: "31", userId: "u-carol" },
      { postId: "p2", nodeId: "20", userId: "u-bob" },
      { postId: "p4", nodeId: "30", userId: "u-carol" },
    ],
    shares: [
      share({ id: "s1", ownerId: "u-alice" }),
      share({ id: "s2", ownerId: "u-alice", guestId: "u-carol", guestNodeIds: ["30", "31"], ports: [{ proto: "udp", first: 5000, last: 5010 }] }),
      share({ id: "s3", ownerId: "u-alice", guestId: "u-dan", status: "requested" }),
      share({ id: "s4", ownerId: "u-alice", guestId: "u-dan", expiresAt: new Date(NOW.getTime() - 1000) }),
      share({ id: "s5", ownerId: "u-alice", guestId: "u-dan", ownerNodeId: "11", guestNodeIds: ["31"] }),
    ],
  });

  it("lists who reaches a device, and why", () => {
    const entries = deviceReach(input, "10");
    expect(entries.map((e) => [e.kind, e.id, e.userId, e.devices])).toEqual([
      ["service", "p1", "u-bob", ["20", "21"]],
      ["service", "p1", "u-carol", ["30"]],
      ["share", "s1", "u-bob", "all"],
      ["share", "s2", "u-carol", ["30"]],
    ]);
    expect(deviceReach(input, "99")).toEqual([]);
  });

  it("reach agrees with the compiled rules", () => {
    const rules = compileAccess(input).rules;
    for (const node of ["10", "11"]) {
      const fromRules = new Set<string>();
      for (const r of rules.filter((r) => String(r.dst_node) === node)) {
        const ports = JSON.stringify(r.ports);
        if (r.src_owner) fromRules.add(`owner:${r.src_owner}|${ports}`);
        for (const n of r.src_nodes ?? []) fromRules.add(`node:${n}|${ports}`);
      }
      const fromReach = new Set<string>();
      for (const e of deviceReach(input, node)) {
        const ports = JSON.stringify(e.ports.map((p) => ({ proto: p.proto, first: p.first, last: p.last })));
        if (e.devices === "all") fromReach.add(`owner:${e.userId}|${ports}`);
        else for (const n of e.devices) fromReach.add(`node:${n}|${ports}`);
      }
      expect([...fromReach].sort()).toEqual([...fromRules].sort());
      expect(fromRules.size).toBeGreaterThan(0);
    }
  });
});

describe("posts for some roles", () => {
  const members = new Map([
    ["u-alice", { roleId: "r-admin", isOriginator: false }],
    ["u-bob", { roleId: "r-kitchen", isOriginator: false }],
    ["u-carol", { roleId: "r-guest", isOriginator: false }],
    ["u-owner", { roleId: null, isOriginator: true }],
  ]);
  const restricted = { id: "p1", authorId: "u-alice", allowedRoleIds: ["r-kitchen"] };

  it("allows the role, the author and the originator; nobody else", () => {
    expect(roleAllows(restricted, "u-bob", members)).toBe(true);
    expect(roleAllows(restricted, "u-alice", members)).toBe(true);
    expect(roleAllows(restricted, "u-owner", members)).toBe(true);
    expect(roleAllows(restricted, "u-carol", members)).toBe(false);
    expect(roleAllows(restricted, "u-gone", members)).toBe(false);
    expect(roleAllows(restricted, undefined, members)).toBe(false);
    expect(roleAllows({ allowedRoleIds: [] }, "u-carol", members)).toBe(true);
    expect(roleAllows({}, "u-gone", members)).toBe(true);
  });

  it("a connection of a member who lost the role opens nothing", () => {
    const posts = [post({ id: "p1", authorId: "u-alice" }), post({ id: "p2", authorId: "u-alice", port: 4000 })];
    const connections = [
      { postId: "p1", nodeId: "20", userId: "u-bob" },
      { postId: "p1", nodeId: "30", userId: "u-carol" },
      { postId: "p2", nodeId: "30", userId: "u-carol" },
      { postId: "gone", nodeId: "30", userId: "u-carol" },
    ];
    const kept = connectionsAllowedByRole([{ ...posts[0], allowedRoleIds: ["r-kitchen"] }, posts[1]], connections, members);
    expect(kept.map((c) => `${c.postId}:${c.nodeId}`)).toEqual(["p1:20", "p2:30"]);
    const rules = compileAccess(base({ posts, connections: kept })).rules;
    expect(rules).toEqual([
      { src_nodes: [20], dst_node: 10, ports: [{ proto: "tcp", first: 3000, last: 3000 }] },
      { src_nodes: [30], dst_node: 10, ports: [{ proto: "tcp", first: 4000, last: 4000 }] },
    ]);
  });
});
