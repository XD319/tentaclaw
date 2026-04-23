import type { MemoryScope, TokenBudget } from "../../types/index.js";

export interface RecallBudgetPolicyConfig {
  budgetRatio: number;
}

export interface RecallBudgetResult {
  totalTokenBudget: number;
  scopeWeights: Record<MemoryScope, number>;
}

const DEFAULT_SCOPE_WEIGHTS: Record<MemoryScope, number> = {
  experience_ref: 0.75,
  profile: 0.9,
  project: 0.95,
  skill_ref: 0.65,
  working: 1
};

export class RecallBudgetPolicy {
  public constructor(private readonly config: RecallBudgetPolicyConfig) {}

  public computeBudget(tokenBudget: TokenBudget): RecallBudgetResult {
    const tokenLimit = Math.max(0, tokenBudget.inputLimit - tokenBudget.reservedOutput);
    const totalTokenBudget = Math.max(0, Math.floor(tokenLimit * this.config.budgetRatio));
    return {
      scopeWeights: DEFAULT_SCOPE_WEIGHTS,
      totalTokenBudget
    };
  }
}
