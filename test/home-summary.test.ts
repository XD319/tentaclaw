import { describe, expect, it } from "vitest";

import { buildHomeSummary } from "../src/tui/view-models/home-summary.js";
import type { AgentApplicationService } from "../src/runtime/index.js";
import type {
  ApprovalRecord,
  CommitmentRecord,
  InboxItem,
  NextActionRecord,
  ScheduleRecord,
  ThreadRecord
} from "../src/types/index.js";

type HomeServiceStub = Pick<
  AgentApplicationService,
  "listCommitments" | "listInbox" | "listNextActions" | "listPendingApprovals" | "listSchedules" | "listThreads" | "showThread"
>;

describe("home summary", () => {
  it("prioritizes urgent workflow items and recent thread guidance", () => {
    process.env.USERNAME = "local-user";
    const summary = buildHomeSummary(createServiceStub(), { activeThreadId: "thread-a" });

    expect(summary.title).toBe("Today at a glance");
    expect(summary.agenda[0]).toContain("Routine due");
    expect(summary.actions.map((item) => item.label)).toEqual([
      "Review pending approval",
      "Triage inbox",
      "Check due routine"
    ]);
    expect(summary.recommendedThread?.label).toBe("Quarterly planning");
    expect(summary.assistantHint).toContain("review pending approval");
  });

  it("falls back to a new-task prompt when nothing is pending", () => {
    const summary = buildHomeSummary(createEmptyServiceStub());

    expect(summary.recommendedThread).toBeNull();
    expect(summary.actions).toEqual([
      {
        detail: "Start with a plain-language goal or ask for today's plan.",
        key: "start",
        label: "Start a new task"
      }
    ]);
    expect(summary.agenda[0]).toContain("No urgent items");
  });
});

function createServiceStub(): HomeServiceStub {
  const thread = createThread("thread-a", "Quarterly planning");
  return {
    listCommitments() {
      return [createCommitment("commitment-a", thread.threadId)];
    },
    listInbox() {
      return [createInbox("inbox-a", "Need review", thread.threadId)];
    },
    listNextActions() {
      return [createNextAction("next-a", thread.threadId)];
    },
    listPendingApprovals() {
      return [createApproval("approval-a")];
    },
    listSchedules() {
      return [createSchedule("schedule-a", "Morning review")];
    },
    listThreads() {
      return [thread];
    },
    showThread() {
      return {
        commitments: [createCommitment("commitment-a", thread.threadId)],
        inboxItems: [createInbox("inbox-a", "Need review", thread.threadId)],
        lineage: [],
        nextActions: [createNextAction("next-a", thread.threadId)],
        runs: [],
        scheduleRuns: [],
        state: {
          activeNextActions: [createNextAction("next-a", thread.threadId)],
          blockedReason: null,
          currentObjective: createCommitment("commitment-a", thread.threadId),
          nextAction: createNextAction("next-a", thread.threadId),
          openCommitments: [createCommitment("commitment-a", thread.threadId)],
          pendingDecision: null
        },
        thread
      };
    }
  };
}

function createEmptyServiceStub(): HomeServiceStub {
  return {
    listCommitments() {
      return [];
    },
    listInbox() {
      return [];
    },
    listNextActions() {
      return [];
    },
    listPendingApprovals() {
      return [];
    },
    listSchedules() {
      return [];
    },
    listThreads() {
      return [];
    },
    showThread() {
      return {
        commitments: [],
        inboxItems: [],
        lineage: [],
        nextActions: [],
        runs: [],
        scheduleRuns: [],
        state: {
          activeNextActions: [],
          blockedReason: null,
          currentObjective: null,
          nextAction: null,
          openCommitments: [],
          pendingDecision: null
        },
        thread: null
      };
    }
  };
}

function createThread(threadId: string, title: string): ThreadRecord {
  return {
    agentProfileId: "executor",
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    cwd: process.cwd(),
    metadata: {},
    ownerUserId: "local-user",
    providerName: "mock",
    status: "active",
    threadId,
    title,
    updatedAt: "2026-01-01T01:00:00.000Z"
  };
}

function createInbox(inboxId: string, title: string, threadId: string): InboxItem {
  return {
    actionHint: null,
    approvalId: null,
    bodyMd: null,
    category: "task_completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    dedupKey: null,
    doneAt: null,
    experienceId: null,
    inboxId,
    metadata: {},
    scheduleRunId: null,
    severity: "info",
    skillId: null,
    sourceTraceId: null,
    status: "pending",
    summary: title,
    taskId: null,
    threadId,
    title,
    updatedAt: "2026-01-01T01:00:00.000Z",
    userId: "local-user"
  };
}

function createCommitment(commitmentId: string, threadId: string): CommitmentRecord {
  return {
    blockedReason: null,
    commitmentId,
    completedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    dueAt: null,
    metadata: {},
    ownerUserId: "local-user",
    pendingDecision: null,
    source: "manual",
    sourceTraceId: null,
    status: "open",
    summary: "Wrap the planning task",
    taskId: null,
    threadId,
    title: "Wrap the planning task",
    updatedAt: "2026-01-01T01:00:00.000Z"
  };
}

function createNextAction(nextActionId: string, threadId: string): NextActionRecord {
  return {
    blockedReason: null,
    commitmentId: null,
    completedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    detail: null,
    dueAt: null,
    metadata: {},
    nextActionId,
    rank: 1,
    source: "manual",
    sourceTraceId: null,
    status: "pending",
    taskId: null,
    threadId,
    title: "Draft the plan outline",
    updatedAt: "2026-01-01T01:00:00.000Z"
  };
}

function createApproval(approvalId: string): ApprovalRecord {
  return {
    approvalId,
    decidedAt: null,
    errorCode: null,
    expiresAt: "2026-01-01T02:00:00.000Z",
    policyDecisionId: "policy-1",
    reason: "Need permission",
    requestedAt: "2026-01-01T00:00:00.000Z",
    requesterUserId: "local-user",
    reviewerId: null,
    reviewerNotes: null,
    status: "pending",
    taskId: "task-1",
    toolCallId: "call-1",
    toolName: "file_write"
  };
}

function createSchedule(scheduleId: string, name: string): ScheduleRecord {
  return {
    agentProfileId: "executor",
    backoffBaseMs: 5_000,
    backoffMaxMs: 300_000,
    createdAt: "2026-01-01T00:00:00.000Z",
    cron: null,
    cwd: process.cwd(),
    input: "review inbox",
    intervalMs: 60_000,
    lastFireAt: null,
    maxAttempts: 3,
    metadata: {},
    name,
    nextFireAt: "2025-12-31T23:00:00.000Z",
    ownerUserId: "local-user",
    providerName: "mock",
    runAt: null,
    scheduleId,
    status: "active",
    threadId: null,
    timezone: null,
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}
