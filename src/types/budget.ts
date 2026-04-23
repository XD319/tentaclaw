export type BudgetScope = "task" | "thread";
export type BudgetStatus = "within" | "soft" | "hard";
export type BudgetLimitKind = "input" | "output" | "cost";

export interface BudgetLimits {
  softInputTokens?: number | undefined;
  hardInputTokens?: number | undefined;
  softOutputTokens?: number | undefined;
  hardOutputTokens?: number | undefined;
  softCostUsd?: number | undefined;
  hardCostUsd?: number | undefined;
}

export interface BudgetPricingEntry {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number | undefined;
}

export interface BudgetState {
  usedInput: number;
  usedOutput: number;
  usedCostUsd: number;
}

export interface BudgetEnforcementDecision {
  action: "continue" | "soft_downgrade" | "hard_abort";
  reasons: string[];
  status: BudgetStatus;
  breachedLimit: BudgetLimitKind | null;
}

export type RoutingMode = "cheap_first" | "balanced" | "quality_first";
export type ProviderTier = "cheap" | "balanced" | "quality";
export type RouteKind = "main" | "summarize" | "classify" | "recall_rank";
