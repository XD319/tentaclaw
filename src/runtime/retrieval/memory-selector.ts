import type { ContextFragment, MemoryScope } from "../../types/index.js";

export interface ScoredRecallCandidate {
  id: string;
  scope: MemoryScope;
  score: number;
  tokenEstimate: number;
  reason: string;
  fragment: ContextFragment;
}

export interface AnnotatedRecallItem {
  id: string;
  scope: MemoryScope;
  score: number;
  tokenEstimate: number;
  reason: string;
  selected: boolean;
}

export interface RecallSelection {
  selected: AnnotatedRecallItem[];
  skipped: AnnotatedRecallItem[];
  selectedFragments: ContextFragment[];
  tokenUsed: number;
}

export class MemorySelector {
  public select(
    candidates: ScoredRecallCandidate[],
    input: {
      tokenBudget: number;
      scopeWeights: Record<MemoryScope, number>;
    }
  ): RecallSelection {
    const sorted = [...candidates].sort(
      (left, right) =>
        weightedScore(right, input.scopeWeights) - weightedScore(left, input.scopeWeights) ||
        right.score - left.score ||
        left.id.localeCompare(right.id)
    );

    const selected: AnnotatedRecallItem[] = [];
    const skipped: AnnotatedRecallItem[] = [];
    const selectedFragments: ContextFragment[] = [];
    let tokenUsed = 0;

    for (const candidate of sorted) {
      const nextUsed = tokenUsed + Math.max(1, candidate.tokenEstimate);
      if (nextUsed <= input.tokenBudget) {
        tokenUsed = nextUsed;
        selected.push({
          id: candidate.id,
          reason: candidate.reason,
          scope: candidate.scope,
          score: candidate.score,
          selected: true,
          tokenEstimate: candidate.tokenEstimate
        });
        selectedFragments.push(candidate.fragment);
      } else {
        skipped.push({
          id: candidate.id,
          reason: `${candidate.reason}; skipped_by_budget`,
          scope: candidate.scope,
          score: candidate.score,
          selected: false,
          tokenEstimate: candidate.tokenEstimate
        });
      }
    }

    return {
      selected,
      selectedFragments,
      skipped,
      tokenUsed
    };
  }
}

function weightedScore(
  candidate: Pick<ScoredRecallCandidate, "scope" | "score">,
  scopeWeights: Record<MemoryScope, number>
): number {
  return candidate.score * scopeWeights[candidate.scope];
}
