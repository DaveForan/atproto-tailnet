/**
 * @module policy-engine/evaluator
 * Core evaluation engine for traversal policies (ADR-0011).
 * Evaluates rules top-to-bottom, first match wins, implicit deny default.
 */

import type {
  TraversalRequest,
  PolicyRule,
  TraversalPolicy,
  EvaluationResult,
  PolicyEvaluationTrace,
  CompiledPolicy,
} from "./types.js";

export interface EvaluationContext {
  membershipLookup: (collectiveId: string) => Promise<string[]>;
  federationLinkCheck: (src: string, dst: string) => Promise<boolean>;
  hierarchyDepth: (src: string, dst: string) => number;
}

export async function evaluatePolicy(
  policy: TraversalPolicy,
  request: TraversalRequest,
  context: EvaluationContext,
): Promise<EvaluationResult> {
  for (let i = 0; i < policy.rules.length; i++) {
    const rule = policy.rules[i];
    const match = await evaluateRule(rule, request, context);
    if (match !== null) {
      return {
        verdict: rule.action,
        ruleIndex: i,
        ruleType: rule.type,
        reason: match,
        delegateTo: rule.action === "delegate" ? rule.delegateTo : undefined,
      };
    }
  }

  return {
    verdict: policy.default,
    ruleIndex: -1,
    ruleType: "default",
    reason: `no rule matched, default: ${policy.default}`,
  };
}

async function evaluateRule(
  rule: PolicyRule,
  request: TraversalRequest,
  context: EvaluationContext,
): Promise<string | null> {
  switch (rule.type) {
    case "identity-match":
      return evaluateIdentityMatch(rule, request, context);
    case "time-window":
      return evaluateTimeWindow(rule, request);
    case "resource-scope":
      return evaluateResourceScope(rule, request);
    case "depth-limit":
      return evaluateDepthLimit(rule, request, context);
    case "reputation-gate":
      return "reputation gate: always passes (stub)";
    case "bandwidth-cap":
      return null; // enforced at relay layer, not at policy evaluation
    case "mutual-requirement":
      return evaluateMutualRequirement(rule, request, context);
    case "collective-identity":
      return evaluateCollectiveIdentity(rule, request);
    case "delegate":
      return rule.delegateTo ? `delegate to ${rule.delegateTo}` : null;
    default:
      return null;
  }
}

async function evaluateIdentityMatch(
  rule: PolicyRule,
  request: TraversalRequest,
  context: EvaluationContext,
): Promise<string | null> {
  if (!rule.match) return null;

  if (rule.match.startsWith("members-of(") && rule.match.endsWith(")")) {
    const collectiveId = rule.match.slice("members-of(".length, -1);
    const members = await context.membershipLookup(collectiveId);
    if (members.includes(request.identity)) {
      return `identity is member of ${collectiveId}`;
    }
    return null;
  }

  if (rule.match === "*") {
    return "wildcard identity match";
  }

  if (rule.match.endsWith("*")) {
    const prefix = rule.match.slice(0, -1);
    if (request.identity.startsWith(prefix)) {
      return `identity prefix match: ${prefix}`;
    }
    return null;
  }

  if (request.identity === rule.match) {
    return `exact identity match: ${rule.match}`;
  }

  return null;
}

function evaluateTimeWindow(
  rule: PolicyRule,
  request: TraversalRequest,
): string | null {
  const now = request.timestamp;

  if (rule.days && rule.days.length > 0) {
    const dayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const today = dayNames[now.getUTCDay()];
    if (!rule.days.includes(today)) return null;
  }

  if (rule.hours) {
    const [start, end] = rule.hours.split("-").map((t) => {
      const [h, m] = t.split(":").map(Number);
      return h * 60 + m;
    });
    const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    if (nowMinutes < start || nowMinutes > end) return null;
  }

  return `time window matched: ${rule.hours ?? "all hours"}, ${rule.days?.join(",") ?? "all days"}`;
}

function evaluateResourceScope(
  rule: PolicyRule,
  request: TraversalRequest,
): string | null {
  if (rule.deny && rule.deny.length > 0) {
    const anyDenied = request.requestedResources.some((r) =>
      rule.deny!.some((d) => d === r || cidrContains(d, r)),
    );
    if (anyDenied) {
      return `resource denied by deny list: ${rule.deny.join(", ")}`;
    }
  }

  if (rule.allow && rule.allow.length > 0) {
    const allAllowed = request.requestedResources.every((r) =>
      rule.allow!.some((a) => a === r || cidrContains(a, r)),
    );
    if (allAllowed) {
      return `resources within allowed scope: ${rule.allow.join(", ")}`;
    }
    return null;
  }

  return null;
}

