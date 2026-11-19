import { describe, it, expect, vi, beforeEach } from "vitest";

let outstanding: Array<Record<string, unknown>> = [];
const updates: unknown[] = [];
vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn(() => ({ from: () => ({ where: async () => outstanding }) })),
    update: vi.fn(() => ({
      set: (v: unknown) => ({
        where: async () => {
          updates.push(v);
        },
      }),
    })),
  },
}));

import { revokeMemberAccess, filterVisibleKeys, type AuthKeyView } from "../routes/access.js";
import { CoordinatorApiClient } from "../orchestrator/coordinator-api.js";
import { HeadscaleApiClient } from "../orchestrator/headscale-api.js";

const key = (id: string, owner: string | null): AuthKeyView => ({
  id,
  prefix: "abc",
  owner: owner ? { userId: owner, handle: `${owner}.bsky.social` } : null,
  reusable: false,
  ephemeral: false,
  used: false,
  expiresAt: null,
  createdAt: null,
  revoked: false,
});

describe("filterVisibleKeys", () => {
  const keys = [key("1", "alice"), key("2", "bob"), key("cp:9", null)];

  it("managers see every key", () => {
    expect(filterVisibleKeys(keys, { userId: "alice", canManage: true })).toHaveLength(3);
  });

  it("members see only their own keys (not unowned control-plane keys)", () => {
    expect(filterVisibleKeys(keys, { userId: "alice", canManage: false }).map((k) => k.id)).toEqual(["1"]);
    expect(filterVisibleKeys(keys, { userId: "carol", canManage: false })).toEqual([]);
  });
});

describe("revokeMemberAccess (kick cascade)", () => {
  beforeEach(() => {
    outstanding = [];
    updates.length = 0;
  });

  it("coordinator mode: revokes keys and deletes nodes by owner", async () => {
    const client = new CoordinatorApiClient("http://coord", "coord-tenant", "k");
    const revoke = vi.spyOn(client, "revokePreAuthKeysByOwner").mockResolvedValue(2);
    const del = vi.spyOn(client, "deleteNodesByOwner").mockResolvedValue(3);
    outstanding = [{ id: "k1", controlKeyId: "u1" }];

    const r = await revokeMemberAccess({ tenantId: "t1", client, userId: "user-1", hsUsername: "bob" });

    expect(revoke).toHaveBeenCalledWith("user-1");
    expect(del).toHaveBeenCalledWith("user-1");
    // keys are revoked before devices are removed
    expect(revoke.mock.invocationCallOrder[0]).toBeLessThan(del.mock.invocationCallOrder[0]);
    expect(r).toEqual({ devicesDeleted: 3, keysRevoked: 2, errors: [] });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toHaveProperty("revokedAt");
  });

  it("headscale mode: expires tracked keys, deletes the user's nodes and the user", async () => {
    const client = new HeadscaleApiClient(10001, "key");
    const expire = vi.spyOn(client, "expirePreAuthKey").mockResolvedValue();
    const delNodes = vi.spyOn(client, "deleteNodesByUser").mockResolvedValue(2);
    const delUser = vi.spyOn(client, "deleteUser").mockResolvedValue();
    outstanding = [
      { id: "a", controlKeyId: "11" },
      { id: "b", controlKeyId: "12" },
      { id: "c", controlKeyId: null },
    ];

    const r = await revokeMemberAccess({ tenantId: "t1", client, userId: "user-1", hsUsername: "bob-bsky-social" });

    expect(expire.mock.calls.map((c) => c[0])).toEqual(["11", "12"]);
    expect(delNodes).toHaveBeenCalledWith("bob-bsky-social");
    expect(delUser).toHaveBeenCalledWith("bob-bsky-social");
    expect(r).toEqual({ devicesDeleted: 2, keysRevoked: 2, errors: [] });
    expect(updates).toHaveLength(1);
  });

  it("keeps going when a step fails and reports it", async () => {
    const client = new CoordinatorApiClient("http://coord", "coord-tenant", "k");
    vi.spyOn(client, "revokePreAuthKeysByOwner").mockRejectedValue(new Error("boom"));
    const del = vi.spyOn(client, "deleteNodesByOwner").mockResolvedValue(1);

    const r = await revokeMemberAccess({ tenantId: "t1", client, userId: "user-1", hsUsername: "bob" });
    expect(del).toHaveBeenCalled();
    expect(r.errors).toEqual(["revoke_keys"]);
    expect(r.devicesDeleted).toBe(1);
  });

  it("still marks DB keys revoked when no control client is available", async () => {
    outstanding = [{ id: "a", controlKeyId: "11" }];
    const r = await revokeMemberAccess({ tenantId: "t1", client: null, userId: "u", hsUsername: "h" });
    expect(r.devicesDeleted).toBe(0);
    expect(updates).toHaveLength(1);
  });
});
