import { describe, expect, it } from "vitest";

import { ExperiencePlane } from "../src/experience/experience-plane.js";
import {
  formatExperienceDetail,
  formatExperienceList,
  formatExperienceSearch
} from "../src/cli/formatters.js";
import { MemoryPlane } from "../src/memory/memory-plane.js";
import { ContextPolicy } from "../src/policy/context-policy.js";
import { StorageManager } from "../src/storage/database.js";
import { TraceService } from "../src/tracing/trace-service.js";
import type { ExperienceDraft, TaskRecord } from "../src/types/index.js";

describe("ExperiencePlane", () => {
  it("captures, reviews, searches, and promotes accepted experience", () => {
    const harness = createHarness();

    try {
      const captured = harness.experiencePlane.capture(createExperienceDraft());
      const reviewed = harness.experiencePlane.review({
        experienceId: captured.experienceId,
        note: "Reusable enough for project memory.",
        reviewerId: "reviewer-1",
        status: "accepted"
      });
      const search = harness.experiencePlane.search("sqlite migration SQLITE_BUSY", {
        status: "accepted"
      });
      const promoted = harness.experiencePlane.promote({
        experienceId: reviewed.experienceId,
        note: "Promote to project guidance.",
        reviewerId: "reviewer-1",
        target: "project_memory",
        task: createTask()
      });

      expect(search[0]?.experience.experienceId).toBe(captured.experienceId);
      expect(formatExperienceList([reviewed])).toContain("failure_lesson");
      expect(formatExperienceDetail(reviewed)).toContain("Provenance:");
      expect(formatExperienceSearch(search)).toContain("structured=");
      expect(promoted.experience.status).toBe("promoted");
      expect(promoted.memory?.source.sourceType).toBe("manual_review");
      expect(harness.storage.memories.list({ scope: "project", scopeKey: "workspace-a" })).toHaveLength(1);
      expect(harness.storage.traces.listByTaskId("task-1").map((event) => event.eventType)).toEqual(
        expect.arrayContaining([
          "experience_captured",
          "experience_reviewed",
          "experience_promoted"
        ])
      );
    } finally {
      harness.close();
    }
  });

  it("blocks promotion until experience is accepted", () => {
    const harness = createHarness();

    try {
      const captured = harness.experiencePlane.capture(createExperienceDraft());

      expect(() =>
        harness.experiencePlane.promote({
          experienceId: captured.experienceId,
          note: "Too early.",
          reviewerId: "reviewer-1",
          target: "agent_memory",
          task: createTask()
        })
      ).toThrow(/must be accepted/);
      expect(harness.storage.memories.list({ includeExpired: true })).toHaveLength(0);
    } finally {
      harness.close();
    }
  });

  it("records skill candidates as metadata without creating memory", () => {
    const harness = createHarness();

    try {
      const accepted = harness.experiencePlane.review({
        experienceId: harness.experiencePlane.capture(createExperienceDraft()).experienceId,
        note: "Could become a reusable skill.",
        reviewerId: "reviewer-1",
        status: "accepted"
      });

      const promoted = harness.experiencePlane.promote({
        experienceId: accepted.experienceId,
        note: "Track only as candidate metadata.",
        reviewerId: "reviewer-1",
        target: "skill_candidate"
      });

      expect(promoted.memory).toBeNull();
      expect(promoted.experience.metadata.skillCandidate).toMatchObject({
        sourceExperienceId: accepted.experienceId
      });
      expect(harness.storage.memories.list({ includeExpired: true })).toHaveLength(0);
    } finally {
      harness.close();
    }
  });
});

function createHarness() {
  const storage = new StorageManager({
    databasePath: ":memory:"
  });
  const traceService = new TraceService(storage.traces);
  const memoryPlane = new MemoryPlane({
    contextPolicy: new ContextPolicy(),
    memoryRepository: storage.memories,
    memorySnapshotRepository: storage.memorySnapshots,
    traceService
  });
  const experiencePlane = new ExperiencePlane({
    experienceRepository: storage.experiences,
    memoryPlane,
    traceService
  });

  return {
    close: () => storage.close(),
    experiencePlane,
    memoryPlane,
    storage
  };
}

function createExperienceDraft(): ExperienceDraft {
  return {
    confidence: 0.78,
    content: "SQLite migration failed with SQLITE_BUSY; add explicit indexes and retry safely.",
    indexSignals: {
      errorCodes: ["SQLITE_BUSY"],
      paths: ["src/storage/migrations.ts"],
      phrases: ["sqlite migration"],
      reviewers: [],
      scopes: ["project:workspace-a"],
      sourceTypes: ["task"],
      statuses: ["candidate"],
      taskStatuses: ["failed"],
      tokens: ["sqlite", "migration", "SQLITE_BUSY"],
      types: ["failure_lesson"],
      valueScore: 0.76
    },
    keywordPhrases: ["sqlite migration"],
    keywords: ["sqlite", "migration", "SQLITE_BUSY"],
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
    summary: "SQLite migration failure lesson",
    title: "SQLite migration lesson",
    type: "failure_lesson",
    valueScore: 0.76
  };
}

function createTask(): TaskRecord {
  const now = new Date().toISOString();
  return {
    agentProfileId: "executor",
    createdAt: now,
    currentIteration: 1,
    cwd: "workspace-a",
    errorCode: null,
    errorMessage: null,
    finalOutput: null,
    finishedAt: null,
    input: "fix sqlite migration",
    maxIterations: 8,
    metadata: {},
    providerName: "mock",
    requesterUserId: "local-user",
    startedAt: now,
    status: "running",
    taskId: "task-1",
    tokenBudget: {
      inputLimit: 8_000,
      outputLimit: 2_000,
      reservedOutput: 500,
      usedInput: 0,
      usedOutput: 0
    },
    updatedAt: now
  };
}
