/**
 * Tests for pure helper functions from routes/helpers.ts.
 *
 * Only tests the stateless/pure functions that don't require DB or Express:
 * - toHsUsername() — AT Proto handle to Headscale username
 * - tenantLoginServer() — build login server URL from slug
 * - param() — normalise Express 5 params
 */

import { describe, it, expect } from "vitest";
import { toHsUsername, tenantLoginServer, param } from "../routes/helpers.js";

describe("toHsUsername", () => {
  it("converts a simple handle to lowercase", () => {
    expect(toHsUsername("alice.bsky.social")).toBe("alice-bsky-social");
  });

  it("converts an uppercase handle to lowercase", () => {
    expect(toHsUsername("Alice.BSky.Social")).toBe("alice-bsky-social");
  });

  it("replaces dots with hyphens", () => {
    expect(toHsUsername("my.handle.example.com")).toBe(
      "my-handle-example-com",
    );
  });

  it("strips leading and trailing hyphens", () => {
    expect(toHsUsername(".leading.dot")).toBe("leading-dot");
    expect(toHsUsername("trailing.dot.")).toBe("trailing-dot");
  });

  it("collapses consecutive non-alphanumeric characters into one hyphen", () => {
    expect(toHsUsername("foo...bar")).toBe("foo-bar");
    expect(toHsUsername("foo--bar")).toBe("foo-bar");
  });

  it("handles a minimal single-label handle", () => {
    expect(toHsUsername("alice")).toBe("alice");
  });

  it("strips special characters", () => {
    expect(toHsUsername("user@name!test")).toBe("user-name-test");
  });

  it("returns empty string for all-special-character input", () => {
    expect(toHsUsername("...")).toBe("");
  });

  it("handles numeric handles", () => {
    expect(toHsUsername("12345")).toBe("12345");
  });
});

describe("tenantLoginServer", () => {
  // config defaults: publicUrl = "http://localhost:3000", baseDomain = "ts.localhost"

  it("builds a login server URL with the slug as subdomain", () => {
    const url = tenantLoginServer("my-tenant");
    expect(url).toBe("http://my-tenant.ts.localhost");
  });

  it("uses http protocol when publicUrl is http", () => {
    const url = tenantLoginServer("test");
    expect(url).toMatch(/^http:\/\//);
  });

  it("includes baseDomain from config", () => {
    const url = tenantLoginServer("acme");
    expect(url).toContain("ts.localhost");
  });

  it("works with hyphenated slugs", () => {
    const url = tenantLoginServer("my-cool-tenant");
    expect(url).toBe("http://my-cool-tenant.ts.localhost");
  });
});

describe("param", () => {
  it("returns a plain string from a string param", () => {
    const fakeReq = { params: { id: "abc123" } } as any;
    expect(param(fakeReq, "id")).toBe("abc123");
  });

  it("returns the first element when param is an array", () => {
    const fakeReq = { params: { id: ["first", "second"] } } as any;
    expect(param(fakeReq, "id")).toBe("first");
  });

  it("returns undefined for a missing param", () => {
    const fakeReq = { params: {} } as any;
    expect(param(fakeReq, "missing")).toBeUndefined();
  });
});
