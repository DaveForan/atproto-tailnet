/**
 * @module policy-engine/parser
 * Parse and validate traversal policy documents (YAML or JSON).
 */

import { z } from "zod";
import type { TraversalPolicy, PolicyRule, RuleType } from "./types.js";

const VALID_RULE_TYPES: RuleType[] = [
  "identity-match",
  "time-window",
  "resource-scope",
  "depth-limit",
  "reputation-gate",
  "bandwidth-cap",
  "mutual-requirement",
  "collective-identity",
  "delegate",
];

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const HOURS_RE = /^\d{2}:\d{2}-\d{2}:\d{2}$/;

const policyRuleSchema = z.object({
  type: z.enum(VALID_RULE_TYPES as [RuleType, ...RuleType[]]),
  action: z.enum(["allow", "deny", "delegate"]),
  match: z.string().optional(),
  hours: z.string().regex(HOURS_RE, "hours must be HH:MM-HH:MM").optional(),
  days: z.array(z.enum(DAY_NAMES as [string, ...string[]])).optional(),
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
  maxDepth: z.number().int().min(0).optional(),
  minScore: z.number().min(0).max(1).optional(),
  rateLimitPerMinute: z.number().int().min(1).optional(),
  delegateTo: z.string().optional(),
  delegateTimeoutMs: z.number().int().min(100).max(30000).optional(),
});

const traversalPolicySchema = z.object({
  rules: z.array(policyRuleSchema).max(100),
  default: z.enum(["allow", "deny"]),
});

export function parsePolicy(input: unknown): {
  policy: TraversalPolicy | null;
  errors: string[];
} {
  const result = traversalPolicySchema.safeParse(input);
  if (!result.success) {
    return {
      policy: null,
      errors: result.error.issues.map(
        (i) => `${i.path.join(".")}: ${i.message}`,
      ),
    };
  }

  const policy = result.data as TraversalPolicy;
  const errors: string[] = [];

  for (let i = 0; i < policy.rules.length; i++) {
    const rule = policy.rules[i];
    const ruleErrors = validateRuleSemantics(rule, i);
    errors.push(...ruleErrors);
  }

  if (errors.length > 0) {
    return { policy: null, errors };
  }

  return { policy, errors: [] };
}

function validateRuleSemantics(rule: PolicyRule, index: number): string[] {
  const errors: string[] = [];
  const prefix = `rules[${index}]`;

  switch (rule.type) {
    case "identity-match":
    case "collective-identity":
      if (!rule.match) {
        errors.push(`${prefix}: ${rule.type} requires 'match' field`);
      }
      break;
    case "time-window":
      if (!rule.hours && (!rule.days || rule.days.length === 0)) {
        errors.push(`${prefix}: time-window requires 'hours' or 'days'`);
      }
      break;
    case "resource-scope":
      if (!rule.allow && !rule.deny) {
        errors.push(`${prefix}: resource-scope requires 'allow' or 'deny'`);
      }
      break;
    case "depth-limit":
      if (rule.maxDepth === undefined) {
        errors.push(`${prefix}: depth-limit requires 'maxDepth'`);
      }
      break;
    case "reputation-gate":
      if (rule.minScore === undefined) {
        errors.push(`${prefix}: reputation-gate requires 'minScore'`);
      }
      break;
    case "bandwidth-cap":
      if (rule.rateLimitPerMinute === undefined) {
        errors.push(`${prefix}: bandwidth-cap requires 'rateLimitPerMinute'`);
      }
      break;
    case "delegate":
      if (!rule.delegateTo) {
        errors.push(`${prefix}: delegate requires 'delegateTo'`);
      }
      if (rule.action !== "delegate") {
        errors.push(`${prefix}: delegate rule must have action 'delegate'`);
      }
      break;
  }

  return errors;
}