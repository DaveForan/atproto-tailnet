/**
 * @module policy-engine/types
 * Core types for the Traversal Policy Engine (ADR-0011).
 */

export interface TraversalRequest {
  identity: string;
  sourceCollective: string;
  destinationCollective: string;
  requestedResources: string[];
  timestamp: Date;
}

export type RuleVerdict = "allow" | "deny" | "delegate";

export interface EvaluationResult {
  verdict: RuleVerdict;
  ruleIndex: number;
  ruleType: string;
  reason: string;
  delegateTo?: string;
}

export interface PolicyEvaluationTrace {
  request: TraversalRequest;
  stages: {
    stage: "egress" | "intermediate" | "ingress";
    collectiveId: string;
    result: EvaluationResult;
    rulesEvaluated: number;
  }[];
  finalVerdict: "allow" | "deny";
  evaluatedAt: Date;
  durationMs: number;
}

export type RuleType =
  | "identity-match"
  | "time-window"
  | "resource-scope"
  | "depth-limit"
  | "reputation-gate"
  | "bandwidth-cap"
  | "mutual-requirement"
  | "collective-identity"
  | "delegate";

export interface PolicyRule {
  type: RuleType;
  action: RuleVerdict;
  match?: string;
  hours?: string;
  days?: string[];
  allow?: string[];
  deny?: string[];
  maxDepth?: number;
  minScore?: number;
  rateLimitPerMinute?: number;
  delegateTo?: string;
  delegateTimeoutMs?: number;
}

export interface TraversalPolicy {
  rules: PolicyRule[];
  default: "allow" | "deny";
}

export interface CompiledPolicy {
  collectiveId: string;
  direction: "egress" | "ingress";
  policy: TraversalPolicy;
  compiledAt: Date;
  floors: PolicyRule[];
  ceilings: PolicyRule[];
}
