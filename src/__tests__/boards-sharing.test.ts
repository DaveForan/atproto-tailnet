/**
 * Boards and sharing routes (ADR-0036): who may post, review, connect and
 * share, and what each action is allowed to open.
 * The DB is a chainable mock: each awaited query resolves to the next `results` entry.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { AddressInfo } from "node:net";

const { results, writes, chain, tableName, devices, syncTenantAccess } = vi.hoisted(() => {
  const results: unknown[] = [];
  const writes: Array<{ op: string; table?: string; method: string; arg: unknown }> = [];
  function tableName(t: unknown): string | undefined {
    if (!t || typeof t !== "object") return undefined;
    const sym = Object.getOwnPropertySymbols(t).find((s) => s.description === "drizzle:Name");
    return sym ? (t as Record<symbol, string>)[sym] : undefined;
  }
  function chain(op: string, table?: string): unknown {
    let tbl = table;
    if (op === "delete") writes.push({ op, table: tbl, method: "delete", arg: null });
    const proxy: unknown = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === "then") {
          const next = results.length ? results.shift() : [];
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(next).then(res, rej);
        }
        if (prop === "catch") return () => proxy;
        return (...args: unknown[]) => {
          if (prop === "from") tbl = tableName(args[0]);
          if (prop === "set" || prop === "values") writes.push({ op, table: tbl, method: String(prop), arg: args[0] });
          return proxy;
        };
      },
    });
    return proxy;
  }
  // Devices by owner, as the control plane reports them
  const devices: Record<string, Array<{ id: string; name: string; address: string; online: boolean; ownerId: string }>> = {};
  return { results, writes, chain, tableName, devices, syncTenantAccess: vi.fn(async () => true) };
});

vi.mock("../db/index.js", () => ({
  db: {
    select: () => chain("select"),
    insert: (t: unknown) => chain("insert", tableName(t)),
    update: (t: unknown) => chain("update", tableName(t)),
    delete: (t: unknown) => chain("delete", tableName(t)),
  },
  pool: {},
}));
vi.mock("../access/sync.js", () => ({ syncTenantAccess }));
vi.mock("../access/devices.js", () => ({
  listUserDevices: async (_t: unknown, userId: string) => devices[userId] ?? [],
  listTenantDevices: async () => Object.values(devices).flat(),
}));
vi.mock("../notifications/service.js", () => ({ notify: vi.fn(), notifyUser: vi.fn() }));
vi.mock("../orchestrator/control-client.js", () => ({ useCoordinator: true, getControlClient: vi.fn() }));

import express from "express";
import type { Request, Response, NextFunction } from "express";
import { boardsRouter } from "../routes/boards.js";
import { sharingRouter, portsWithin } from "../routes/sharing.js";

const T = "11111111-1111-4111-8111-111111111111";
const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const POST = "99999999-9999-4999-8999-999999999999";
const tenant = { id: T, slug: "t-x", lockdownMode: false, boardEnabled: true, lastActivityAt: new Date(), accessMode: "member", controllerBoardText: null, requireServiceApproval: true };
// Members hold create_posts unless a test says otherwise
const ctx = (opts: { originator?: boolean; perms?: string[]; lockdown?: boolean; board?: boolean; review?: boolean } = {}) => [
  {
    tenant: { ...tenant, lockdownMode: opts.lockdown ?? false, boardEnabled: opts.board ?? true, requireServiceApproval: opts.review ?? true },
    membership: { id: "m", isOriginator: opts.originator ?? false },
    role: { permissions: opts.perms ?? ["create_posts"] },
  },
];
const post = (over: Record<string, unknown> = {}) => ({
  id: POST, tenantId: T, authorId: ALICE, board: "public", status: "approved", title: "App", nodeId: "10", proto: "tcp", port: 3000, allowedRoleIds: [], ...over,
});

const app = express();
app.use(express.json());
app.use((req: Request, _res: Response, next: NextFunction) => {
  const user = String(req.headers["x-user"] ?? BOB);
  (req as unknown as { session: Record<string, unknown> }).session = { userId: user, did: "did:plc:x" };
  if (req.headers["x-agent"]) (req as unknown as { agentToken: unknown }).agentToken = { id: "a", tenantId: T, userId: user, permissions: [] };
  next();
});
app.use(boardsRouter);
app.use(sharingRouter);
const server = app.listen(0);
afterAll(() => server.close());

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tenants/${T}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

beforeEach(() => {
  results.length = 0;
  writes.length = 0;
  vi.clearAllMocks();
  for (const k of Object.keys(devices)) delete devices[k];
  devices[ALICE] = [{ id: "10", name: "alice-server", address: "100.64.0.10", online: true, ownerId: ALICE }];
  devices[BOB] = [{ id: "20", name: "bob-laptop", address: "100.64.0.20", online: true, ownerId: BOB }];
});

const insertOf = (table: string) => writes.find((w) => w.op === "insert" && w.table === table)?.arg as Record<string, unknown> | undefined;

describe("service posts", () => {
  const body = { board: "public", title: "App", nodeId: "20", port: 3000, proto: "tcp" };

  it("a member's public post waits for approval", async () => {
    results.push(ctx(), [], [post({ status: "pending" })]);
    const r = await call("POST", "/boards/posts", body);
    expect(r.status).toBe(201);
    expect(insertOf("service_posts")?.status).toBe("pending");
  });

  it("a member's public post needs no approval when the tailnet asks for none", async () => {
    results.push(ctx({ review: false }), [], [post()]);
    const r = await call("POST", "/boards/posts", body);
    expect(r.status).toBe(201);
    expect(insertOf("service_posts")).toMatchObject({ status: "approved", reviewedById: BOB });
  });

  it("the originator's own post needs no approval", async () => {
    results.push(ctx({ originator: true }), [], [post()]);
    await call("POST", "/boards/posts", body);
    expect(insertOf("service_posts")?.status).toBe("approved");
  });

  it("a private post needs a name and no approval", async () => {
    results.push(ctx());
    expect((await call("POST", "/boards/posts", { ...body, board: "private" })).status).toBe(400);
    results.push(ctx(), [], [], [post({ board: "private", name: "notes" })]); // name is not a tailnet address; no posts yet
    await call("POST", "/boards/posts", { ...body, board: "private", name: "notes" });
    expect(insertOf("service_posts")).toMatchObject({ status: "approved", name: "notes", board: "private" });
  });

  it("refuses a service name that is a live tailnet address", async () => {
    results.push(ctx(), [{ tenantId: "other" }]);
    const r = await call("POST", "/boards/posts", { ...body, board: "private", name: "harbor" });
    expect(r.status).toBe(409);
    expect(insertOf("service_posts")).toBeUndefined();
  });

  it("refuses a device that is not the author's", async () => {
    results.push(ctx());
    const r = await call("POST", "/boards/posts", { ...body, nodeId: "10" }); // alice's device, bob posting
    expect(r.status).toBe(400);
    expect(insertOf("service_posts")).toBeUndefined();
  });

  it.each([{ port: 0 }, { port: 70000 }, { nodeId: "abc" }, { title: "" }, { proto: "icmp" }])("refuses invalid input %j", async (bad) => {
    results.push(ctx());
    expect((await call("POST", "/boards/posts", { ...body, ...bad })).status).toBe(400);
  });

  it("is blocked by lockdown", async () => {
    results.push(ctx({ lockdown: true }));
    expect((await call("POST", "/boards/posts", body)).status).toBe(403);
  });

  it("a public post needs create_posts; a private post does not", async () => {
    results.push(ctx({ perms: [] }));
    const r = await call("POST", "/boards/posts", body);
    expect(r.status).toBe(403);
    expect(insertOf("service_posts")).toBeUndefined();
    results.push(ctx({ perms: [] }), [], [], [post({ board: "private", name: "notes" })]);
    expect((await call("POST", "/boards/posts", { ...body, board: "private", name: "notes" })).status).toBe(201);
    // An agent token without create_posts in its scope cannot post publicly either
    results.push(ctx());
    expect((await call("POST", "/boards/posts", body, { "x-agent": "1" })).status).toBe(403);
  });

  it("the public board must be enabled to post, change a public post or connect", async () => {
    results.push(ctx({ board: false, originator: true }));
    const created = await call("POST", "/boards/posts", body);
    expect(created.status).toBe(403);
    expect(created.json.code).toBe("board_disabled");
    expect(insertOf("service_posts")).toBeUndefined();

    results.push(ctx({ board: false }), [post({ authorId: BOB, nodeId: "20" })]);
    expect((await call("PATCH", `/boards/posts/${POST}`, { port: 4000 })).json.code).toBe("board_disabled");
    expect(writes.some((w) => w.op === "update" && w.table === "service_posts")).toBe(false);

    results.push(ctx({ board: false }), [post()]);
    expect((await call("PUT", `/boards/posts/${POST}/connections`, { nodeIds: ["20"] })).json.code).toBe("board_disabled");
    expect(insertOf("service_connections")).toBeUndefined();
    // Disconnecting still works, and private posts are not affected
    results.push(ctx({ board: false }), [post()]);
    expect((await call("PUT", `/boards/posts/${POST}/connections`, { nodeIds: [] })).status).toBe(200);
    results.push(ctx({ board: false }), [], [], [post({ board: "private", name: "notes" })]);
    expect((await call("POST", "/boards/posts", { ...body, board: "private", name: "notes" })).status).toBe(201);
  });

  it("changing the port of an approved post drops connections and needs a new approval", async () => {
    results.push(ctx(), [post({ authorId: BOB, nodeId: "20" })], undefined, [post({ authorId: BOB, status: "pending", port: 4000 })]);
    const r = await call("PATCH", `/boards/posts/${POST}`, { port: 4000 });
    expect(r.status).toBe(200);
    expect(writes.some((w) => w.op === "delete" && w.table === "service_connections")).toBe(true);
    const update = writes.find((w) => w.op === "update" && w.table === "service_posts")?.arg as Record<string, unknown>;
    expect(update).toMatchObject({ port: 4000, status: "pending" });
    expect(syncTenantAccess).toHaveBeenCalled();
  });

  it("a changed port needs no new approval when the tailnet asks for none", async () => {
    results.push(ctx({ review: false }), [post({ authorId: BOB, nodeId: "20" })], undefined, [post({ authorId: BOB, port: 4000 })]);
    expect((await call("PATCH", `/boards/posts/${POST}`, { port: 4000 })).status).toBe(200);
    const update = writes.find((w) => w.op === "update" && w.table === "service_posts")?.arg as Record<string, unknown>;
    expect(update.status).toBeUndefined();
  });

  it("renaming an approved public post sends it back for approval; connections stay", async () => {
    // post, then the name check (not a tailnet address), then the update
    results.push(ctx(), [post({ authorId: BOB, nodeId: "20", name: "app" })], [], [post({ authorId: BOB, status: "pending", name: "other" })]);
    const r = await call("PATCH", `/boards/posts/${POST}`, { name: "other" });
    expect(r.status).toBe(200);
    const update = writes.find((w) => w.op === "update" && w.table === "service_posts")?.arg as Record<string, unknown>;
    expect(update).toMatchObject({ name: "other", status: "pending", reviewedById: null });
    expect(writes.some((w) => w.op === "delete" && w.table === "service_connections")).toBe(false);
    expect(syncTenantAccess).toHaveBeenCalledWith(T);
  });

  it("renaming a private post needs no approval", async () => {
    results.push(ctx(), [post({ authorId: BOB, nodeId: "20", board: "private", name: "notes" })], [], [post({ board: "private" })]);
    await call("PATCH", `/boards/posts/${POST}`, { name: "notes2" });
    const update = writes.find((w) => w.op === "update" && w.table === "service_posts")?.arg as Record<string, unknown>;
    expect(update.status).toBeUndefined();
  });

  it("only the author can change a post", async () => {
    results.push(ctx(), [post()]); // alice's post, bob calling
    expect((await call("PATCH", `/boards/posts/${POST}`, { title: "x" })).status).toBe(404);
  });
});

describe("review", () => {
  it("needs approve_services", async () => {
    results.push(ctx());
    expect((await call("POST", `/boards/posts/${POST}/approve`)).status).toBe(403);
  });

  it("approving is blocked by lockdown; withdrawing is not", async () => {
    results.push(ctx({ perms: ["approve_services"], lockdown: true }), [post({ status: "pending" })]);
    expect((await call("POST", `/boards/posts/${POST}/approve`)).status).toBe(403);
    expect(writes.some((w) => w.op === "update" && w.table === "service_posts")).toBe(false);
    results.push(ctx({ perms: ["approve_services"], lockdown: true }), [post()], undefined, [post({ status: "rejected" })]);
    expect((await call("POST", `/boards/posts/${POST}/reject`, { reason: "no" })).status).toBe(200);
  });

  it("an operator approves a pending post", async () => {
    results.push(ctx({ perms: ["approve_services"] }), [post({ status: "pending" })], [post()]);
    expect((await call("POST", `/boards/posts/${POST}/approve`)).status).toBe(200);
  });

  it("withdrawing approval disconnects everyone at once", async () => {
    results.push(ctx({ perms: ["approve_services"] }), [post()], undefined, [post({ status: "rejected" })]);
    expect((await call("POST", `/boards/posts/${POST}/reject`, { reason: "no" })).status).toBe(200);
    expect(writes.some((w) => w.op === "delete" && w.table === "service_connections")).toBe(true);
    expect(syncTenantAccess).toHaveBeenCalled();
  });

  it("operators cannot remove a private post", async () => {
    results.push(ctx({ perms: ["manage_board"] }), [post({ board: "private" })]);
    expect((await call("DELETE", `/boards/posts/${POST}`)).status).toBe(404);
  });

  it("an operator with manage_board removes a public post", async () => {
    results.push(ctx({ perms: ["manage_board"] }), [post()]);
    expect((await call("DELETE", `/boards/posts/${POST}`)).status).toBe(200);
    expect(syncTenantAccess).toHaveBeenCalled();
  });
});

describe("the open policy is each member's own choice", () => {
  it("a member puts their own devices under it, and only their own membership changes", async () => {
    results.push(ctx());
    const r = await call("PUT", "/access-mode/mine", { open: true });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ open: true, applied: true });
    expect(writes.filter((w) => w.op === "update")).toEqual([{ op: "update", table: "memberships", method: "set", arg: { openAccess: true } }]);
    expect(syncTenantAccess).toHaveBeenCalledWith(T);
  });

  it("an agent token cannot open a member's devices", async () => {
    results.push(ctx());
    expect((await call("PUT", "/access-mode/mine", { open: true }, { "x-agent": "1" })).status).toBe(403);
    expect(writes.some((w) => w.table === "memberships")).toBe(false);
  });

  it("lockdown blocks joining, never leaving", async () => {
    results.push(ctx({ lockdown: true }));
    expect((await call("PUT", "/access-mode/mine", { open: true })).status).toBe(403);
    results.push(ctx({ lockdown: true }));
    expect((await call("PUT", "/access-mode/mine", { open: false })).status).toBe(200);
  });

  it("changing the tailnet's mode writes no membership: it opens nobody's devices", async () => {
    results.push(ctx({ perms: ["manage_acl"] }));
    expect((await call("PUT", "/access-mode", { mode: "open" })).status).toBe(200);
    expect(writes.some((w) => w.table === "memberships")).toBe(false);
  });
});

describe("Connect", () => {
  it("connects only the caller's own devices to an approved post", async () => {
    results.push(ctx(), [post()]);
    const r = await call("PUT", `/boards/posts/${POST}/connections`, { nodeIds: ["20"] });
    expect(r.status).toBe(200);
    expect(insertOf("service_connections")).toEqual([{ postId: POST, userId: BOB, nodeId: "20" }]);
    expect(syncTenantAccess).toHaveBeenCalledWith(T);
  });

  it("a post for some roles is closed to members of other roles, and gives the answer of an unknown post", async () => {
    const ROLE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const withRole = (roleId: string | null, originator = false) => {
      const c = ctx({ originator });
      (c[0].membership as Record<string, unknown>).roleId = roleId;
      return c;
    };
    results.push(withRole("dddddddd-dddd-4ddd-8ddd-dddddddddddd"), [post({ allowedRoleIds: [ROLE] })]);
    const refused = await call("PUT", `/boards/posts/${POST}/connections`, { nodeIds: ["20"] });
    expect(refused.status).toBe(404);
    expect(insertOf("service_connections")).toBeUndefined();

    results.push(withRole(ROLE), [post({ allowedRoleIds: [ROLE] })]);
    expect((await call("PUT", `/boards/posts/${POST}/connections`, { nodeIds: ["20"] })).status).toBe(200);
    results.push(withRole(null, true), [post({ allowedRoleIds: [ROLE] })]);
    expect((await call("PUT", `/boards/posts/${POST}/connections`, { nodeIds: ["20"] })).status).toBe(200);

    // Disconnecting stays possible after the role was lost
    results.push(withRole(null), [post({ allowedRoleIds: [ROLE] })]);
    expect((await call("PUT", `/boards/posts/${POST}/connections`, { nodeIds: [] })).status).toBe(200);
  });

  it("refuses someone else's device", async () => {
    results.push(ctx(), [post()]);
    const r = await call("PUT", `/boards/posts/${POST}/connections`, { nodeIds: ["10"] });
    expect(r.status).toBe(400);
    expect(insertOf("service_connections")).toBeUndefined();
  });

  it.each(["pending", "rejected"])("a %s post cannot be connected to", async (status) => {
    results.push(ctx(), [post({ status })]);
    expect((await call("PUT", `/boards/posts/${POST}/connections`, { nodeIds: ["20"] })).status).toBe(404);
  });

  it("a private post cannot be connected to", async () => {
    results.push(ctx(), [post({ board: "private" })]);
    expect((await call("PUT", `/boards/posts/${POST}/connections`, { nodeIds: ["20"] })).status).toBe(404);
  });

  it("disconnecting works during lockdown; connecting does not", async () => {
    results.push(ctx({ lockdown: true }), [post()]);
    expect((await call("PUT", `/boards/posts/${POST}/connections`, { nodeIds: [] })).status).toBe(200);
    results.push(ctx({ lockdown: true }), [post()]);
    expect((await call("PUT", `/boards/posts/${POST}/connections`, { nodeIds: ["20"] })).status).toBe(403);
  });
});

describe("controller board", () => {
  it("only the originator edits it, never an agent token", async () => {
    results.push(ctx({ perms: ["manage_board", "manage_settings"] }));
    expect((await call("PUT", "/controller-board", { text: "hi" })).status).toBe(403);
    results.push(ctx({ originator: true }));
    expect((await call("PUT", "/controller-board", { text: "hi" }, { "x-agent": "1" })).status).toBe(403);
  });

  it("refuses text that fails the lint", async () => {
    results.push(ctx({ originator: true }));
    const r = await call("PUT", "/controller-board", { text: "see [x](http://insecure.example)" });
    expect(r.status).toBe(400);
    expect(writes.some((w) => w.table === "tenants")).toBe(false);
  });

  it("saves clean text", async () => {
    results.push(ctx({ originator: true }));
    expect((await call("PUT", "/controller-board", { text: "# Welcome\n\nAsk to join." })).status).toBe(200);
  });
});

describe("access mode", () => {
  it("needs manage_acl", async () => {
    results.push(ctx());
    expect((await call("PUT", "/access-mode", { mode: "member" })).status).toBe(403);
    results.push(ctx({ perms: ["manage_acl"] }));
    expect((await call("PUT", "/access-mode", { mode: "member" })).status).toBe(200);
    expect(syncTenantAccess).toHaveBeenCalledWith(T);
  });
});

describe("friends and shares", () => {
  const share = (over: Record<string, unknown> = {}) => ({
    id: "s1", tenantId: T, ownerId: ALICE, guestId: BOB, ownerNodeId: "10", status: "requested",
    ports: [{ proto: "tcp", first: 22, last: 22 }, { proto: "tcp", first: 443, last: 443 }], guestNodeIds: [], expiresAt: null, ...over,
  });
  const shareBody = { kind: "request", friendId: ALICE, ownerNodeId: "10", ports: [{ proto: "tcp", first: 22, last: 22 }] };

  it("agent tokens cannot manage friends or shares", async () => {
    results.push(ctx());
    expect((await call("POST", "/shares", shareBody, { "x-agent": "1" })).status).toBe(403);
  });

  it("a share needs a friendship first", async () => {
    results.push(ctx(), []); // no friendship row
    const r = await call("POST", "/shares", shareBody);
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("not_friends");
    expect(insertOf("device_shares")).toBeUndefined();
  });

  it("a request names the friend's device and opens nothing yet", async () => {
    results.push(ctx(), [{ status: "accepted" }], [], [share()]);
    const r = await call("POST", "/shares", shareBody);
    expect(r.status).toBe(201);
    expect(insertOf("device_shares")).toMatchObject({ ownerId: ALICE, guestId: BOB, status: "requested" });
    expect(syncTenantAccess).not.toHaveBeenCalled();
  });

  it("an offer must be for the caller's own device", async () => {
    results.push(ctx(), [{ status: "accepted" }]);
    const r = await call("POST", "/shares", { ...shareBody, kind: "offer", ownerNodeId: "10" }); // bob offering alice's device
    expect(r.status).toBe(400);
  });

  it("the guest cannot accept their own request", async () => {
    results.push(ctx(), [share()]); // bob (guest) tries to accept a request he made
    expect((await call("POST", "/shares/s1/accept")).status).toBe(404);
  });

  it("the owner accepts a request: the share becomes active and rules are pushed", async () => {
    results.push(ctx(), [share()], [{ status: "accepted" }], [{ id: "s1" }]);
    const r = await call("POST", "/shares/s1/accept", {}, { "x-user": ALICE });
    expect(r.json.status).toBe("active");
    expect(syncTenantAccess).toHaveBeenCalledWith(T);
  });

  it("an owner who narrows the ports sends it back to the guest; nothing opens", async () => {
    results.push(ctx(), [share()], [{ status: "accepted" }], [{ id: "s1" }]);
    const r = await call("POST", "/shares/s1/accept", { ports: [{ proto: "tcp", first: 22, last: 22 }] }, { "x-user": ALICE });
    expect(r.json.status).toBe("offered");
    expect(syncTenantAccess).not.toHaveBeenCalled();
  });

  it("an owner cannot add ports while accepting", async () => {
    results.push(ctx(), [share()], [{ status: "accepted" }]);
    const r = await call("POST", "/shares/s1/accept", { ports: [{ proto: "tcp", first: 1, last: 65535 }] }, { "x-user": ALICE });
    expect(r.status).toBe(400);
  });

  it("accepting only moves the share from the state that was answered", async () => {
    results.push(ctx(), [share()], [{ status: "accepted" }], []); // ended meanwhile: the conditional update matches nothing
    const r = await call("POST", "/shares/s1/accept", {}, { "x-user": ALICE });
    expect(r.status).toBe(409);
    expect(syncTenantAccess).not.toHaveBeenCalled();
    const update = writes.find((w) => w.op === "update" && w.table === "device_shares")?.arg as Record<string, unknown>;
    expect(update).toMatchObject({ status: "active" });
  });

  it("a guest accepting an offer with chosen devices sets them in the same update", async () => {
    results.push(ctx(), [share({ status: "offered" })], [{ status: "accepted" }], [{ id: "s1" }]);
    const r = await call("POST", "/shares/s1/accept", { guestNodeIds: ["20"] });
    expect(r.json.status).toBe("active");
    const updates = writes.filter((w) => w.op === "update" && w.table === "device_shares");
    expect(updates).toHaveLength(1);
    expect(updates[0].arg).toMatchObject({ status: "active", guestNodeIds: ["20"] });
  });

  it("accepting a share is blocked by lockdown", async () => {
    results.push(ctx({ lockdown: true }));
    expect((await call("POST", "/shares/s1/accept", {}, { "x-user": ALICE })).status).toBe(403);
  });

  it("accepting a friend request is blocked by lockdown", async () => {
    results.push(ctx({ lockdown: true }));
    expect((await call("POST", "/friends/f1/accept")).status).toBe(403);
    expect(writes.some((w) => w.op === "update" && w.table === "friendships")).toBe(false);
  });

  it("a friend request withdrawn meanwhile is not revived", async () => {
    results.push(ctx(), [{ id: "f1", tenantId: T, requesterId: ALICE, addresseeId: BOB, status: "pending" }], []);
    expect((await call("POST", "/friends/f1/accept")).status).toBe(404);
    results.push(ctx(), [{ id: "f1", tenantId: T, requesterId: ALICE, addresseeId: BOB, status: "pending" }], [{ id: "f1" }]);
    expect((await call("POST", "/friends/f1/accept")).json.status).toBe("accepted");
  });

  it("accepting fails if the two are no longer friends", async () => {
    results.push(ctx(), [share()], []);
    expect((await call("POST", "/shares/s1/accept", {}, { "x-user": ALICE })).status).toBe(409);
    expect(syncTenantAccess).not.toHaveBeenCalled();
  });

  it("either side ends an active share and access closes", async () => {
    results.push(ctx(), [share({ status: "active" })]);
    expect((await call("DELETE", "/shares/s1")).status).toBe(200);
    expect(syncTenantAccess).toHaveBeenCalledWith(T);
  });

  it("a third member cannot see or end a share", async () => {
    results.push(ctx(), [share({ status: "active" })]);
    expect((await call("DELETE", "/shares/s1", undefined, { "x-user": "cccccccc-cccc-4ccc-8ccc-cccccccccccc" })).status).toBe(404);
  });

  it("a blocked member gets the same answer as for a non-member", async () => {
    results.push(ctx(), [{ id: "m" }], [{ id: "block" }]);
    expect((await call("POST", "/friends", { userId: ALICE })).status).toBe(404);
  });

  it("unfriending ends the shares between the two", async () => {
    results.push(ctx(), [{ id: "f1", tenantId: T, requesterId: ALICE, addresseeId: BOB, status: "accepted" }], undefined, [{ id: "s1" }]);
    const r = await call("DELETE", "/friends/f1");
    expect(r.json.sharesEnded).toBe(1);
    expect(syncTenantAccess).toHaveBeenCalledWith(T);
  });

  it("a friend's device list shows names only", async () => {
    results.push(ctx(), [{ status: "accepted" }]);
    const r = await call("GET", `/friends/${ALICE}/devices`);
    expect(r.json.devices).toEqual([{ id: "10", name: "alice-server" }]);
  });
});

describe("portsWithin", () => {
  const tcp = (first: number, last = first) => ({ proto: "tcp" as const, first, last });
  it("accepts a subset and refuses a superset", () => {
    expect(portsWithin([tcp(22)], [tcp(22), tcp(443)])).toBe(true);
    expect(portsWithin([tcp(8001, 8002)], [tcp(8000, 8010)])).toBe(true);
    expect(portsWithin([tcp(21, 22)], [tcp(22)])).toBe(false);
    expect(portsWithin([{ proto: "udp", first: 22, last: 22 }], [tcp(22)])).toBe(false);
    expect(portsWithin([tcp(22)], [{ proto: "any", first: 1, last: 65535 }])).toBe(true);
  });
});
