/** Identity pushed to the coordinator: tailnet name + member handles. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const queue: unknown[] = [];
vi.mock("../db/index.js", () => {
  const chain = (): unknown =>
    new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === "then") {
          const next = queue.length ? queue.shift() : [];
          return (res: (v: unknown) => unknown) => Promise.resolve(next).then(res);
        }
        return () => chain();
      },
    });
  return { db: { select: () => chain() }, pool: {} };
});

import { buildTenantIdentity } from "../orchestrator/coordinator-identity.js";

beforeEach(() => {
  queue.length = 0;
});

describe("buildTenantIdentity", () => {
  it("uses the tailnet name and maps each member's user id to their handle", async () => {
    queue.push(
      [{ name: "Dave's tailnet", slug: "daveforan-bsky-social" }],
      [
        { userId: "u-1", handle: "daveforan.bsky.social", displayName: "Dave" },
        { userId: "u-2", handle: "friend.bsky.social", displayName: null },
      ],
    );
    expect(await buildTenantIdentity("t-1")).toEqual({
      tailnet_name: "Dave's tailnet",
      users: {
        "u-1": { login_name: "daveforan.bsky.social", display_name: "Dave" },
        "u-2": { login_name: "friend.bsky.social", display_name: "friend.bsky.social" },
      },
    });
  });

  it("falls back to the slug and clips long names", async () => {
    queue.push([{ name: "", slug: "my-slug" }], [{ userId: "u-1", handle: "h".repeat(400), displayName: "  " }]);
    const id = await buildTenantIdentity("t-1");
    expect(id?.tailnet_name).toBe("my-slug");
    expect(id?.users["u-1"].login_name).toHaveLength(256);
  });

  it("returns null for an unknown tenant", async () => {
    queue.push([]);
    expect(await buildTenantIdentity("missing")).toBeNull();
  });
});
