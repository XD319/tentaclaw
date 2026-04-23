import { describe, expect, it } from "vitest";

import { RecallBudgetPolicy } from "../src/runtime/retrieval/recall-budget-policy.js";

describe("RecallBudgetPolicy", () => {
  it("computes recall token budget from token limits", () => {
    const policy = new RecallBudgetPolicy({ budgetRatio: 0.25 });
    const result = policy.computeBudget({
      inputLimit: 10_000,
      outputLimit: 2_000,
      reservedOutput: 1_000,
      usedInput: 0,
      usedOutput: 0
    });

    expect(result.totalTokenBudget).toBe(2_250);
    expect(result.scopeWeights.working).toBe(1);
    expect(result.scopeWeights.skill_ref).toBeLessThan(result.scopeWeights.project);
  });
});
