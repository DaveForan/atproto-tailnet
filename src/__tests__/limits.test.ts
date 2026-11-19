import { describe, it, expect, vi, beforeEach } from "vitest";

const notifyMock = vi.fn();
vi.mock("../notifications/service.js", () => ({ notify: (...a: unknown[]) => notifyMock(...a) }));

let memberCount = 0;
vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({ where: async () => [{ count: memberCount }] }),
    })),
  },
}));

import {
  isAtCapacity,
  isOverLimit,
  checkChildLimit,
  enforceDeviceLimit,
  enforceMemberLimit,
} from "../routes/limits.js";

function mockRes() {
  const res: { statusCode?: number; body?: unknown; status: (c: number) => typeof res; json: (b: unknown) => typeof res } = {
    status(c) {
      res.statusCode = c;
      return res;
    },
    json(b) {
      res.body = b;
      return res;
    },
  };
  return res;
}

const tenant = (over: Record<string, unknown> = {}) =>
  ({ id: "t1", name: "Acme", maxDevices: 0, maxMembers: 0, ...over }) as never;

const clientWith = (n: number) =>
  ({ listNodes: vi.fn(async () => Array.from({ length: n }, (_, i) => ({ id: String(i), name: "n" }))) }) as never;

describe("cap arithmetic", () => {
  it("0 means unlimited", () => {
    expect(isAtCapacity(10_000, 0)).toBe(false);
    expect(isOverLimit(10_000, 0)).toBe(false);
  });
  it("capacity is reached at the cap, over only beyond it", () => {
    expect(isAtCapacity(4, 5)).toBe(false);
    expect(isAtCapacity(5, 5)).toBe(true);
    expect(isOverLimit(5, 5)).toBe(false);
    expect(isOverLimit(6, 5)).toBe(true);
  });
});

describe("sub-collective limits", () => {
  it("anything goes under an unlimited parent", () => {
    expect(checkChildLimit("device", 0, 0)).toBeNull();
    expect(checkChildLimit("device", 9999, 0)).toBeNull();
  });
  it("a child may not exceed a capped parent", () => {
    expect(checkChildLimit("device", 11, 10)).toMatch(/exceed/);
    expect(checkChildLimit("member", 10, 10)).toBeNull();
  });
  it("0 (unlimited) under a capped parent is the bypass and is refused", () => {
    expect(checkChildLimit("member", 0, 10)).toMatch(/unlimited/);
  });
});

describe("enforceDeviceLimit", () => {
  beforeEach(() => notifyMock.mockClear());

  it("passes without counting when unlimited", async () => {
    const client = clientWith(100);
    const res = mockRes();
    expect(await enforceDeviceLimit(res as never, tenant(), client)).toBe(true);
    expect((client as unknown as { listNodes: ReturnType<typeof vi.fn> }).listNodes).not.toHaveBeenCalled();
  });

  it("passes below the cap", async () => {
    const res = mockRes();
    expect(await enforceDeviceLimit(res as never, tenant({ maxDevices: 3 }), clientWith(2))).toBe(true);
    expect(res.statusCode).toBeUndefined();
  });

  it("refuses at the cap with code device_limit and notifies", async () => {
    const res = mockRes();
    expect(await enforceDeviceLimit(res as never, tenant({ maxDevices: 3 }), clientWith(3))).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: "device_limit" });
    expect(notifyMock).toHaveBeenCalledWith("t1", "device_limit_reached", expect.any(Object), expect.objectContaining({ dedupeWindowMs: expect.any(Number) }));
  });

  it("fails closed when devices cannot be counted", async () => {
    const res = mockRes();
    const client = { listNodes: vi.fn(async () => { throw new Error("down"); }) } as never;
    expect(await enforceDeviceLimit(res as never, tenant({ maxDevices: 3 }), client)).toBe(false);
    expect(res.statusCode).toBe(502);
  });
});

describe("enforceMemberLimit", () => {
  it("refuses at the cap with code member_limit", async () => {
    memberCount = 5;
    const res = mockRes();
    expect(await enforceMemberLimit(res as never, tenant({ maxMembers: 5 }))).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: "member_limit" });
  });
  it("allows below the cap and when unlimited", async () => {
    memberCount = 4;
    expect(await enforceMemberLimit(mockRes() as never, tenant({ maxMembers: 5 }))).toBe(true);
    memberCount = 1000;
    expect(await enforceMemberLimit(mockRes() as never, tenant())).toBe(true);
  });
});
