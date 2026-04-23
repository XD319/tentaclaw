import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  AGENT_PROFILE_IDS,
  PATH_SCOPES,
  POLICY_EFFECTS,
  PRIVACY_LEVELS,
  TOOL_CAPABILITIES,
  TOOL_RISK_LEVELS,
  type LocalPolicyConfig,
  type PolicyDecision,
  type PolicyEvaluationInput,
  type PolicyRule
} from "../types/index.js";

const policyRuleConditionSchema = z.object({
  agentProfiles: z.array(z.enum(AGENT_PROFILE_IDS)).optional(),
  capabilities: z.array(z.enum(TOOL_CAPABILITIES)).optional(),
  pathScopes: z.array(z.enum(PATH_SCOPES)).optional(),
  privacyLevels: z.array(z.enum(PRIVACY_LEVELS)).optional(),
  riskLevels: z.array(z.enum(TOOL_RISK_LEVELS)).optional(),
  toolNames: z.array(z.string().min(1)).optional(),
  users: z.array(z.string().min(1)).optional(),
  workspaces: z.array(z.string().min(1)).optional()
});

const policyRuleSchema = z.object({
  description: z.string().min(1),
  effect: z.enum(POLICY_EFFECTS),
  id: z.string().min(1),
  match: policyRuleConditionSchema,
  priority: z.number().int()
});

const localPolicyConfigSchema = z.object({
  defaultEffect: z.enum(POLICY_EFFECTS),
  rules: z.array(policyRuleSchema),
  source: z.literal("local")
});

export class PolicyEngine {
  private readonly config: LocalPolicyConfig;
  private readonly rules: PolicyRule[];

  public constructor(config: LocalPolicyConfig) {
    this.config = localPolicyConfigSchema.parse(config);
    this.rules = [...this.config.rules].sort((left, right) => right.priority - left.priority);
  }

  public evaluate(input: PolicyEvaluationInput): PolicyDecision {
    const matchedRule = this.rules.find((rule) => matchesRule(rule, input)) ?? null;
    const effect = matchedRule?.effect ?? this.config.defaultEffect;

    return {
      createdAt: new Date().toISOString(),
      decisionId: randomUUID(),
      effect,
      input,
      matchedRuleId: matchedRule?.id ?? null,
      reason:
        matchedRule === null
          ? `No local policy rule matched. Defaulting to ${this.config.defaultEffect}.`
          : `${matchedRule.id}: ${matchedRule.description}`
    };
  }
}

function matchesRule(rule: PolicyRule, input: PolicyEvaluationInput): boolean {
  const { match } = rule;

  return (
    includesIfPresent(match.users, input.userId) &&
    includesIfPresent(match.workspaces, input.workspaceRoot) &&
    includesIfPresent(match.agentProfiles, input.agentProfileId) &&
    includesIfPresent(match.toolNames, input.toolName) &&
    includesIfPresent(match.capabilities, input.capability) &&
    includesIfPresent(match.riskLevels, input.riskLevel) &&
    includesIfPresent(match.privacyLevels, input.privacyLevel) &&
    includesIfPresent(match.pathScopes, input.pathScope)
  );
}

function includesIfPresent<T extends string>(values: readonly T[] | undefined, candidate: T): boolean {
  if (values === undefined || values.length === 0) {
    return true;
  }

  return values.includes(candidate);
}
