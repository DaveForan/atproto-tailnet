/**
 * Tests for Zod validation schemas used in ip-config, DERP, and federation routes.
 *
 * Tests the schemas directly (no HTTP, no DB) to verify accept/reject behavior
 * for valid and invalid inputs.
 */

import { describe, it, expect } from "vitest";
import {
  CIDR_V4_RE,
  CIDR_V6_RE,
  ipConfigBody,
} from "../routes/ip-config.js";
import {
  derpRegionSchema,
  derpConfigBody,
} from "../routes/derp.js";
import {
  createFederationBody,
  respondBody,
} from "../routes/federation.js";

// ---------------------------------------------------------------------------
// CIDR regex patterns
// ---------------------------------------------------------------------------

describe("CIDR_V4_RE", () => {
  it.each([
    "100.64.0.0/10",
    "10.0.0.0/8",
    "192.168.1.0/24",
    "172.16.0.0/12",
    "0.0.0.0/0",
    "255.255.255.255/32",
  ])("matches valid IPv4 CIDR: %s", (cidr) => {
    expect(CIDR_V4_RE.test(cidr)).toBe(true);
  });

  it.each([
    "not-a-cidr",
    "100.64.0.0",
    "/10",
    "100.64.0/10",
    "fd7a:115c:a1e0::/48",
    "",
    "100.64.0.0/",
  ])("rejects invalid IPv4 CIDR: %s", (cidr) => {
    expect(CIDR_V4_RE.test(cidr)).toBe(false);
  });
});

