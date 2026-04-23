import type { JsonObject } from "./common.js";
import type { PathScope, PrivacyLevel, ToolCapability, ToolRiskLevel } from "./governance.js";
import type { AgentProfileId } from "./profile.js";

export const POLICY_EFFECTS = ["allow", "allow_with_approval", "deny"] as const;

export type PolicyEffect = (typeof POLICY_EFFECTS)[number];

export interface PolicyRuleCondition {
  users?: string[] | undefined;
  workspaces?: string[] | undefined;
  agentProfiles?: AgentProfileId[] | undefined;
  toolNames?: string[] | undefined;
  capabilities?: ToolCapability[] | undefined;
  riskLevels?: ToolRiskLevel[] | undefined;
  privacyLevels?: PrivacyLevel[] | undefined;
  pathScopes?: PathScope[] | undefined;
}

export interface PolicyRule {
  id: string;
  description: string;
  effect: PolicyEffect;
  priority: number;
  match: PolicyRuleCondition;
}

export interface LocalPolicyConfig {
  source: "local";
  defaultEffect: PolicyEffect;
  rules: PolicyRule[];
}

export interface PolicyEvaluationInput {
  taskId: string;
  toolCallId: string;
  toolName: string;
  userId: string;
  workspaceRoot: string;
  agentProfileId: AgentProfileId;
  capability: ToolCapability;
  riskLevel: ToolRiskLevel;
  privacyLevel: PrivacyLevel;
  pathScope: PathScope;
  metadata?: JsonObject;
}

export interface PolicyDecision {
  decisionId: string;
  createdAt: string;
  effect: PolicyEffect;
  matchedRuleId: string | null;
  reason: string;
  input: PolicyEvaluationInput;
}
