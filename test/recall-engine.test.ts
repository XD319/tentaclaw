import { describe, expect, it } from "vitest";

import { RecallEngine, tokenize } from "../src/recall/recall-engine.js";
import type { ExperienceRecord } from "../src/types/index.js";

describe("RecallEngine", () => {
  it("keeps MemoryPlane-compatible token overlap behavior", () => {
    expect(tokenize("Run vitest for src/runtime/index.ts")).toContain("src/runtime/index.ts");
  });

  it("ranks experience records by keywords, phrases, structured signals, and quality", () => {
    const engine = new RecallEngine();
    const accepted = createExperience({
      keywordPhrases: ["sqlite migration"],
      keywords: ["sqlite", "migration", "SQLITE_BUSY"],
      status: "accepted",
      valueScore: 0.9
    });
    const lowValue = createExperience({
      experienceId: "low-value",
      keywordPhrases: ["sqlite migration"],
      keywords: ["sqlite", "migration"],
      status: "candidate",
      valueScore: 0.2
    });
    const stale = createExperience({
      experienceId: "stale",
      keywordPhrases: ["sqlite migration"],
      keywords: ["sqlite", "migration"],
      status: "stale",
      valueScore: 0.9
    });
    const rejected = createExperience({
      experienceId: "rejected",
      keywordPhrases: ["sqlite migration"],
      keywords: ["sqlite", "migration"],
      status: "rejected",
      valueScore: 0.9
    });

    const result = engine.rankExperiences([lowValue, rejected, stale, accepted], {
      limit: 4,
      query: "debug SQLITE_BUSY in sqlite migration for src/storage/migrations.ts"
    });

    expect(result[0]?.experience.experienceId).toBe("accepted");
    expect(result[0]?.phraseScore).toBeGreaterThan(0);
    expect(result[0]?.structuredScore).toBeGreaterThan(0);
    expect(result.find((candidate) => candidate.experience.experienceId === "low-value")?.downrankReasons).toContain("low_value");
    expect(result.find((candidate) => candidate.experience.experienceId === "stale")?.downrankReasons).toContain("stale_experience");
    expect(result.find((candidate) => candidate.experience.experienceId === "rejected")?.downrankReasons).toContain("rejected_experience");
  });

  it("applies structured filters before scoring", () => {
    const engine = new RecallEngine();
    const taskOutcome = createExperience({
      experienceId: "task-outcome",
      type: "task_outcome"
    });
    const reviewFeedback = createExperience({
      experienceId: "review-feedback",
      provenance: {
        reviewerId: "reviewer-1",
        sourceLabel: "Review",
        taskId: "task-2",
        toolCallId: null,
        traceEventId: null
      },
      sourceType: "reviewer",
      type: "review_feedback"
    });

    const result = engine.rankExperiences([taskOutcome, reviewFeedback], {
      filters: {
        reviewerId: "reviewer-1",
        sourceType: "reviewer",
        type: "review_feedback"
      },
      limit: 5,
      query: "sqlite migration review feedback"
    });

    expect(result.map((candidate) => candidate.experience.experienceId)).toEqual([
      "review-feedback"
    ]);
  });
});

function createExperience(overrides: Partial<ExperienceRecord> = {}): ExperienceRecord {
  const now = new Date().toISOString();
  const base: ExperienceRecord = {
    confidence: 0.85,
    content: "SQLite migration failed with SQLITE_BUSY in src/storage/migrations.ts.",
    createdAt: now,
    experienceId: "accepted",
    indexSignals: {
      errorCodes: ["SQLITE_BUSY"],
      paths: ["src/storage/migrations.ts"],
      phrases: ["sqlite migration"],
      reviewers: [],
      scopes: ["project:workspace-a"],
      sourceTypes: ["task"],
      statuses: ["accepted"],
      taskStatuses: ["failed"],
      tokens: ["sqlite", "migration", "SQLITE_BUSY"],
      types: ["failure_lesson"],
      valueScore: 0.9
    },
    keywordPhrases: ["sqlite migration"],
    keywords: ["sqlite", "migration"],
    metadata: {},
    promotedAt: null,
    promotedMemoryId: null,
    promotionTarget: "project_memory",
    provenance: {
      reviewerId: null,
      sourceLabel: "Task failure",
      taskId: "task-1",
      toolCallId: null,
      traceEventId: null
    },
    reviewedAt: null,
    scope: {
      paths: ["src/storage/migrations.ts"],
      scope: "project",
      scopeKey: "workspace-a"
    },
    sourceType: "task",
    status: "accepted",
    summary: "SQLite migration failure lesson",
    title: "SQLite migration lesson",
    type: "failure_lesson",
    updatedAt: now,
    valueScore: 0.9
  };

  const merged = {
    ...base,
    ...overrides
  };

  return {
    ...merged,
    indexSignals: {
      ...base.indexSignals,
      ...overrides.indexSignals,
      sourceTypes: [merged.sourceType],
      statuses: [merged.status],
      types: [merged.type],
      valueScore: merged.valueScore
    }
  };
}
