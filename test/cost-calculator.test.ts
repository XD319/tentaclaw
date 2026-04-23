import { describe, expect, it } from "vitest";

import { computeCostUsd } from "../src/runtime/budget/cost-calculator.js";

describe("cost calculator", () => {
  it("computes input/output/cached cost", () => {
    const cost = computeCostUsd(
      {
        cachedInputTokens: 1_000,
        inputTokens: 2_000,
        outputTokens: 3_000
      },
      {
        cachedInputPerMillion: 0.05,
        inputPerMillion: 1,
        outputPerMillion: 2
      }
    );
    expect(cost).toBeCloseTo(0.00805, 6);
  });

  it("returns null when pricing missing", () => {
    expect(computeCostUsd({ inputTokens: 1, outputTokens: 1 }, null)).toBeNull();
  });
});
