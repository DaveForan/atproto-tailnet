import { describe, it, expect } from "vitest";
import { evaluatePolicy, evaluateTraversal } from "../policy-engine/evaluator.js";
import type { TraversalPolicy, TraversalRequest, CompiledPolicy, PolicyRule } from "../policy-engine/types.js";

const stubContext = {
  membershipLookup: async () => [] as string[],
  federationLinkCheck: async () => true,
  hierarchyDepth: () => 1,
};

function makeRequest(overrides: Partial<TraversalRequest> = {}): TraversalRequest {
  return {
    identity: "did:plc:test123",
    sourceCollective: "collective-a",
    destinationCollective: "collective-b",
    requestedResources: [],
    timestamp: new Date("2026-11-03T14:00:00Z"), // Tuesday 14:00 UTC
    ...overrides,
  };
}

describe("evaluatePolicy", () => {
  it("returns default when no rules match", async () => {
    const policy: TraversalPolicy = { rules: [], default: "deny" };
    const result = await evaluatePolicy(policy, makeRequest(), stubContext);
    expect(result.verdict).toBe("deny");
    expect(result.ruleIndex).toBe(-1);
  });

  it("matches exact identity", async () => {
    const policy: TraversalPolicy = {
      rules: [{ type: "identity-match", action: "allow", match: "did:plc:test123" }],
      default: "deny",
    };
    const result = await evaluatePolicy(policy, makeRequest(), stubContext);
    expect(result.verdict).toBe("allow");
    expect(result.ruleIndex).toBe(0);
  });

  it("matches wildcard identity", async () => {
    const policy: TraversalPolicy = {
      rules: [{ type: "identity-match", action: "allow", match: "*" }],
      default: "deny",
    };
    const result = await evaluatePolicy(policy, makeRequest(), stubContext);
    expect(result.verdict).toBe("allow");
  });

  it("matches prefix identity", async () => {
    const policy: TraversalPolicy = {
      rules: [{ type: "identity-match", action: "allow", match: "did:plc:*" }],
      default: "deny",
    };
    const result = await evaluatePolicy(policy, makeRequest(), stubContext);
    expect(result.verdict).toBe("allow");
  });

  it("does not match wrong identity", async () => {
    const policy: TraversalPolicy = {
      rules: [{ type: "identity-match", action: "allow", match: "did:plc:other" }],
      default: "deny",
    };
    const result = await evaluatePolicy(policy, makeRequest(), stubContext);
    expect(result.verdict).toBe("deny");
  });

  it("first matching rule wins", async () => {
    const policy: TraversalPolicy = {
      rules: [
        { type: "identity-match", action: "deny", match: "did:plc:test123" },
        { type: "identity-match", action: "allow", match: "*" },
      ],
      default: "allow",
    };
    const result = await evaluatePolicy(policy, makeRequest(), stubContext);
    expect(result.verdict).toBe("deny");
    expect(result.ruleIndex).toBe(0);
  });

  it("time-window matches within hours", async () => {
    const policy: TraversalPolicy = {
      rules: [{ type: "time-window", action: "deny", hours: "13:00-15:00" }],
      default: "allow",
    };
    const result = await evaluatePolicy(policy, makeRequest(), stubContext);
    expect(result.verdict).toBe("deny");
  });

  it("time-window does not match outside hours", async () => {
    const policy: TraversalPolicy = {
      rules: [{ type: "time-window", action: "deny", hours: "20:00-23:00" }],
      default: "allow",
    };
    const result = await evaluatePolicy(policy, makeRequest(), stubContext);
    expect(result.verdict).toBe("allow");
  });

  it("time-window matches day of week", async () => {
    const policy: TraversalPolicy = {
      rules: [{ type: "time-window", action: "deny", days: ["mon", "tue"] }],
      default: "allow",
    };
    const result = await evaluatePolicy(policy, makeRequest(), stubContext);
    expect(result.verdict).toBe("deny");
  });

  it("time-window does not match wrong day", async () => {
    const policy: TraversalPolicy = {
      rules: [{ type: "time-window", action: "deny", days: ["sat", "sun"] }],
      default: "allow",
    };
    const result = await evaluatePolicy(policy, makeRequest(), stubContext);
    expect(result.verdict).toBe("allow");
  });

  it("resource-scope allows matching CIDRs", async () => {
    const policy: TraversalPolicy = {
      rules: [{ type: "resource-scope", action: "allow", allow: ["10.0.0.0/8"] }],
      default: "deny",
    };
    const result = await evaluatePolicy(
      policy,
      makeRequest({ requestedResources: ["10.1.2.3"] }),
      stubContext,
    );
    expect(result.verdict).toBe("allow");
  });

  it("resource-scope denies non-matching CIDR", async () => {
    const policy: TraversalPolicy = {
      rules: [{ type: "resource-scope", action: "allow", allow: ["10.0.0.0/8"] }],
      default: "deny",
    };
    const result = await evaluatePolicy(
      policy,
      makeRequest({ requestedResources: ["192.168.1.1"] }),
      stubContext,
    );
    expect(result.verdict).toBe("deny");
  });

  it("resource-scope deny list blocks matching resources", async () => {
    const policy: TraversalPolicy = {
      rules: [{ type: "resource-scope", action: "deny", deny: ["192.168.0.0/16"] }],
      default: "allow",
    };
    const result = await evaluatePolicy(
      policy,
      makeRequest({ requestedResources: ["192.168.1.1"] }),
      stubContext,
    );
    expect(result.verdict).toBe("deny");
  });

  it("resource-scope deny list passes non-matching resources", async () => {
    const policy: TraversalPolicy = {
      rules: [{ type: "resource-scope", action: "deny", deny: ["192.168.0.0/16"] }],
      default: "allow",
    };
    const result = await evaluatePolicy(
      policy,
      makeRequest({ requestedResources: ["10.0.0.1"] }),
      stubContext,
    );
    expect(result.verdict).toBe("allow");
  });

  it("depth-limit allows within limit", async () => {
    const policy: TraversalPolicy = {
      rules: [{ type: "depth-limit", action: "allow", maxDepth: 3 }],
      default: "deny",
    };
    const result = await evaluatePolicy(policy, makeRequest(), {
      ...stubContext,
      hierarchyDepth: () => 2,
    });
    expect(result.verdict).toBe("allow");
  });

  it("depth-limit does not match beyond limit", async () => {
    const policy: TraversalPolicy = {
      rules: [{ type: "depth-limit", action: "allow", maxDepth: 1 }],
      default: "deny",
    };
    const result = await evaluatePolicy(policy, makeRequest(), {
      ...stubContext,
      hierarchyDepth: () => 5,
    });
    expect(result.verdict).toBe("deny");
  });

  it("collective-identity matches source collective", async () => {
    const policy: TraversalPolicy = {
      rules: [{ type: "collective-identity", action: "allow", match: "collective-a" }],
      default: "deny",
    };
    const result = await evaluatePolicy(policy, makeRequest(), stubContext);
    expect(result.verdict).toBe("allow");
  });

  it("delegate rule returns delegate verdict", async () => {
    const policy: TraversalPolicy = {
      rules: [{ type: "delegate", action: "delegate", delegateTo: "policy-service.local" }],
      default: "deny",
    };
    const result = await evaluatePolicy(policy, makeRequest(), stubContext);
    expect(result.verdict).toBe("delegate");
    expect(result.delegateTo).toBe("policy-service.local");
  });

  it("members-of matches when identity is in lookup", async () => {
    const policy: TraversalPolicy = {
      rules: [{ type: "identity-match", action: "allow", match: "members-of(group-x)" }],
      default: "deny",
    };
    const ctx = {
      ...stubContext,
      membershipLookup: async (id: string) =>
        id === "group-x" ? ["did:plc:test123", "did:plc:other"] : [],
    };
    const result = await evaluatePolicy(policy, makeRequest(), ctx);
    expect(result.verdict).toBe("allow");
  });

  it("members-of does NOT match when identity is absent", async () => {
    const policy: TraversalPolicy = {
      rules: [{ type: "identity-match", action: "allow", match: "members-of(group-x)" }],
      default: "deny",
    };
    const ctx = {
      ...stubContext,
      membershipLookup: async () => ["did:plc:other"],
    };
    const result = await evaluatePolicy(policy, makeRequest(), ctx);
    expect(result.verdict).toBe("deny");
  });

  it("mutual-requirement matches when federation link exists", async () => {
    const policy: TraversalPolicy = {
      rules: [{ type: "mutual-requirement", action: "allow" }],
      default: "deny",
    };
    const result = await evaluatePolicy(policy, makeRequest(), {
      ...stubContext,
      federationLinkCheck: async () => true,
    });
    expect(result.verdict).toBe("allow");
  });

  it("mutual-requirement does not match when no link", async () => {
    const policy: TraversalPolicy = {
      rules: [{ type: "mutual-requirement", action: "allow" }],
      default: "deny",
    };
    const result = await evaluatePolicy(policy, makeRequest(), {
      ...stubContext,
      federationLinkCheck: async () => false,
    });
    expect(result.verdict).toBe("deny");
  });
});

