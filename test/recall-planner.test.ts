import { describe, expect, it } from "vitest";

import { RecallBudgetPolicy } from "../src/runtime/retrieval/recall-budget-policy.js";
import { RecallPlanner } from "../src/runtime/retrieval/recall-planner.js";
import type { TaskRecord, TraceEventDraft } from "../src/types/index.js";

function createTask(): TaskRecord {
  return {
    agentProfileId: "executor",
    createdAt: "2026-04-23T10:00:00.000Z",
    currentIteration: 1,
    cwd: "/repo",
    errorCode: null,
    errorMessage: null,
    finalOutput: null,
    finishedAt: null,
    input: "fix flaky sqlite tests",
    maxIterations: 10,
    metadata: {
      threadResume: {
        goal: "stabilize migration workflow"
      }
    },
    providerName: "mock",
    requesterUserId: "u1",
    startedAt: "2026-04-23T10:00:00.000Z",
    status: "running",
    taskId: "task-1",
    threadId: "thread-1",
    tokenBudget: {
      inputLimit: 8_000,
      outputLimit: 2_000,
      reservedOutput: 1_000,
      usedInput: 0,
      usedOutput: 0
    },
    updatedAt: "2026-04-23T10:00:00.000Z"
  };
}

describe("RecallPlanner", () => {
  it("builds explain payload with selected and skipped entries", () => {
    const records: string[] = [];
    const planner = new RecallPlanner({
      budgetPolicy: new RecallBudgetPolicy({ budgetRatio: 0.05 }),
      enabled: true,
      experiencePlane: {
        recallExperiences: () => []
      } as never,
      maxCandidatesPerScope: 5,
      memoryPlane: {
        recall: () => ({
          candidates: [
            {
              confidenceScore: 0.8,
              downrankReasons: [],
              explanation: "working memory match",
              finalScore: 0.85,
              freshnessScore: 1,
              keywordScore: 0.8,
              memory: {
                confidence: 0.9,
                content: "x",
                conflictsWith: [],
                createdAt: "2026-04-23T09:00:00.000Z",
                expiresAt: null,
                keywords: ["sqlite"],
                lastVerifiedAt: null,
                memoryId: "mem-1",
                metadata: {},
                privacyLevel: "internal",
                retentionPolicy: { kind: "working", reason: "x", ttlDays: null },
                scope: "working",
                scopeKey: "task-1",
                source: {
                  label: "task",
                  sourceType: "user_input",
                  taskId: "task-1",
                  toolCallId: null,
                  traceEventId: null
                },
                sourceType: "user_input",
                status: "verified",
                summary: "summary",
                supersedes: null,
                title: "title",
                updatedAt: "2026-04-23T09:00:00.000Z"
              }
            }
          ],
          decisions: [],
          query: "q",
          selectedFragments: []
        }),
        recordRecall: () => undefined
      },
      skillContextService: {
        rankSkills: () => []
      } as never,
      traceService: {
        record: (event: TraceEventDraft) => records.push(event.eventType)
      } as never
    });

    const result = planner.plan({
      task: createTask(),
      threadCommitmentState: null,
      tokenBudget: createTask().tokenBudget,
      toolPlan: ["shell", "test_run"]
    });

    expect(result.explain.candidateCount).toBe(1);
    expect(result.explain.items.length).toBe(1);
    expect(result.explain.enrichedQuery).toContain("stabilize migration workflow");
    expect(records).toContain("recall_explain");
  });
});
