/** Access rule compilation (ADR-0036): posts, connections and shares → coordinator rules. */
import { describe, it, expect } from "vitest";
import { compileAccess, MAX_RULE_SOURCES, type CompileInput } from "../access/compiler.js";

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
