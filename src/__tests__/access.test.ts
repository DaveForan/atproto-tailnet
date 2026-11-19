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

import {
  revokeMemberAccess,
  filterVisibleKeys,
  memberKeyOptionsError,
  revokeAllTenantKeys,
  MEMBER_MAX_KEY_HOURS,
  type AuthKeyView,
} from "../routes/access.js";
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

describe("memberKeyOptionsError (who may mint which keys)", () => {
  it("device managers may mint reusable, long-lived keys", () => {
    expect(memberKeyOptionsError({ reusable: true, expiresInHours: 720 }, true)).toBeNull();
  });

  it("members may mint single-use keys up to the member limit", () => {
    expect(memberKeyOptionsError({}, false)).toBeNull();
    expect(memberKeyOptionsError({ reusable: false, expiresInHours: MEMBER_MAX_KEY_HOURS }, false)).toBeNull();
  });

  it("members may not mint reusable keys", () => {
    expect(memberKeyOptionsError({ reusable: true }, false)).toMatch(/reusable/);
  });

  it("members may not mint keys that outlive the member limit", () => {
    expect(memberKeyOptionsError({ expiresInHours: MEMBER_MAX_KEY_HOURS + 1 }, false)).toMatch(/at most/);
  });
});

describe("revokeAllTenantKeys (lockdown)", () => {
  beforeEach(() => {
    outstanding = [];
    updates.length = 0;
  });

  it("revokes every outstanding key on the control plane and marks it revoked", async () => {
    const client = new CoordinatorApiClient("http://coord", "coord-tenant", "k");
    const revoke = vi.spyOn(client, "revokePreAuthKey").mockResolvedValue(undefined);
    outstanding = [
      { id: "k1", controlKeyId: "c1" },
      { id: "k2", controlKeyId: "c2" },
    ];
    expect(await revokeAllTenantKeys("t1", client)).toBe(2);
    expect(revoke).toHaveBeenCalledWith("c1");
    expect(revoke).toHaveBeenCalledWith("c2");
    expect(updates).toHaveLength(2);
  });

  it("leaves a key unrevoked locally when the control plane refuses", async () => {
    const client = new CoordinatorApiClient("http://coord", "coord-tenant", "k");
    vi.spyOn(client, "revokePreAuthKey").mockRejectedValueOnce(new Error("down")).mockResolvedValue(undefined);
    outstanding = [
      { id: "k1", controlKeyId: "c1" },
      { id: "k2", controlKeyId: "c2" },
    ];
    expect(await revokeAllTenantKeys("t1", client)).toBe(1);
    expect(updates).toHaveLength(1);
  });
});
