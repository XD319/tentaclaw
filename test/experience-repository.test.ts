import { describe, expect, it } from "vitest";

import { experienceDraftSchema, type ExperienceDraft } from "../src/types/index.js";
import { StorageManager } from "../src/storage/database.js";

describe("experience repository", () => {
  it("validates experience drafts", () => {
    const parsed = experienceDraftSchema.parse(createExperienceDraft());

    expect(parsed.type).toBe("failure_lesson");
    expect(parsed.status).toBe("candidate");
    expect(parsed.keywordPhrases).toContain("sqlite migration");
  });

  it("persists and filters experience records", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });

    try {
      const lowValue = storage.experiences.create(
        createExperienceDraft({
          title: "Low value task note",
          valueScore: 0.2
        })
      );
      const highValue = storage.experiences.create(
        createExperienceDraft({
          provenance: {
            reviewerId: "reviewer-1",
            sourceLabel: "Review thread",
            taskId: "task-2",
            toolCallId: null,
            traceEventId: null
          },
          sourceType: "reviewer",
          status: "accepted",
          type: "review_feedback",
          valueScore: 0.91
        })
      );

      const results = storage.experiences.list({
        minValueScore: 0.8,
        reviewerId: "reviewer-1",
        sourceType: "reviewer",
        status: "accepted"
      });

      expect(results.map((experience) => experience.experienceId)).toEqual([
        highValue.experienceId
      ]);
      expect(results).not.toContain(lowValue);
    } finally {
      storage.close();
    }
  });

  it("updates review state without losing index signals", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });

    try {
      const created = storage.experiences.create(createExperienceDraft());
      const reviewedAt = new Date().toISOString();
      const updated = storage.experiences.update(created.experienceId, {
        metadata: {
          ...created.metadata,
          reviewNote: "Keep this lesson."
        },
        reviewedAt,
        status: "accepted",
        valueScore: 0.88
      });

      expect(updated.status).toBe("accepted");
      expect(updated.reviewedAt).toBe(reviewedAt);
      expect(updated.valueScore).toBe(0.88);
      expect(updated.indexSignals.errorCodes).toContain("SQLITE_BUSY");
      expect(updated.metadata.reviewNote).toBe("Keep this lesson.");
    } finally {
      storage.close();
    }
  });
});

function createExperienceDraft(overrides: Partial<ExperienceDraft> = {}): ExperienceDraft {
  const draft: ExperienceDraft = {
    confidence: 0.82,
    content: "SQLite migrations should add indexed columns for structured experience filters.",
    indexSignals: {
      errorCodes: ["SQLITE_BUSY"],
      paths: ["src/storage/migrations.ts"],
      phrases: ["sqlite migration"],
      reviewers: [],
      scopes: ["project:workspace-a"],
      sourceTypes: ["task"],
      statuses: ["candidate"],
      taskStatuses: ["failed"],
      tokens: ["sqlite", "migration", "experience"],
      types: ["failure_lesson"],
      valueScore: 0.73
    },
    keywordPhrases: ["sqlite migration"],
    keywords: ["sqlite", "migration", "experience"],
    metadata: {
      taskStatus: "failed"
    },
    promotionTarget: "project_memory",
    provenance: {
      reviewerId: null,
      sourceLabel: "Task failure",
      taskId: "task-1",
      toolCallId: null,
      traceEventId: null
    },
    scope: {
      paths: ["src/storage/migrations.ts"],
      scope: "project",
      scopeKey: "workspace-a"
    },
    sourceType: "task",
    status: "candidate",
    summary: "Migration failure lesson",
    title: "Add structured migration indexes",
    type: "failure_lesson",
    valueScore: 0.73
  };

  return {
    ...draft,
    ...overrides
  };
}