describe("CIDR_V6_RE", () => {
  it.each([
    "fd7a:115c:a1e0::/48",
    "fd00::/64",
    "::1/128",
    "2001:db8::/32",
    "fe80::/10",
  ])("matches valid IPv6 CIDR: %s", (cidr) => {
    expect(CIDR_V6_RE.test(cidr)).toBe(true);
  });

  it.each([
    "not-a-cidr",
    "fd7a:115c:a1e0::",
    "/48",
    "",
    "192.168.1.0/24",
  ])("rejects invalid IPv6 CIDR: %s", (cidr) => {
    expect(CIDR_V6_RE.test(cidr)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ipConfigBody schema
// ---------------------------------------------------------------------------

describe("ipConfigBody schema", () => {
  it("accepts a valid full body", () => {
    const result = ipConfigBody.safeParse({
      ipv4Prefix: "10.0.0.0/8",
      ipv6Prefix: "fd00::/64",
      ipAllocation: "random",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty body (all fields optional)", () => {
    const result = ipConfigBody.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts sequential allocation", () => {
    const result = ipConfigBody.safeParse({ ipAllocation: "sequential" });
    expect(result.success).toBe(true);
  });

  it("rejects invalid allocation strategy", () => {
    const result = ipConfigBody.safeParse({ ipAllocation: "roundrobin" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid IPv4 CIDR format", () => {
    const result = ipConfigBody.safeParse({ ipv4Prefix: "not-a-cidr" });
    expect(result.success).toBe(false);
  });

  it("rejects IPv6 value in IPv4 field", () => {
    const result = ipConfigBody.safeParse({
      ipv4Prefix: "fd7a:115c:a1e0::/48",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid IPv6 CIDR format", () => {
    const result = ipConfigBody.safeParse({ ipv6Prefix: "not-a-cidr" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// derpRegionSchema
// ---------------------------------------------------------------------------

describe("derpRegionSchema", () => {
  const validRegion = {
    regionId: 900,
    regionCode: "us-east",
    regionName: "US East Custom",
    nodes: [
      {
        name: "derp1",
        hostname: "derp1.example.com",
        stunPort: 3478,
        derpPort: 443,
      },
    ],
  };

  it("accepts a valid DERP region", () => {
    const result = derpRegionSchema.safeParse(validRegion);
    expect(result.success).toBe(true);
  });

  it("accepts regionId at lower bound (900)", () => {
    const result = derpRegionSchema.safeParse({
      ...validRegion,
      regionId: 900,
    });
    expect(result.success).toBe(true);
  });

  it("accepts regionId at upper bound (999)", () => {
    const result = derpRegionSchema.safeParse({
      ...validRegion,
      regionId: 999,
    });
    expect(result.success).toBe(true);
  });

  it("rejects regionId below 900", () => {
    const result = derpRegionSchema.safeParse({
      ...validRegion,
      regionId: 899,
    });
    expect(result.success).toBe(false);
  });

  it("rejects regionId above 999", () => {
    const result = derpRegionSchema.safeParse({
      ...validRegion,
      regionId: 1000,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer regionId", () => {
    const result = derpRegionSchema.safeParse({
      ...validRegion,
      regionId: 900.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty nodes array", () => {
    const result = derpRegionSchema.safeParse({
      ...validRegion,
      nodes: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects nodes array exceeding max (10)", () => {
    const nodes = Array.from({ length: 11 }, (_, i) => ({
      name: `node-${i}`,
      hostname: `n${i}.example.com`,
    }));
    const result = derpRegionSchema.safeParse({
      ...validRegion,
      nodes,
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty regionCode", () => {
    const result = derpRegionSchema.safeParse({
      ...validRegion,
      regionCode: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects regionCode exceeding max length (10)", () => {
    const result = derpRegionSchema.safeParse({
      ...validRegion,
      regionCode: "a".repeat(11),
    });
    expect(result.success).toBe(false);
  });

  it("accepts node with optional stunPort/derpPort omitted", () => {
    const result = derpRegionSchema.safeParse({
      ...validRegion,
      nodes: [{ name: "n1", hostname: "n1.example.com" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects node with stunPort out of range", () => {
    const result = derpRegionSchema.safeParse({
      ...validRegion,
      nodes: [
        { name: "n1", hostname: "n1.example.com", stunPort: 70000 },
      ],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// derpConfigBody
// ---------------------------------------------------------------------------

describe("derpConfigBody", () => {
  it("accepts an empty body (all optional)", () => {
    const result = derpConfigBody.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts valid regions with boolean toggles", () => {
    const result = derpConfigBody.safeParse({
      regions: [
        {
          regionId: 950,
          regionCode: "eu",
          regionName: "EU Custom",
          nodes: [{ name: "eu1", hostname: "eu1.example.com" }],
        },
      ],
      embeddedDerpEnabled: true,
      usePublicDerp: false,
    });
    expect(result.success).toBe(true);
  });

  it("rejects more than 20 regions", () => {
    const regions = Array.from({ length: 21 }, (_, i) => ({
      regionId: 900 + i,
      regionCode: `r${i}`,
      regionName: `Region ${i}`,
      nodes: [{ name: `n${i}`, hostname: `n${i}.example.com` }],
    }));
    const result = derpConfigBody.safeParse({ regions });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createFederationBody
// ---------------------------------------------------------------------------

describe("createFederationBody", () => {
  it("accepts a minimal valid body", () => {
    const result = createFederationBody.safeParse({
      targetSlug: "partner-net",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a full body with message and cidrs", () => {
    const result = createFederationBody.safeParse({
      targetSlug: "partner-net",
      message: "Let us federate!",
      cidrs: ["10.0.0.0/8", "192.168.0.0/16"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty targetSlug", () => {
    const result = createFederationBody.safeParse({ targetSlug: "" });
    expect(result.success).toBe(false);
  });

  it("rejects targetSlug exceeding 100 chars", () => {
    const result = createFederationBody.safeParse({
      targetSlug: "a".repeat(101),
    });
    expect(result.success).toBe(false);
  });

  it("rejects message exceeding 500 chars", () => {
    const result = createFederationBody.safeParse({
      targetSlug: "ok",
      message: "x".repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it("rejects more than 20 CIDRs", () => {
    const cidrs = Array.from({ length: 21 }, (_, i) => `10.${i}.0.0/16`);
    const result = createFederationBody.safeParse({
      targetSlug: "ok",
      cidrs,
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing body entirely", () => {
    const result = createFederationBody.safeParse(undefined);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// respondBody (federation accept/reject)
// ---------------------------------------------------------------------------

describe("respondBody (federation)", () => {
  it("accepts an empty body", () => {
    const result = respondBody.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts cidrs array", () => {
    const result = respondBody.safeParse({
      cidrs: ["10.0.0.0/8"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects more than 20 CIDRs", () => {
    const cidrs = Array.from({ length: 21 }, (_, i) => `10.${i}.0.0/16`);
    const result = respondBody.safeParse({ cidrs });
    expect(result.success).toBe(false);
  });

  it("rejects empty string in cidrs array", () => {
    const result = respondBody.safeParse({ cidrs: [""] });
    expect(result.success).toBe(false);
  });
});
