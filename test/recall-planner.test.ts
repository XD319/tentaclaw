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
    let recallRequest:
      | {
          taskId: string;
          query: string;
          projectScopeKey: string;
          profileScopeKey: string;
          limit: number;
        }
      | null = null;
    const planner = new RecallPlanner({
      budgetPolicy: new RecallBudgetPolicy({ budgetRatio: 0.05 }),
      enabled: true,
      experiencePlane: {
        recallExperiences: () => []
      } as never,
      maxCandidatesPerScope: 5,
      memoryPlane: {
        recall: (request) => {
          recallRequest = request;
          return {
          candidates: [
            {
              confidenceScore: 0.8,
              downrankReasons: [],
              explanation: "project memory match",
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
                retentionPolicy: { kind: "project", reason: "x", ttlDays: 30 },
                scope: "project",
                scopeKey: "/repo",
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
        };
        },
        recordRecall: () => undefined
      },
      sessionSearchService: {
        searchAsContext: () => [],
        searchGlobalAsContext: () => []
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
    expect(recallRequest).toEqual({
      limit: 5,
      profileScopeKey: "u1:executor",
      projectScopeKey: "/repo",
      query: result.explain.enrichedQuery,
      taskId: "task-1"
    });
  });

  it("triggers global session search only when historical signals are present", () => {
    let globalSearchCalls = 0;
    const planner = new RecallPlanner({
      budgetPolicy: new RecallBudgetPolicy({ budgetRatio: 0.05 }),
      enabled: true,
      experiencePlane: {
        recallExperiences: () => []
      } as never,
      maxCandidatesPerScope: 5,
      memoryPlane: {
        recall: () => ({
          candidates: [],
          decisions: [],
          query: "q",
          selectedFragments: []
        }),
        recordRecall: () => undefined
      },
      sessionSearchService: {
        searchAsContext: () => [],
        searchGlobalAsContext: () => {
          globalSearchCalls += 1;
          return [];
        }
      },
      skillContextService: {
        rankSkills: () => []
      } as never,
      traceService: {
        record: () => undefined
      } as never
    });

    const neutralTask = createTask();
    neutralTask.input = "fix flaky sqlite tests quickly";
    planner.plan({
      task: neutralTask,
      threadCommitmentState: null,
      tokenBudget: neutralTask.tokenBudget,
      toolPlan: ["shell"]
    });

    const historicalTask = createTask();
    historicalTask.input = "remember what we did last time for sqlite flakes";
    planner.plan({
      task: historicalTask,
      threadCommitmentState: null,
      tokenBudget: historicalTask.tokenBudget,
      toolPlan: ["shell"]
    });

    expect(globalSearchCalls).toBe(1);
  });

  it("reserves same-thread session memory before generic memories", () => {
    const planner = new RecallPlanner({
      budgetPolicy: new RecallBudgetPolicy({ budgetRatio: 0.03 }),
      enabled: true,
      experiencePlane: {
        recallExperiences: () => []
      } as never,
      maxCandidatesPerScope: 5,
      memoryPlane: {
        recall: () => ({
          candidates: [
            {
              confidenceScore: 0.95,
              downrankReasons: [],
              explanation: "generic profile memory",
              finalScore: 0.96,
              freshnessScore: 1,
              keywordScore: 0.9,
              memory: {
                confidence: 0.95,
                content: "x",
                conflictsWith: [],
                createdAt: "2026-04-23T09:00:00.000Z",
                expiresAt: null,
                keywords: ["sqlite"],
                lastVerifiedAt: null,
                memoryId: "mem-generic-1",
                metadata: {},
                privacyLevel: "internal",
                retentionPolicy: { kind: "project", reason: "x", ttlDays: 30 },
                scope: "project",
                scopeKey: "/repo",
                source: {
                  label: "task",
                  sourceType: "user_input",
                  taskId: "task-1",
                  toolCallId: null,
                  traceEventId: null
                },
                sourceType: "user_input",
                status: "verified",
                summary: "generic summary that would usually dominate candidate ranking",
                supersedes: null,
                title: "generic title",
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
      sessionSearchService: {
        searchAsContext: () => [
          {
            confidence: 0.62,
            explanation: "thread session hit",
            fragmentId: "thread-local-fragment",
            memoryId: "session:thread-local",
            privacyLevel: "internal",
            retentionPolicy: { kind: "working", reason: "thread recall", ttlDays: null },
            scope: "working",
            sourceType: "system",
            status: "verified",
            text: "Known decision from this thread",
            title: "Thread decisions"
          }
        ],
        searchGlobalAsContext: () => []
      },
      skillContextService: {
        rankSkills: () => []
      } as never,
      traceService: {
        record: () => undefined
      } as never
    });

    const result = planner.plan({
      task: createTask(),
      threadCommitmentState: null,
      tokenBudget: createTask().tokenBudget,
      toolPlan: ["shell"]
    });

    expect(result.fragments.some((fragment) => fragment.memoryId === "session:thread-local")).toBe(true);
    expect(result.explain.items.some((item) => item.reason.includes("reserved_thread_local"))).toBe(true);
  });
});
