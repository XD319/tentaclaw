import { describe, expect, it } from "vitest";

import { classifyBudgetState } from "../src/runtime/budget/budget-policy.js";

describe("budget policy", () => {
  it("classifies within", () => {
    const result = classifyBudgetState(
      { usedCostUsd: 0.1, usedInput: 100, usedOutput: 100 },
      { softCostUsd: 1, hardCostUsd: 2 }
    );
    expect(result.status).toBe("within");
  });

  it("classifies soft", () => {
    const result = classifyBudgetState(
      { usedCostUsd: 1.1, usedInput: 100, usedOutput: 100 },
      { softCostUsd: 1, hardCostUsd: 2 }
    );
    expect(result.status).toBe("soft");
    expect(result.action).toBe("soft_downgrade");
  });

  it("classifies hard", () => {
    const result = classifyBudgetState(
      { usedCostUsd: 2.1, usedInput: 100, usedOutput: 100 },
      { softCostUsd: 1, hardCostUsd: 2 }
    );
    expect(result.status).toBe("hard");
    expect(result.action).toBe("hard_abort");
  });
});
