import { describe, expect, it } from "vitest";

import { MemorySelector, type ScoredRecallCandidate } from "../src/runtime/retrieval/memory-selector.js";
import type { ContextFragment } from "../src/types/index.js";

function createCandidate(input: {
  id: string;
  scope: ScoredRecallCandidate["scope"];
  score: number;
  tokenEstimate: number;
}): ScoredRecallCandidate {
  const fragment: ContextFragment = {
    confidence: input.score,
    explanation: "test",
    fragmentId: `frag-${input.id}`,
    memoryId: input.id,
    privacyLevel: "internal",
    retentionPolicy: {
      kind: "project",
      reason: "test",
      ttlDays: null
    },
    scope: input.scope,
    sourceType: "system",
    status: "verified",
    text: `fragment ${input.id}`,
    title: input.id
  };
  return {
    fragment,
    id: input.id,
    reason: "test",
    score: input.score,
    scope: input.scope,
    tokenEstimate: input.tokenEstimate
  };
}

describe("MemorySelector", () => {
  it("prioritizes higher weighted score under tight budget", () => {
    const selector = new MemorySelector();
    const result = selector.select(
      [
        createCandidate({ id: "A", scope: "working", score: 0.8, tokenEstimate: 100 }),
        createCandidate({ id: "B", scope: "skill_ref", score: 0.9, tokenEstimate: 100 }),
        createCandidate({ id: "C", scope: "project", score: 0.7, tokenEstimate: 100 })
      ],
      {
        scopeWeights: {
          experience_ref: 0.75,
          profile: 0.9,
          project: 0.95,
          skill_ref: 0.65,
          working: 1
        },
        tokenBudget: 200
      }
    );

    expect(result.selected.map((item) => item.id)).toEqual(["A", "C"]);
    expect(result.skipped.map((item) => item.id)).toEqual(["B"]);
  });
});