function evaluateDepthLimit(
  rule: PolicyRule,
  request: TraversalRequest,
  context: EvaluationContext,
): string | null {
  if (rule.maxDepth === undefined) return null;

  const depth = context.hierarchyDepth(
    request.sourceCollective,
    request.destinationCollective,
  );

  if (depth <= rule.maxDepth) {
    return `within depth limit: ${depth} <= ${rule.maxDepth}`;
  }

  return null;
}

async function evaluateMutualRequirement(
  _rule: PolicyRule,
  request: TraversalRequest,
  context: EvaluationContext,
): Promise<string | null> {
  const hasLink = await context.federationLinkCheck(
    request.sourceCollective,
    request.destinationCollective,
  );
  if (hasLink) {
    return `mutual federation link exists between ${request.sourceCollective} and ${request.destinationCollective}`;
  }
  return null;
}

function evaluateCollectiveIdentity(
  rule: PolicyRule,
  request: TraversalRequest,
): string | null {
  if (!rule.match) return null;

  if (rule.match === "*") {
    return "wildcard collective match";
  }

  if (request.sourceCollective === rule.match) {
    return `collective identity match: ${rule.match}`;
  }

  return null;
}

function cidrContains(cidr: string, resource: string): boolean {
  if (!cidr.includes("/") || resource.includes("/")) return false;
  const [net, maskStr] = cidr.split("/");
  const mask = parseInt(maskStr, 10);
  if (isNaN(mask) || mask < 0 || mask > 32) return false;

  const netParts = net.split(".").map(Number);
  const resParts = resource.split(".").map(Number);
  if (netParts.length !== 4 || resParts.length !== 4) return false;

  const netInt =
    (netParts[0] << 24) | (netParts[1] << 16) | (netParts[2] << 8) | netParts[3];
  const resInt =
    (resParts[0] << 24) | (resParts[1] << 16) | (resParts[2] << 8) | resParts[3];
  const maskInt = mask === 0 ? 0 : ~0 << (32 - mask);

  return (netInt & maskInt) === (resInt & maskInt);
}

export async function evaluateTraversal(
  request: TraversalRequest,
  egressPolicy: CompiledPolicy | null,
  ingressPolicy: CompiledPolicy | null,
  context: EvaluationContext,
): Promise<PolicyEvaluationTrace> {
  const startTime = Date.now();
  const stages: PolicyEvaluationTrace["stages"] = [];

  if (egressPolicy) {
    const merged = applyInheritance(egressPolicy);
    const result = await evaluatePolicy(merged, request, context);
    stages.push({
      stage: "egress",
      collectiveId: egressPolicy.collectiveId,
      result,
      rulesEvaluated: merged.rules.length,
    });
    if (result.verdict === "deny") {
      return {
        request,
        stages,
        finalVerdict: "deny",
        evaluatedAt: new Date(),
        durationMs: Date.now() - startTime,
      };
    }
  }

  if (ingressPolicy) {
    const merged = applyInheritance(ingressPolicy);
    const result = await evaluatePolicy(merged, request, context);
    stages.push({
      stage: "ingress",
      collectiveId: ingressPolicy.collectiveId,
      result,
      rulesEvaluated: merged.rules.length,
    });
    if (result.verdict === "deny") {
      return {
        request,
        stages,
        finalVerdict: "deny",
        evaluatedAt: new Date(),
        durationMs: Date.now() - startTime,
      };
    }
  }

  return {
    request,
    stages,
    finalVerdict: "allow",
    evaluatedAt: new Date(),
    durationMs: Date.now() - startTime,
  };
}

function applyInheritance(compiled: CompiledPolicy): TraversalPolicy {
  const floorRules = compiled.floors;
  const ceilingRules = compiled.ceilings;
  const ownRules = compiled.policy.rules;

  // Floors prepend (cannot be weakened by child rules)
  // Ceilings append (most restrictive wins — acts as hard limits)
  const merged = [...floorRules, ...ownRules, ...ceilingRules];

  return {
    rules: merged,
    default: compiled.policy.default,
  };
}
