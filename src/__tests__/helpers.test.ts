/** Pure helpers from routes/helpers.ts: tenantLoginServer and param. */

import { describe, it, expect } from "vitest";
import { tenantLoginServer, param } from "../routes/helpers.js";

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
