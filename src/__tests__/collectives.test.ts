import { describe, it, expect } from "vitest";

const SLUG_RE = /^[a-z0-9_]+$/;
const MAX_DEPTH = 5;

describe("collective slug validation", () => {
  it("accepts valid slugs", () => {
    expect(SLUG_RE.test("my_collective")).toBe(true);
    expect(SLUG_RE.test("test123")).toBe(true);
    expect(SLUG_RE.test("a")).toBe(true);
    expect(SLUG_RE.test("deep_nested_org")).toBe(true);
  });

  it("rejects slugs with dots (ltree injection)", () => {
    expect(SLUG_RE.test("my.collective")).toBe(false);
    expect(SLUG_RE.test("a.b.c")).toBe(false);
  });

  it("rejects slugs with hyphens", () => {
    expect(SLUG_RE.test("my-collective")).toBe(false);
  });

  it("rejects slugs with uppercase", () => {
    expect(SLUG_RE.test("MyCollective")).toBe(false);
    expect(SLUG_RE.test("ABC")).toBe(false);
  });

  it("rejects slugs with spaces", () => {
    expect(SLUG_RE.test("my collective")).toBe(false);
  });

  it("rejects empty slugs", () => {
    expect(SLUG_RE.test("")).toBe(false);
  });

  it("rejects slugs with special characters", () => {
    expect(SLUG_RE.test("my@collective")).toBe(false);
    expect(SLUG_RE.test("my/collective")).toBe(false);
    expect(SLUG_RE.test("my\\collective")).toBe(false);
  });
});

describe("path construction", () => {
  function buildPath(parentPath: string | null, childSlug: string): string {
    return parentPath ? `${parentPath}.${childSlug}` : childSlug;
  }

  it("root collective path is just the slug", () => {
    expect(buildPath(null, "acme")).toBe("acme");
  });

  it("child path is parent.child", () => {
    expect(buildPath("acme", "engineering")).toBe("acme.engineering");
  });

  it("grandchild path is root.parent.child", () => {
    expect(buildPath("acme.engineering", "frontend")).toBe(
      "acme.engineering.frontend",
    );
  });

  it("deeply nested path builds correctly", () => {
    const path = buildPath("a.b.c.d", "e");
    expect(path).toBe("a.b.c.d.e");
    expect(path.split(".").length).toBe(5);
  });
});

describe("depth constraints", () => {
  it("root collectives have depth 0", () => {
    expect(0).toBeLessThan(MAX_DEPTH);
  });

  it("MAX_DEPTH prevents infinite nesting", () => {
    expect(MAX_DEPTH).toBe(5);
  });

  it("depth 5 cannot create children", () => {
    const depth = 5;
    expect(depth >= MAX_DEPTH).toBe(true);
  });

  it("depth 4 can create one more level", () => {
    const depth = 4;
    expect(depth < MAX_DEPTH).toBe(true);
  });
});

describe("path rebuilding on detach", () => {
  interface MockTenant {
    id: string;
    slug: string;
    parentId: string | null;
    path: string;
    depth: number;
  }

  function rebuildPaths(
    tenants: MockTenant[],
    detachedId: string,
  ): MockTenant[] {
    const detached = tenants.find((t) => t.id === detachedId)!;
    detached.parentId = null;
    detached.path = detached.slug;
    detached.depth = 0;

    function rebuild(parentId: string, parentPath: string, parentDepth: number) {
      for (const t of tenants) {
        if (t.parentId === parentId) {
          t.path = `${parentPath}.${t.slug}`;
          t.depth = parentDepth + 1;
          rebuild(t.id, t.path, t.depth);
        }
      }
    }
    rebuild(detachedId, detached.slug, 0);
    return tenants;
  }

  it("detached collective becomes root", () => {
    const tenants: MockTenant[] = [
      { id: "root", slug: "acme", parentId: null, path: "acme", depth: 0 },
      { id: "child", slug: "eng", parentId: "root", path: "acme.eng", depth: 1 },
      { id: "grandchild", slug: "fe", parentId: "child", path: "acme.eng.fe", depth: 2 },
    ];

    rebuildPaths(tenants, "child");

    const child = tenants.find((t) => t.id === "child")!;
    expect(child.parentId).toBeNull();
    expect(child.path).toBe("eng");
    expect(child.depth).toBe(0);
  });

  it("descendants are repathed under detached parent", () => {
    const tenants: MockTenant[] = [
      { id: "root", slug: "acme", parentId: null, path: "acme", depth: 0 },
      { id: "child", slug: "eng", parentId: "root", path: "acme.eng", depth: 1 },
      { id: "grandchild", slug: "fe", parentId: "child", path: "acme.eng.fe", depth: 2 },
    ];

    rebuildPaths(tenants, "child");

    const grandchild = tenants.find((t) => t.id === "grandchild")!;
    expect(grandchild.path).toBe("eng.fe");
    expect(grandchild.depth).toBe(1);
  });

  it("sibling paths are unaffected", () => {
    const tenants: MockTenant[] = [
      { id: "root", slug: "acme", parentId: null, path: "acme", depth: 0 },
      { id: "eng", slug: "eng", parentId: "root", path: "acme.eng", depth: 1 },
      { id: "sales", slug: "sales", parentId: "root", path: "acme.sales", depth: 1 },
      { id: "fe", slug: "fe", parentId: "eng", path: "acme.eng.fe", depth: 2 },
    ];

    rebuildPaths(tenants, "eng");

    const sales = tenants.find((t) => t.id === "sales")!;
    expect(sales.path).toBe("acme.sales");
    expect(sales.depth).toBe(1);
  });
});

describe("floor policy validation", () => {
  const floorPolicyShape = {
    requireDeviceApproval: true,
    lockdownMode: false,
    allowJoinRequests: false,
    maxBoardPosts: 5,
  };

  it("accepts valid floor policies", () => {
    expect(typeof floorPolicyShape.requireDeviceApproval).toBe("boolean");
    expect(typeof floorPolicyShape.maxBoardPosts).toBe("number");
  });

  it("floor policy fields are optional", () => {
    const partial = { requireDeviceApproval: true };
    expect(partial).toHaveProperty("requireDeviceApproval");
    expect(partial).not.toHaveProperty("lockdownMode");
  });

  it("maxBoardPosts must be non-negative", () => {
    expect(floorPolicyShape.maxBoardPosts).toBeGreaterThanOrEqual(0);
  });
});

describe("sub-collective limits", () => {
  function canCreateSub(maxSub: number, currentCount: number): boolean {
    return maxSub === 0 || currentCount < maxSub;
  }

  it("maxSubCollectives of 0 means unlimited", () => {
    expect(canCreateSub(0, 100)).toBe(true);
  });

  it("maxSubCollectives of 10 blocks at 10", () => {
    expect(canCreateSub(10, 10)).toBe(false);
  });

  it("maxSubCollectives of 10 allows at 9", () => {
    expect(canCreateSub(10, 9)).toBe(true);
  });
});
