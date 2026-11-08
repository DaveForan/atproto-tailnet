import { describe, it, expect } from "vitest";
import {
  parseCidr,
  cidrsOverlap,
  validateOfferedCidrs,
  checkCidrOverlaps,
  isDefaultRoute,
} from "../federation/cidr.js";

describe("parseCidr", () => {
  it("parses a valid IPv4 CIDR", () => {
    const result = parseCidr("10.0.1.0/24");
    expect(result).not.toBeNull();
    expect(result!.family).toBe(4);
    expect(result!.bits).toBe(24);
    expect(result!.normalized).toBe("10.0.1.0/24");
  });

  it("normalizes non-aligned IPv4 prefix", () => {
    const result = parseCidr("10.0.1.5/24");
    expect(result).not.toBeNull();
    expect(result!.normalized).toBe("10.0.1.0/24");
  });

  it("parses /32 (single host)", () => {
    const result = parseCidr("192.168.1.1/32");
    expect(result).not.toBeNull();
    expect(result!.normalized).toBe("192.168.1.1/32");
  });

  it("parses /0 (default route)", () => {
    const result = parseCidr("0.0.0.0/0");
    expect(result).not.toBeNull();
    expect(result!.normalized).toBe("0.0.0.0/0");
  });

  it("parses CGNAT range", () => {
    const result = parseCidr("100.64.0.0/10");
    expect(result).not.toBeNull();
    expect(result!.normalized).toBe("100.64.0.0/10");
  });

  it("rejects invalid IPv4", () => {
    expect(parseCidr("not-a-cidr")).toBeNull();
    expect(parseCidr("10.0.0/24")).toBeNull();
    expect(parseCidr("10.0.0.256/24")).toBeNull();
    expect(parseCidr("10.0.0.0/33")).toBeNull();
    expect(parseCidr("10.0.0.0/-1")).toBeNull();
  });

  it("parses a valid IPv6 CIDR", () => {
    const result = parseCidr("fd7a:115c:a1e0::/48");
    expect(result).not.toBeNull();
    expect(result!.family).toBe(6);
    expect(result!.bits).toBe(48);
  });

  it("parses compressed IPv6", () => {
    const result = parseCidr("::1/128");
    expect(result).not.toBeNull();
    expect(result!.family).toBe(6);
    expect(result!.bits).toBe(128);
  });

  it("rejects invalid IPv6", () => {
    expect(parseCidr("fd7a::/129")).toBeNull();
  });
});

describe("cidrsOverlap", () => {
  it("detects overlapping IPv4 ranges", () => {
    const a = parseCidr("10.0.0.0/8")!;
    const b = parseCidr("10.1.0.0/16")!;
    expect(cidrsOverlap(a, b)).toBe(true);
  });

  it("detects identical ranges", () => {
    const a = parseCidr("100.64.1.0/24")!;
    const b = parseCidr("100.64.1.0/24")!;
    expect(cidrsOverlap(a, b)).toBe(true);
  });

  it("rejects non-overlapping ranges", () => {
    const a = parseCidr("100.64.1.0/24")!;
    const b = parseCidr("100.64.2.0/24")!;
    expect(cidrsOverlap(a, b)).toBe(false);
  });

  it("does not overlap across families", () => {
    const a = parseCidr("10.0.0.0/8")!;
    const b = parseCidr("fd7a::/48")!;
    expect(cidrsOverlap(a, b)).toBe(false);
  });

  it("smaller inside larger overlaps both ways", () => {
    const big = parseCidr("100.64.0.0/10")!;
    const small = parseCidr("100.64.1.0/24")!;
    expect(cidrsOverlap(big, small)).toBe(true);
    expect(cidrsOverlap(small, big)).toBe(true);
  });
});

describe("validateOfferedCidrs", () => {
  it("accepts CIDRs within tenant range", () => {
    const { valid, errors } = validateOfferedCidrs(
      ["100.64.1.0/24", "100.64.1.128/25"],
      "100.64.1.0/24",
      null,
    );
    expect(errors).toEqual([]);
    expect(valid).toHaveLength(2);
  });

  it("rejects CIDRs outside tenant range", () => {
    const { valid, errors } = validateOfferedCidrs(
      ["10.0.0.0/8"],
      "100.64.1.0/24",
      null,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("not within");
    expect(valid).toHaveLength(0);
  });

  it("rejects invalid CIDR strings", () => {
    const { errors } = validateOfferedCidrs(["garbage"], null, null);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Invalid CIDR");
  });

  it("allows any CIDR when tenant has no range set", () => {
    const { valid, errors } = validateOfferedCidrs(
      ["10.0.0.0/24"],
      null,
      null,
    );
    expect(errors).toEqual([]);
    expect(valid).toHaveLength(1);
  });
});

describe("checkCidrOverlaps", () => {
  it("detects overlap with local range", () => {
    const incoming = [parseCidr("100.64.1.0/24")!];
    const local = [parseCidr("100.64.0.0/16")!];
    const errors = checkCidrOverlaps(incoming, local, []);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("overlaps with local range");
  });

  it("detects overlap with existing peer CIDRs", () => {
    const incoming = [parseCidr("10.0.1.0/24")!];
    const existing = [parseCidr("10.0.1.0/24")!];
    const errors = checkCidrOverlaps(incoming, [], existing);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("overlaps with existing peer");
  });

  it("passes with no overlaps", () => {
    const incoming = [parseCidr("10.0.1.0/24")!];
    const local = [parseCidr("100.64.1.0/24")!];
    const existing = [parseCidr("10.0.2.0/24")!];
    const errors = checkCidrOverlaps(incoming, local, existing);
    expect(errors).toEqual([]);
  });
});

describe("isDefaultRoute", () => {
  it("identifies 0.0.0.0/0", () => {
    expect(isDefaultRoute("0.0.0.0/0")).toBe(true);
  });

  it("identifies ::/0", () => {
    expect(isDefaultRoute("::/0")).toBe(true);
  });

  it("rejects non-default routes", () => {
    expect(isDefaultRoute("10.0.0.0/8")).toBe(false);
  });
});
