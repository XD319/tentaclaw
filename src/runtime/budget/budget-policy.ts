import type {
  BudgetEnforcementDecision,
  BudgetLimitKind,
  BudgetLimits,
  BudgetState
} from "../../types/index.js";

export function classifyBudgetState(
  state: BudgetState,
  limits: BudgetLimits
): BudgetEnforcementDecision {
  const hard = evaluate(state, limits, "hard");
  if (hard.breachedLimit !== null) {
    return {
      action: "hard_abort",
      breachedLimit: hard.breachedLimit,
      reasons: hard.reasons,
      status: "hard"
    };
  }

  const soft = evaluate(state, limits, "soft");
  if (soft.breachedLimit !== null) {
    return {
      action: "soft_downgrade",
      breachedLimit: soft.breachedLimit,
      reasons: soft.reasons,
      status: "soft"
    };
  }

  return {
    action: "continue",
    breachedLimit: null,
    reasons: [],
    status: "within"
  };
}

function evaluate(
  state: BudgetState,
  limits: BudgetLimits,
  kind: "soft" | "hard"
): { breachedLimit: BudgetLimitKind | null; reasons: string[] } {
  const reasons: string[] = [];
  let breachedLimit: BudgetLimitKind | null = null;

  const inputLimit = kind === "soft" ? limits.softInputTokens : limits.hardInputTokens;
  if (inputLimit !== undefined && state.usedInput >= inputLimit) {
    breachedLimit ??= "input";
    reasons.push(`${kind} input token limit reached`);
  }

  const outputLimit = kind === "soft" ? limits.softOutputTokens : limits.hardOutputTokens;
  if (outputLimit !== undefined && state.usedOutput >= outputLimit) {
    breachedLimit ??= "output";
    reasons.push(`${kind} output token limit reached`);
  }

  const costLimit = kind === "soft" ? limits.softCostUsd : limits.hardCostUsd;
  if (costLimit !== undefined && state.usedCostUsd >= costLimit) {
    breachedLimit ??= "cost";
    reasons.push(`${kind} cost limit reached`);
  }

  return { breachedLimit, reasons };
}
