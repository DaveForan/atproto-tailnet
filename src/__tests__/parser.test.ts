import { describe, it, expect } from "vitest";
import { parsePolicy } from "../policy-engine/parser.js";

describe("parsePolicy", () => {
  it("accepts a valid deny-default policy with identity-match", () => {
    const { policy, errors } = parsePolicy({
      rules: [
        { type: "identity-match", action: "allow", match: "did:plc:abc*" },
      ],
      default: "deny",
    });
    expect(errors).toEqual([]);
    expect(policy).not.toBeNull();
    expect(policy!.rules).toHaveLength(1);
    expect(policy!.default).toBe("deny");
  });

  it("accepts an allow-default policy with no rules", () => {
    const { policy, errors } = parsePolicy({ rules: [], default: "allow" });
    expect(errors).toEqual([]);
    expect(policy!.rules).toHaveLength(0);
  });

  it("rejects unknown rule type", () => {
    const { policy, errors } = parsePolicy({
      rules: [{ type: "bogus", action: "allow" }],
      default: "deny",
    });
    expect(policy).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("rules.0.type");
  });

  it("rejects missing default", () => {
    const { errors } = parsePolicy({ rules: [] });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects identity-match without match field", () => {
    const { errors } = parsePolicy({
      rules: [{ type: "identity-match", action: "allow" }],
      default: "deny",
    });
    expect(errors.some((e) => e.includes("requires 'match'"))).toBe(true);
  });

  it("rejects time-window without hours or days", () => {
    const { errors } = parsePolicy({
      rules: [{ type: "time-window", action: "deny" }],
      default: "allow",
    });
    expect(errors.some((e) => e.includes("requires 'hours' or 'days'"))).toBe(true);
  });

  it("rejects bad hours format", () => {
    const { errors } = parsePolicy({
      rules: [{ type: "time-window", action: "deny", hours: "9am-5pm" }],
      default: "allow",
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("accepts valid time-window with hours and days", () => {
    const { policy, errors } = parsePolicy({
      rules: [
        { type: "time-window", action: "deny", hours: "09:00-17:00", days: ["mon", "tue"] },
      ],
      default: "allow",
    });
    expect(errors).toEqual([]);
    expect(policy!.rules[0].hours).toBe("09:00-17:00");
  });

  it("rejects resource-scope without allow or deny", () => {
    const { errors } = parsePolicy({
      rules: [{ type: "resource-scope", action: "allow" }],
      default: "deny",
    });
    expect(errors.some((e) => e.includes("requires 'allow' or 'deny'"))).toBe(true);
  });

  it("rejects depth-limit without maxDepth", () => {
    const { errors } = parsePolicy({
      rules: [{ type: "depth-limit", action: "deny" }],
      default: "allow",
    });
    expect(errors.some((e) => e.includes("requires 'maxDepth'"))).toBe(true);
  });

  it("rejects delegate without delegateTo", () => {
    const { errors } = parsePolicy({
      rules: [{ type: "delegate", action: "delegate" }],
      default: "deny",
    });
    expect(errors.some((e) => e.includes("requires 'delegateTo'"))).toBe(true);
  });

  it("rejects delegate with non-delegate action", () => {
    const { errors } = parsePolicy({
      rules: [{ type: "delegate", action: "allow", delegateTo: "some-service" }],
      default: "deny",
    });
    expect(errors.some((e) => e.includes("must have action 'delegate'"))).toBe(true);
  });

  it("rejects >100 rules", () => {
    const rules = Array.from({ length: 101 }, () => ({
      type: "identity-match" as const,
      action: "allow" as const,
      match: "*",
    }));
    const { errors } = parsePolicy({ rules, default: "deny" });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("accepts collective-identity with match", () => {
    const { policy, errors } = parsePolicy({
      rules: [{ type: "collective-identity", action: "allow", match: "tenant-abc" }],
      default: "deny",
    });
    expect(errors).toEqual([]);
    expect(policy!.rules[0].type).toBe("collective-identity");
  });

  it("accepts reputation-gate with minScore", () => {
    const { policy, errors } = parsePolicy({
      rules: [{ type: "reputation-gate", action: "deny", minScore: 0.5 }],
      default: "allow",
    });
    expect(errors).toEqual([]);
    expect(policy!.rules[0].minScore).toBe(0.5);
  });

  it("rejects minScore > 1", () => {
    const { errors } = parsePolicy({
      rules: [{ type: "reputation-gate", action: "deny", minScore: 1.5 }],
      default: "allow",
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects reputation-gate without minScore", () => {
    const { errors } = parsePolicy({
      rules: [{ type: "reputation-gate", action: "deny" }],
      default: "allow",
    });
    expect(errors.some((e) => e.includes("requires 'minScore'"))).toBe(true);
  });

  it("rejects bandwidth-cap without rateLimitPerMinute", () => {
    const { errors } = parsePolicy({
      rules: [{ type: "bandwidth-cap", action: "deny" }],
      default: "allow",
    });
    expect(errors.some((e) => e.includes("requires 'rateLimitPerMinute'"))).toBe(true);
  });

  it("accepts bandwidth-cap with rateLimitPerMinute", () => {
    const { policy, errors } = parsePolicy({
      rules: [{ type: "bandwidth-cap", action: "deny", rateLimitPerMinute: 100 }],
      default: "allow",
    });
    expect(errors).toEqual([]);
    expect(policy!.rules[0].rateLimitPerMinute).toBe(100);
  });

  it("rejects non-object input", () => {
    const { errors } = parsePolicy("not an object");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects null input", () => {
    const { errors } = parsePolicy(null);
    expect(errors.length).toBeGreaterThan(0);
  });
});
