import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockResolvedValue([]),
    }),
  },
}));

import { allocateIpv4Prefix, allocateIpv6Prefix } from "../orchestrator/prefix-allocator.js";
import { db } from "../db/index.js";

describe("allocateIpv4Prefix", () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockResolvedValue([]),
    } as any);
  });

  it("allocates the first available /24 (skipping 100.64.0.0/24)", async () => {
    const prefix = await allocateIpv4Prefix();
    expect(prefix).toBe("100.64.1.0/24");
  });

  it("skips existing allocations", async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockResolvedValue([
        { prefix: "100.64.1.0/24" },
      ]),
    } as any);
    const prefix = await allocateIpv4Prefix();
    expect(prefix).toBe("100.64.2.0/24");
  });

  it("skips a tenant with the full CGNAT range", async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockResolvedValue([
        { prefix: "100.64.0.0/10" },
      ]),
    } as any);
    // 100.64.0.0/10 overlaps all candidates — but the allocator just looks
    // for non-overlapping ones. Since /10 covers all /24s in the range,
    // this should throw.
    await expect(allocateIpv4Prefix()).rejects.toThrow("No free IPv4");
  });
});

describe("allocateIpv6Prefix", () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockResolvedValue([]),
    } as any);
  });

  it("allocates the first available /64", async () => {
    const prefix = await allocateIpv6Prefix();
    expect(prefix).toBe("fd7a:115c:a1e0:0001::/64");
  });

  it("skips existing allocations", async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockResolvedValue([
        { prefix: "fd7a:115c:a1e0:0001::/64" },
      ]),
    } as any);
    const prefix = await allocateIpv6Prefix();
    expect(prefix).toBe("fd7a:115c:a1e0:0002::/64");
  });
});