describe("evaluateTraversal (3-stage)", () => {
  function compiledPolicy(
    direction: "egress" | "ingress",
    rules: PolicyRule[],
    defaultVerdict: "allow" | "deny" = "deny",
  ): CompiledPolicy {
    return {
      collectiveId: direction === "egress" ? "collective-a" : "collective-b",
      direction,
      policy: { rules, default: defaultVerdict },
      compiledAt: new Date(),
      floors: [],
      ceilings: [],
    };
  }

  it("allows when both egress and ingress allow", async () => {
    const egress = compiledPolicy("egress", [
      { type: "identity-match", action: "allow", match: "*" },
    ]);
    const ingress = compiledPolicy("ingress", [
      { type: "identity-match", action: "allow", match: "*" },
    ]);
    const trace = await evaluateTraversal(makeRequest(), egress, ingress, stubContext);
    expect(trace.finalVerdict).toBe("allow");
    expect(trace.stages).toHaveLength(2);
  });

  it("denies when egress denies (short-circuit)", async () => {
    const egress = compiledPolicy("egress", [
      { type: "identity-match", action: "deny", match: "*" },
    ]);
    const ingress = compiledPolicy("ingress", [
      { type: "identity-match", action: "allow", match: "*" },
    ]);
    const trace = await evaluateTraversal(makeRequest(), egress, ingress, stubContext);
    expect(trace.finalVerdict).toBe("deny");
    expect(trace.stages).toHaveLength(1);
  });

  it("denies when ingress denies", async () => {
    const egress = compiledPolicy("egress", [
      { type: "identity-match", action: "allow", match: "*" },
    ]);
    const ingress = compiledPolicy("ingress", [
      { type: "identity-match", action: "deny", match: "*" },
    ]);
    const trace = await evaluateTraversal(makeRequest(), egress, ingress, stubContext);
    expect(trace.finalVerdict).toBe("deny");
    expect(trace.stages).toHaveLength(2);
  });

  it("allows when both policies are null (open federation)", async () => {
    const trace = await evaluateTraversal(makeRequest(), null, null, stubContext);
    expect(trace.finalVerdict).toBe("allow");
    expect(trace.stages).toHaveLength(0);
  });

  it("floor rules are prepended and cannot be weakened", async () => {
    const egress: CompiledPolicy = {
      collectiveId: "collective-a",
      direction: "egress",
      policy: {
        rules: [{ type: "identity-match", action: "allow", match: "*" }],
        default: "allow",
      },
      compiledAt: new Date(),
      floors: [{ type: "identity-match", action: "deny", match: "did:plc:banned*" }],
      ceilings: [],
    };

    const trace = await evaluateTraversal(
      makeRequest({ identity: "did:plc:banned123" }),
      egress,
      null,
      stubContext,
    );
    expect(trace.finalVerdict).toBe("deny");
    expect(trace.stages[0].result.ruleIndex).toBe(0);
  });

  it("ceiling rules are appended as hard limits", async () => {
    const egress: CompiledPolicy = {
      collectiveId: "collective-a",
      direction: "egress",
      policy: {
        rules: [],
        default: "allow",
      },
      compiledAt: new Date(),
      floors: [],
      ceilings: [{ type: "identity-match", action: "deny", match: "did:plc:test123" }],
    };

    const trace = await evaluateTraversal(
      makeRequest(),
      egress,
      null,
      stubContext,
    );
    expect(trace.finalVerdict).toBe("deny");
  });
});
